// Loop de aprendizado — Modo 1 (local, client-side). Após um deploy inédito
// bem-sucedido, oferece gravar o padrão na base LOCAL do próprio cliente
// (~/.iacmp/knowledge.db, origin='local'). Fica só nele; nada é enviado.
//
// Desenhado forward-compatible com o Modo 2 (compartilhado/central):
//  - pipeline em etapas separadas: buildCandidate → generalize → persistir;
//  - candidato com título GENÉRICO (dos constructs, nunca do nome do projeto),
//    para já nascer sem dado da empresa;
//  - id determinístico por fingerprint (a central futura deduplica por ele);
//  - proveniência gravada (shareStatus:'private' hoje).
// Quando o Modo 2 chegar, o destino "persistir" ganha um irmão "compartilhar" e
// `generalize` passa a anonimizar de fato — sem tocar na captura.

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { addLocalExample, hasSimilarExample, fingerprintOf, defaultDbPath, type Provenance } from '@iacmp/knowledge';
import { IacmpConfig } from './utils';

const CANDIDATE_SCHEMA_VERSION = 1;

// Lê recursivamente os .ts de um diretório → { relPath: conteúdo }.
function readTsTree(root: string, baseLabel: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const rel = baseLabel + '/' + path.relative(root, full).split(path.sep).join('/');
        out[rel] = fs.readFileSync(full, 'utf-8');
      }
    }
  };
  walk(root);
  return out;
}

// Constructs instanciados nas stacks (`new Familia.Tipo(...)`). Usa o TIPO em
// minúsculas — consistente para a dedup (não precisa bater 1:1 com o vocabulário
// curado; a dedup principal é do cliente contra o próprio banco).
function extractConstructs(stacks: Record<string, string>): string[] {
  const found = new Set<string>();
  const re = /new\s+[A-Z]\w*\.([A-Z]\w*)\s*\(/g;
  for (const code of Object.values(stacks)) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) found.add(m[1].toLowerCase());
  }
  return [...found].sort();
}

export interface Candidate {
  provider: string;
  title: string;
  constructs: string[];
  tags: string[];
  stacks: Record<string, string>;
  handlers: Record<string, string>;
}

// Monta um candidato a partir dos arquivos-fonte do projeto. Título genérico
// (derivado dos constructs, nunca de config.name). Retorna null se não houver o
// que aprender.
export function buildCandidate(cwd: string, provider: string): Candidate | null {
  const stacks = readTsTree(path.join(cwd, 'stacks'), 'stacks');
  if (Object.keys(stacks).length === 0) return null;
  const handlers = readTsTree(path.join(cwd, 'src'), 'src');
  const constructs = extractConstructs(stacks);
  if (constructs.length === 0) return null;
  const title = `${provider.toUpperCase()} · ${constructs.slice(0, 4).join(' + ')}`;
  const tags = [provider, ...constructs];
  return { provider, title, constructs, tags, stacks, handlers };
}

// Slot de generalização. Modo 1 (base local privada) = no-op: guarda como está.
// Modo 2 (compartilhado) plugará aqui a anonimização (trocar nomes, esqueletizar
// handlers) antes de enviar à central.
export function generalize(c: Candidate, level: 'none' | 'share'): Candidate {
  if (level === 'none') return c;
  throw new Error('generalização para compartilhamento (Modo 2) ainda não implementada');
}

export interface LearnDeps {
  log: (msg: string) => void;
  confirm: (msg: string) => Promise<boolean>;
  isTTY: boolean;
  now: () => string; // ISO 8601
}

// Auto-aprendizado local pós-deploy. Sem opt-in, é no-op silencioso e barato.
// Nunca lança para o chamador (deploy já concluiu) — falha vira aviso.
export async function maybeLearn(
  cwd: string,
  provider: string,
  config: IacmpConfig,
  deps: LearnDeps,
): Promise<void> {
  if (config.knowledge?.autolearn !== 'local') return;

  let candidate: Candidate | null;
  try { candidate = buildCandidate(cwd, provider); } catch { return; }
  if (!candidate) return;

  const dbPath = defaultDbPath();
  try {
    // Padrão já conhecido (curado ou já aprendido) → nada a fazer.
    if (hasSimilarExample({ dbPath }, provider, candidate.constructs)) return;
  } catch { return; }

  const c = generalize(candidate, 'none');

  // Preview: o cliente vê EXATAMENTE o que entraria na base dele.
  deps.log('');
  deps.log(chalk.bold('Aprendizado local — padrão inédito neste deploy:'));
  deps.log(`  título:     ${c.title}`);
  deps.log(`  constructs: ${c.constructs.join(', ')}`);
  deps.log(`  arquivos:   ${Object.keys(c.stacks).length} stack(s), ${Object.keys(c.handlers).length} handler(s)`);
  deps.log(chalk.dim('  (fica só na SUA base local — nada é enviado)'));

  if (!deps.isTTY) {
    deps.log(chalk.dim('  stdin não interativo — pulei; rode num terminal para confirmar.'));
    return;
  }
  const ok = await deps.confirm('Adicionar este padrão à sua base LOCAL de conhecimento?');
  if (!ok) { deps.log(chalk.dim('  ok, não adicionado.')); return; }

  const fp = fingerprintOf(provider, c.constructs);
  const provenance: Provenance = {
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    capturedAt: deps.now(),
    fingerprint: fp,
    shareStatus: 'private',
  };
  try {
    addLocalExample({ dbPath }, {
      id: `local-${fp}`,
      title: c.title,
      provider,
      constructs: c.constructs,
      tags: c.tags,
      stacks: c.stacks,
      handlers: c.handlers,
      notes: [],
      validated: true,
    }, provenance);
    deps.log(chalk.green('  ✓ aprendido — sua base local reforça esse padrão nas próximas gerações.'));
  } catch (err) {
    deps.log(chalk.dim(`  não consegui gravar (${(err as Error).message}) — seguindo.`));
  }
}
