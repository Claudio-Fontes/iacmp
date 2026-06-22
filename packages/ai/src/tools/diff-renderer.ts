import chalk from 'chalk';
import * as DiffLib from 'diff';
import { Language, DEFAULT_LANGUAGE } from '../i18n/languages';
import { MESSAGES } from '../i18n/messages';

export interface FileDiff {
  path: string;
  oldContent: string | null;
  newContent: string;
}

export type AskFn = (question: string) => Promise<string>;

export async function renderAndConfirm(
  diffs: FileDiff[],
  ask: AskFn,
  lang: Language = DEFAULT_LANGUAGE
): Promise<boolean> {
  const t = MESSAGES[lang].diff;
  console.log('');

  for (const file of diffs) {
    const isNew = file.oldContent === null;
    const label = isNew
      ? `  ${chalk.bold(file.path)}  ${chalk.blue(t.newLabel)}`
      : `  ${chalk.bold(file.path)}  ${chalk.yellow(t.modifiedLabel)}`;

    console.log('\n' + label);
    console.log(chalk.dim('─'.repeat(62)));

    if (isNew) {
      for (const line of file.newContent.split('\n')) {
        console.log(chalk.green(`+ ${line}`));
      }
    } else {
      const changes = DiffLib.diffLines(file.oldContent!, file.newContent);
      for (const change of changes) {
        const lines = change.value.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        for (const line of lines) {
          if (change.added) {
            console.log(chalk.green(`+ ${line}`));
          } else if (change.removed) {
            console.log(chalk.red(`- ${line}`));
          } else {
            console.log(`  ${line}`);
          }
        }
      }
    }

    console.log(chalk.dim('─'.repeat(62)));
  }

  const newCount = diffs.filter(d => d.oldContent === null).length;
  const modCount = diffs.filter(d => d.oldContent !== null).length;
  const parts: string[] = [];
  if (modCount > 0) parts.push(t.modifiedCount(modCount));
  if (newCount > 0) parts.push(t.newCount(newCount));
  console.log(chalk.dim('\n  ' + parts.join(' · ') + '\n'));

  const answer = await ask(t.applyPrompt);
  return answer.toLowerCase() === 'y';
}
