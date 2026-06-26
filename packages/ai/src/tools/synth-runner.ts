import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { assertValidProvider, errMessage } from './safe-path';

function resolveCliEntry(): string | null {
  try {
    return require.resolve('iacmp/bin/run.js');
  } catch {
    return null;
  }
}

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

  const cliEntry = resolveCliEntry();
  try {
    if (cliEntry) {
      execFileSync(process.execPath, [cliEntry, 'synth', '--provider', provider], { cwd: projectDir, stdio: 'inherit' });
    } else {
      execFileSync('npx', ['iacmp', 'synth', '--provider', provider], { cwd: projectDir, stdio: 'inherit' });
    }
    return true;
  } catch (err) {
    const error = err as { stderr?: Buffer; message?: string };
    console.error(chalk.red('\nErro ao executar iacmp synth:'));
    if (error.stderr) console.error(chalk.red(error.stderr.toString()));
    return false;
  }
}

export function runSynthCapture(
  projectDir: string,
  provider: string,
): { success: boolean; output: string } {
  const cliEntry = resolveCliEntry();
  try {
    if (cliEntry) {
      execFileSync(process.execPath, [cliEntry, 'synth', '--provider', provider], { cwd: projectDir, stdio: 'pipe' });
    } else {
      execFileSync('npx', ['iacmp', 'synth', '--provider', provider], { cwd: projectDir, stdio: 'pipe' });
    }
    return { success: true, output: '' };
  } catch (err) {
    const error = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
    const output = [
      error.stdout?.toString() ?? '',
      error.stderr?.toString() ?? '',
      error.message ?? '',
    ].filter(Boolean).join('\n');
    return { success: false, output };
  }
}
