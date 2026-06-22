import chalk from 'chalk';
import ora from 'ora';
import { Language, DEFAULT_LANGUAGE } from '../i18n/languages';
import { MESSAGES } from '../i18n/messages';

let activeSpinner: ReturnType<typeof ora> | null = null;

export function printThinking(lang: Language = DEFAULT_LANGUAGE): ReturnType<typeof ora> {
  activeSpinner = ora({ text: MESSAGES[lang].renderer.thinking, color: 'cyan' }).start();
  return activeSpinner;
}

export function stopThinking(): void {
  if (activeSpinner) {
    activeSpinner.stop();
    activeSpinner = null;
  }
}

export function printExplanation(text: string, lang: Language = DEFAULT_LANGUAGE): void {
  console.log('\n' + chalk.cyan.bold(MESSAGES[lang].renderer.explanationHeader));
  console.log(chalk.white(text));
  console.log(chalk.cyan('─'.repeat(50)));
}

export function printWarnings(warnings: string[], lang: Language = DEFAULT_LANGUAGE): void {
  if (warnings.length === 0) return;
  console.log('\n' + chalk.yellow.bold(MESSAGES[lang].renderer.warningsHeader));
  for (const w of warnings) {
    console.log(chalk.yellow(`  ! ${w}`));
  }
}

export function printNextSteps(steps: string[], lang: Language = DEFAULT_LANGUAGE): void {
  if (steps.length === 0) return;
  console.log('\n' + chalk.dim(MESSAGES[lang].renderer.nextStepsHeader));
  for (const s of steps) {
    console.log(chalk.dim(`  $ ${s}`));
  }
}

export function printStreamChunk(chunk: string): void {
  process.stdout.write(chunk);
}
