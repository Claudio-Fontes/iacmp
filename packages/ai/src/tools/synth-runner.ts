import { execSync } from 'child_process';
import chalk from 'chalk';

export function runSynth(projectDir: string, provider: string): boolean {
  try {
    execSync(`node "${require.resolve('iacmp/bin/run.js')}" synth --provider ${provider}`, {
      cwd: projectDir,
      stdio: 'inherit',
    });
    return true;
  } catch {
    // Tenta via npx como fallback
    try {
      execSync(`npx iacmp synth --provider ${provider}`, {
        cwd: projectDir,
        stdio: 'inherit',
      });
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
}
