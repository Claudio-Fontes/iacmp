import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { GeneratedFile } from '../parser/code-extractor';
import { renderAndConfirm, FileDiff } from './diff-renderer';

export async function writeGeneratedFiles(
  files: GeneratedFile[],
  projectDir: string,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    console.log(chalk.dim('\n[dry-run] Arquivos que seriam gerados:\n'));
    for (const file of files) {
      const fullPath = path.join(projectDir, file.path);
      console.log(chalk.cyan(`  ${file.path}`));
      console.log(chalk.dim('─'.repeat(62)));
      for (const line of file.content.split('\n')) {
        console.log(chalk.green(`+ ${line}`));
      }
      console.log(chalk.dim('─'.repeat(62)));
      console.log('');
    }
    console.log(chalk.dim('[dry-run] Nenhum arquivo foi salvo.\n'));
    return;
  }

  const diffs: FileDiff[] = files.map(file => {
    const fullPath = path.join(projectDir, file.path);
    let oldContent: string | null = null;
    try {
      oldContent = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      // arquivo não existe — é novo
    }
    return { path: file.path, oldContent, newContent: file.content };
  });

  const confirmed = await renderAndConfirm(diffs);

  if (!confirmed) {
    console.log(chalk.dim('\n  Operação cancelada. Nenhum arquivo foi alterado.\n'));
    return;
  }

  for (const file of files) {
    const fullPath = path.join(projectDir, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content, 'utf-8');
    console.log(chalk.green(`  ✓ ${file.path}`));
  }
  console.log('');
}
