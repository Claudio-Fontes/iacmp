import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import chalk from 'chalk';
import { AskFn } from './diff-renderer';
import { GeneratedFile } from '../parser/code-extractor';
import {
  safeJoin,
  assertValidStackName,
  assertValidProvider,
  errMessage,
} from './safe-path';
import { Language, DEFAULT_LANGUAGE } from '../i18n/languages';
import { MESSAGES } from '../i18n/messages';

function synthOutPaths(filePath: string, projectDir: string): string[] {
  const basename = path.basename(filePath).replace(/\.(ts|js)$/, '');
  const root = path.join(projectDir, 'synth-out');
  if (!fs.existsSync(root)) return [];

  const found: string[] = [];
  const check = (dir: string) => {
    for (const ext of ['.json', '.tf']) {
      const c = path.join(dir, `${basename}${ext}`);
      if (fs.existsSync(c) && fs.statSync(c).isFile()) found.push(c);
    }
  };

  check(root); // layout legado/flat
  // synth grava em synth-out/<provider>/ — varre os subdiretorios por provider
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) check(path.join(root, entry.name));
    }
  } catch {
    /* ignore */
  }
  return found;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Só reconcilia artefatos que a IA gera: stacks (stacks/**) e handlers (src/**),
// em .ts/.js. Barra de segurança extra sobre `previousPaths` — nunca remove
// config do projeto, .env, README etc. mesmo que apareçam por engano.
function isGeneratedArtifact(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  if (!norm.endsWith('.ts') && !norm.endsWith('.js')) return false;
  return norm.startsWith('stacks/') || norm.startsWith('src/');
}

/**
 * Reconcilia o conjunto de arquivos gerados pela IA entre tentativas de
 * auto-correção: remove do disco os artefatos que a IA escreveu numa tentativa
 * ANTERIOR (`previousPaths`) e que a nova geração (`currentFiles`) NÃO inclui mais.
 *
 * Motivação (bug p11 AWS): o loop "tentativa N/5" do `iacmp ai` re-gera as stacks
 * para corrigir o synth, mas `writeGeneratedFiles` só ESCREVE — nunca apaga. Sem
 * esta reconciliação, quando a correção junta bucket+lambda num arquivo novo, os
 * arquivos antigos (bucket-só, lambda-só) permanecem em stacks/; como o `iacmp
 * synth` carrega TODAS as .ts de stacks/, o ciclo cross-stack persiste e cada
 * retry PIORA o estado. Cada regeneração tem que ser uma SUBSTITUIÇÃO completa do
 * conjunto de stacks, não um incremento.
 *
 * Segurança: só remove caminhos presentes em `previousPaths` — arquivos que a
 * PRÓPRIA IA escreveu NESTA mesma execução — e restritos a artefatos gerados
 * (stacks/** ou src/** .ts/.js). NUNCA toca em arquivo feito à mão, config do
 * projeto, nem stack de outra origem/execução. Remove também o synth-out
 * correspondente a cada stack órfão, evitando que um `iacmp deploy` posterior
 * provisione a stack removida.
 *
 * Retorna os caminhos (relativos) efetivamente removidos.
 */
export function removeOrphanedGeneratedFiles(
  previousPaths: Iterable<string>,
  currentFiles: GeneratedFile[],
  projectDir: string
): string[] {
  const keep = new Set(currentFiles.map(f => f.path));
  const removed: string[] = [];
  for (const rel of previousPaths) {
    if (keep.has(rel)) continue;
    if (!isGeneratedArtifact(rel)) continue;
    let full: string;
    try {
      full = safeJoin(projectDir, rel);
    } catch {
      continue; // caminho suspeito (traversal) — nunca remove
    }
    try {
      if (!fs.existsSync(full)) continue;
      fs.rmSync(full, { force: true });
      removed.push(rel);
    } catch {
      continue; // falha ao remover não bloqueia a geração
    }
    // limpa o synth-out gerado a partir do stack órfão (json/tf)
    if (rel.replace(/\\/g, '/').startsWith('stacks/')) {
      for (const out of synthOutPaths(rel, projectDir)) {
        try { fs.rmSync(out, { force: true }); } catch { /* ignora */ }
      }
    }
  }
  return removed;
}

function removeReferences(stackName: string, projectDir: string): string[] {
  const modified: string[] = [];
  const stacksDir = path.join(projectDir, 'stacks');
  if (!fs.existsSync(stacksDir)) return modified;

  const escaped = escapeRegex(stackName);

  const findTs = (dir: string): string[] => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...findTs(full));
      else if (e.name.endsWith('.ts')) files.push(full);
    }
    return files;
  };

  for (const file of findTs(stacksDir)) {
    const content = fs.readFileSync(file, 'utf-8');
    const pattern = new RegExp(
      `(import[^;]*from\\s*['"][^'"]*${escaped}[^'"]*['"]\\s*;?\\n?)|(.*${escaped}.*)`,
      'g'
    );
    if (pattern.test(content)) {
      const cleaned = content.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
      if (cleaned !== content) {
        fs.writeFileSync(file, cleaned, 'utf-8');
        modified.push(path.relative(projectDir, file));
      }
    }
  }
  return modified;
}

function resolveCliEntrypoint(): string | null {
  try {
    return require.resolve('iacmp/bin/run.js');
  } catch {
    return null;
  }
}

export async function deleteFiles(
  deletions: string[],
  projectDir: string,
  iacProvider: string,
  ask: AskFn,
  options?: { providerAllowlist?: readonly string[] },
  lang: Language = DEFAULT_LANGUAGE
): Promise<void> {
  const t = MESSAGES[lang].fileDeleter;
  assertValidProvider(iacProvider, options?.providerAllowlist);

  // Monta lista completa: .ts + synth-out correspondente
  const stackFiles = deletions.filter(f => f.match(/\.(ts|js)$/) && f.includes('stacks/'));
  const otherFiles = deletions.filter(f => !stackFiles.includes(f));

  const seen = new Set<string>();
  const allToDelete: { rel: string; full: string }[] = [];
  const synthOuts: string[] = [];

  const add = (rel: string, full: string) => {
    if (!seen.has(full)) {
      seen.add(full);
      allToDelete.push({ rel, full });
    }
  };

  for (const filePath of stackFiles) {
    let full: string;
    try {
      full = safeJoin(projectDir, filePath);
    } catch (err) {
      console.log(chalk.yellow(t.ignoring(errMessage(err), filePath)));
      continue;
    }
    if (fs.existsSync(full)) add(filePath, full);

    for (const synthOut of synthOutPaths(filePath, projectDir)) {
      const rel = path.relative(projectDir, synthOut);
      add(rel, synthOut);
      if (!synthOuts.includes(rel)) synthOuts.push(rel);
    }
  }

  for (const filePath of otherFiles) {
    let full: string;
    try {
      full = safeJoin(projectDir, filePath);
    } catch (err) {
      console.log(chalk.yellow(t.ignoring(errMessage(err), filePath)));
      continue;
    }
    if (fs.existsSync(full)) add(filePath, full);
  }

  if (allToDelete.length === 0) {
    console.log(chalk.dim(t.noFilesFound));
    return;
  }

  console.log('');
  console.log(chalk.red.bold(t.filesToRemove));
  for (const f of allToDelete) {
    console.log(chalk.red(`  - ${f.rel}`));
  }
  console.log('');

  // Pergunta se quer rodar destroy antes de apagar
  if (synthOuts.length > 0) {
    const runDestroy = await ask(t.runDestroyPrompt);
    if (runDestroy.toLowerCase() === 'y') {
      const cliEntry = resolveCliEntrypoint();
      for (const synthOut of synthOuts) {
        const stackName = path.basename(synthOut).replace(/\.(json|tf)$/, '');
        try {
          assertValidStackName(stackName);
        } catch (err) {
          console.log(chalk.yellow(t.destroySkipped(errMessage(err), stackName)));
          continue;
        }
        console.log(chalk.dim(t.runningDestroy(stackName)));
        try {
          if (cliEntry) {
            cp.execFileSync(
              process.execPath,
              [cliEntry, 'destroy', '--stack', stackName, '--provider', iacProvider, '--force'],
              { cwd: projectDir, stdio: 'inherit' }
            );
          } else {
            cp.execFileSync(
              'npx',
              ['iacmp', 'destroy', '--stack', stackName, '--provider', iacProvider, '--force'],
              { cwd: projectDir, stdio: 'inherit' }
            );
          }
        } catch {
          console.log(chalk.yellow(t.destroyFailed(stackName)));
        }
      }
    }
  }

  // Confirma remocao dos arquivos locais
  const confirm = await ask(t.confirmDeleteLocal);
  if (confirm.toLowerCase() !== 'y') {
    console.log(chalk.dim(t.deletionCancelled));
    return;
  }

  for (const { rel, full } of allToDelete) {
    try {
      fs.rmSync(full, { force: true });
      console.log(chalk.red(`  ✗ ${rel}`));
    } catch {
      console.log(chalk.yellow(t.couldNotRemove(rel)));
    }
  }

  // Remove referencias nos outros arquivos
  for (const filePath of stackFiles) {
    const stackName = path.basename(filePath).replace(/\.(ts|js)$/, '');
    const modified = removeReferences(stackName, projectDir);
    for (const f of modified) {
      console.log(chalk.yellow(t.referencesRemoved(f)));
    }
  }

  console.log('');
}
