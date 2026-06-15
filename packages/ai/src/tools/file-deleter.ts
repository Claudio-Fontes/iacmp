import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { AskFn } from './diff-renderer';

// Para cada arquivo a remover, também apaga o artefato gerado correspondente
// ex: stacks/compute/foo-stack.ts → synth-out/foo-stack.json
function synthOutPath(filePath: string, projectDir: string): string | null {
  const basename = path.basename(filePath).replace(/\.(ts|js)$/, '');
  const candidates = [
    path.join(projectDir, 'synth-out', `${basename}.json`),
    path.join(projectDir, 'synth-out', `${basename}.tf`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Remove referências a um nome de stack em outros arquivos .ts do projeto
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
    // Procura por import ou referência ao nome da stack
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
  ask: AskFn
): Promise<void> {
  // Expande a lista: para cada .ts de stack, adiciona o synth-out correspondente
  const allToDelete: string[] = [];
  for (const filePath of deletions) {
    const full = path.join(projectDir, filePath);
    if (fs.existsSync(full)) allToDelete.push(filePath);
    const synthOut = synthOutPath(filePath, projectDir);
    if (synthOut) allToDelete.push(path.relative(projectDir, synthOut));
  }

  if (allToDelete.length === 0) {
    console.log(chalk.dim('  Nenhum arquivo encontrado para remover.\n'));
    return;
  }

  console.log('');
  console.log(chalk.red.bold('  Arquivos que serão removidos:'));
  for (const f of allToDelete) {
    console.log(chalk.red(`  - ${f}`));
  }
  console.log('');

  const answer = await ask('Confirmar remoção? [y/n] ');
  if (answer.toLowerCase() !== 'y') {
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
  for (const filePath of deletions) {
    const stackName = path.basename(filePath).replace(/\.(ts|js)$/, '');
    const modified = removeReferences(stackName, projectDir);
    for (const f of modified) {
      console.log(chalk.yellow(`  ~ referências removidas em: ${f}`));
    }
  }

  console.log('');
}
