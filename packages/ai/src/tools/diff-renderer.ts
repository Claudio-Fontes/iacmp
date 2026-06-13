import chalk from 'chalk';
import * as DiffLib from 'diff';

export interface FileDiff {
  path: string;
  oldContent: string | null;
  newContent: string;
}

export type AskFn = (question: string) => Promise<string>;

export async function renderAndConfirm(diffs: FileDiff[], ask: AskFn): Promise<boolean> {
  console.log('');

  for (const file of diffs) {
    const isNew = file.oldContent === null;
    const label = isNew
      ? `  ${chalk.bold(file.path)}  ${chalk.blue('[novo]')}`
      : `  ${chalk.bold(file.path)}  ${chalk.yellow('[modificado]')}`;

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
  if (modCount > 0) parts.push(`${modCount} modificado(s)`);
  if (newCount > 0) parts.push(`${newCount} novo(s)`);
  console.log(chalk.dim('\n  ' + parts.join(' · ') + '\n'));

  const answer = await ask('Aplicar mudanças? [y/n] ');
  return answer.toLowerCase() === 'y';
}
