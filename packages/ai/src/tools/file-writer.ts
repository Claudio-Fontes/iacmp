import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { GeneratedFile } from '../parser/code-extractor';
import { renderAndConfirm, FileDiff, AskFn } from './diff-renderer';
import { safeJoin } from './safe-path';
import { Language, DEFAULT_LANGUAGE } from '../i18n/languages';
import { MESSAGES } from '../i18n/messages';

// Retorna os caminhos (relativos) efetivamente escritos em disco — vazio em
// dry-run ou quando o usuário cancela. O chamador usa isso para rastrear o que a
// IA gerou entre tentativas de auto-correção e reconciliar órfãos (ver
// removeOrphanedGeneratedFiles).
export async function writeGeneratedFiles(
  files: GeneratedFile[],
  projectDir: string,
  dryRun: boolean,
  ask: AskFn,
  lang: Language = DEFAULT_LANGUAGE
): Promise<string[]> {
  const t = MESSAGES[lang].fileWriter;
  const validated: { file: GeneratedFile; fullPath: string }[] = [];
  for (const file of files) {
    const fullPath = safeJoin(projectDir, file.path);
    validated.push({ file, fullPath });
  }

  if (dryRun) {
    console.log(chalk.dim(t.dryRunHeader));
    for (const { file } of validated) {
      console.log(chalk.cyan(`  ${file.path}`));
      console.log(chalk.dim('─'.repeat(62)));
      for (const line of file.content.split('\n')) {
        console.log(chalk.green(`+ ${line}`));
      }
      console.log(chalk.dim('─'.repeat(62)));
      console.log('');
    }
    console.log(chalk.dim(t.dryRunFooter));
    return [];
  }

  const diffs: FileDiff[] = validated.map(({ file, fullPath }) => {
    let oldContent: string | null = null;
    try {
      oldContent = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      // arquivo nao existe — sera novo
    }
    return { path: file.path, oldContent, newContent: file.content };
  });

  const confirmed = await renderAndConfirm(diffs, ask, lang);

  if (!confirmed) {
    console.log(chalk.dim(t.operationCancelled));
    return [];
  }

  const isNewByPath = new Map(diffs.map(d => [d.path, d.oldContent === null]));

  const written: string[] = [];
  for (const { file, fullPath } of validated) {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content, 'utf-8');
    written.push(file.path);
    const isNew = isNewByPath.get(file.path);
    const color = isNew ? chalk.green : chalk.hex('#FFA500');
    console.log(color(`  ✓ ${file.path}`));
  }
  console.log('');
  return written;
}
