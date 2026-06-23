import { execFileSync } from 'child_process';
import { runCli } from '../../cli/test/helpers';

export { runCli, makeProject, rmrf, read, exists, ls, CLI_BIN } from '../../cli/test/helpers';
export type { RunResult, TempProjectOptions } from '../../cli/test/helpers';

const REGION = 'us-east-1';

/**
 * `iacmp synth` + `iacmp deploy --provider aws` reais (sem --dry-run) — espera
 * CREATE_COMPLETE/UPDATE_COMPLETE de verdade (o comando `aws cloudformation
 * deploy` já é síncrono). Lança se o exit code não for 0 — chamador deve
 * SEMPRE destruir no finally mesmo se a asserção do teste falhar.
 */
export function deployReal(cwd: string): void {
  const synth = runCli(['synth', '--provider', 'aws'], { cwd });
  if (synth.status !== 0) {
    throw new Error(`iacmp synth falhou (exit ${synth.status}):\n${synth.all}`);
  }
  const deploy = runCli(['deploy', '--provider', 'aws'], { cwd });
  if (deploy.status !== 0) {
    throw new Error(`iacmp deploy falhou (exit ${deploy.status}):\n${deploy.all}`);
  }
}

/**
 * `iacmp destroy --provider aws --force` real — já faz delete-stack + wait
 * stack-delete-complete (síncrono). Não lança por padrão: é chamado em
 * finally/afterEach, e um destroy que falha não deve mascarar o erro original
 * do teste — só loga um aviso bem visível pro sweep.ts limpar depois.
 */
export function destroyReal(cwd: string): void {
  const destroy = runCli(['destroy', '--provider', 'aws', '--force'], { cwd });
  if (destroy.status !== 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[e2e-aws] AVISO: iacmp destroy falhou (exit ${destroy.status}) em ${cwd}.\n` +
      `Pode ter deixado recurso real cobrando na AWS — rode "npm run sweep" pra limpar.\n${destroy.all}`
    );
  }
}

/** `aws cloudformation describe-stacks` real — usado pra ler StackStatus/Outputs depois do deploy. */
export function describeStack(stackName: string): { StackStatus: string; Outputs: Array<{ OutputKey: string; OutputValue: string }> } {
  const raw = execFileSync('aws', [
    'cloudformation', 'describe-stacks',
    '--stack-name', stackName,
    '--region', REGION,
    '--output', 'json',
  ], { encoding: 'utf-8' });
  const parsed = JSON.parse(raw) as { Stacks: Array<{ StackStatus: string; Outputs?: Array<{ OutputKey: string; OutputValue: string }> }> };
  const s = parsed.Stacks[0];
  return { StackStatus: s.StackStatus, Outputs: s.Outputs ?? [] };
}

/** Lê um Output específico de uma stack já deployada, por OutputKey. */
export function readOutput(stackName: string, outputKey: string): string {
  const { Outputs } = describeStack(stackName);
  const found = Outputs.find(o => o.OutputKey === outputKey);
  if (!found) {
    throw new Error(`Output "${outputKey}" não encontrado na stack "${stackName}". Outputs disponíveis: ${Outputs.map(o => o.OutputKey).join(', ')}`);
  }
  return found.OutputValue;
}

export const E2E_PREFIX = 'iacmp-e2e';

/** Nome de stack convencional: iacmp-e2e-<categoria>-<n>. */
export function e2eStackName(category: string, n: number | string): string {
  return `${E2E_PREFIX}-${category}-${n}`;
}
