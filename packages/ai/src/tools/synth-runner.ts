import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { assertValidProvider, errMessage } from './safe-path';

export function runSynth(
  projectDir: string,
  provider: string,
  options?: { providerAllowlist?: readonly string[] }
): boolean {
  try {
    assertValidProvider(provider, options?.providerAllowlist);
  } catch (err) {
    console.error(chalk.red('\nProvider inválido para synth:'));
    console.error(chalk.red(errMessage(err)));
    return false;
  }

  let cliEntry: string | null = null;
  try {
    cliEntry = require.resolve('iacmp/bin/run.js');
  } catch {
    cliEntry = null;
  }

  try {
    if (cliEntry) {
      execFileSync(
        process.execPath,
        [cliEntry, 'synth', '--provider', provider],
        { cwd: projectDir, stdio: 'inherit' }
      );
    } else {
      execFileSync(
        'npx',
        ['iacmp', 'synth', '--provider', provider],
        { cwd: projectDir, stdio: 'inherit' }
      );
    }
    return true;
  } catch (err) {
    const error = err as { stderr?: Buffer; message?: string };
    console.error(chalk.red('\nErro ao executar iacmp synth:'));
    if (error.stderr) {
      console.error(chalk.red(error.stderr.toString()));
    }
    return false;
  }
}
