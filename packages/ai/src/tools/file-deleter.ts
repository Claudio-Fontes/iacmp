import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import chalk from 'chalk';
import { AskFn } from './diff-renderer';

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
  // synth grava em synth-out/<provider>/ — varre os subdiretórios por provider
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) check(path.join(root, entry.name));
    }
  } catch {
    /* ignore */
  }
  return found;
}

function removeReferences(stackName: string, projectDir: string): string[] {
  const modified: string[] = [];
  const stacksDir = path.join(projectDir, 'stacks');
  if (!fs.existsSync(stacksDir)) return modified;

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
      `(import[^;]*from\\s*['"][^'"]*${stackName}[^'"]*['"]\\s*;?\\n?)|(.*${stackName}.*)`,
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

export async function deleteFiles(
  deletions: string[],
  projectDir: string,
  iacProvider: string,
  ask: AskFn
): Promise<void> {
  // Monta lista completa: .ts + synth-out correspondente
  const stackFiles = deletions.filter(f => f.match(/\.(ts|js)$/) && f.includes('stacks/'));
  const otherFiles = deletions.filter(f => !stackFiles.includes(f));

  const seen = new Set<string>();
  const allToDelete: string[] = [];
  const synthOuts: string[] = [];

  const add = (f: string) => { if (!seen.has(f)) { seen.add(f); allToDelete.push(f); } };

  for (const filePath of stackFiles) {
    const full = path.join(projectDir, filePath);
    if (fs.existsSync(full)) add(filePath);
    for (const synthOut of synthOutPaths(filePath, projectDir)) {
      const rel = path.relative(projectDir, synthOut);
      add(rel);
      if (!synthOuts.includes(rel)) synthOuts.push(rel);
    }
  }

  for (const filePath of otherFiles) {
    const full = path.join(projectDir, filePath);
    if (fs.existsSync(full)) add(filePath);
  }

  if (allToDelete.length === 0) {
    console.log(chalk.dim('\n  Nenhum arquivo encontrado para remover.\n'));
    return;
  }

  console.log('');
  console.log(chalk.red.bold('  Arquivos que serão removidos:'));
  for (const f of allToDelete) {
    console.log(chalk.red(`  - ${f}`));
  }
  console.log('');

  // Pergunta se quer rodar destroy antes de apagar
  if (synthOuts.length > 0) {
    const runDestroy = await ask('Rodar `iacmp destroy` para remover os recursos na nuvem antes de apagar? [y/n] ');
    if (runDestroy.toLowerCase() === 'y') {
      for (const synthOut of synthOuts) {
        const stackName = path.basename(synthOut).replace(/\.(json|tf)$/, '');
        console.log(chalk.dim(`\n  Rodando destroy para ${stackName}...`));
        try {
          cp.execSync(`iacmp destroy --stack ${stackName} --provider ${iacProvider} --force`, {
            cwd: projectDir,
            stdio: 'inherit',
          });
        } catch {
          console.log(chalk.yellow(`  ! destroy falhou para ${stackName} — continuando com remoção local`));
        }
      }
    }
  }

  // Confirma remoção dos arquivos locais
  const confirm = await ask('\nApagar arquivos locais? [y/n] ');
  if (confirm.toLowerCase() !== 'y') {
    console.log(chalk.dim('  Remoção cancelada.\n'));
    return;
  }

  for (const filePath of allToDelete) {
    const full = path.join(projectDir, filePath);
    try {
      fs.rmSync(full, { force: true });
      console.log(chalk.red(`  ✗ ${filePath}`));
    } catch {
      console.log(chalk.yellow(`  ! Não foi possível remover: ${filePath}`));
    }
  }

  // Remove referências nos outros arquivos
  for (const filePath of stackFiles) {
    const stackName = path.basename(filePath).replace(/\.(ts|js)$/, '');
    const modified = removeReferences(stackName, projectDir);
    for (const f of modified) {
      console.log(chalk.yellow(`  ~ referências removidas em: ${f}`));
    }
  }

  console.log('');
}
