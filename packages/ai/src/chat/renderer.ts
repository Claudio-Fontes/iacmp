import chalk from 'chalk';
import ora from 'ora';

let activeSpinner: ReturnType<typeof ora> | null = null;

export function printThinking(): ReturnType<typeof ora> {
  activeSpinner = ora({ text: 'Gerando stack...', color: 'cyan' }).start();
  return activeSpinner;
}

export function stopThinking(): void {
  if (activeSpinner) {
    activeSpinner.stop();
    activeSpinner = null;
  }
}

export function printExplanation(text: string): void {
  console.log('\n' + chalk.cyan.bold('─── Explicação ─────────────────────────────────'));
  console.log(chalk.white(text));
  console.log(chalk.cyan('─'.repeat(50)));
}

export function printWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  console.log('\n' + chalk.yellow.bold('Avisos:'));
  for (const w of warnings) {
    console.log(chalk.yellow(`  ! ${w}`));
  }
}

export function printNextSteps(steps: string[]): void {
  if (steps.length === 0) return;
  console.log('\n' + chalk.dim('Próximos passos:'));
  for (const s of steps) {
    console.log(chalk.dim(`  $ ${s}`));
  }
}

export function printStreamChunk(chunk: string): void {
  process.stdout.write(chunk);
}
