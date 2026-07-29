import { execFileSync } from 'child_process';
import { t } from '../../i18n';
import { StackStatus } from '../types';

/**
 * Leitura e espera sobre deployment stacks do Azure (az stack group) — a
 * unidade rastreável que o deploy cria e o destroy remove por completo.
 */

/** Lê outputs de uma deployment stack do Azure (pós-deploy). */
export function getAzureStackOutputs(stackName: string, resourceGroup: string): Record<string, string> {
  try {
    const raw = execFileSync('az', [
      'stack', 'group', 'show',
      '--name', stackName,
      '--resource-group', resourceGroup,
      '--query', 'outputs',
      '--output', 'json',
    ], { stdio: 'pipe' }).toString().trim();
    if (!raw || raw === 'null') return {};
    const outputs = JSON.parse(raw) as Record<string, { value: string }>;
    return Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v.value]));
  } catch {
    return {};
  }
}

/**
 * APIMs vivos no RG — capturar ANTES do destroy (depois só existe o soft-deleted).
 * O delete de APIM o move para soft-delete (48h): ocupa o NOME (re-deploy do
 * mesmo projeto colide) e segura o ARM por minutos após o RG esvaziar.
 */
export function listApimServices(resourceGroup: string): { name: string; location: string }[] {
  try {
    const raw = execFileSync('az', [
      'apim', 'list', '--resource-group', resourceGroup,
      '--query', '[].{name:name,location:location}', '--output', 'json',
    ], { stdio: 'pipe' }).toString().trim();
    return raw ? (JSON.parse(raw) as { name: string; location: string }[]) : [];
  } catch {
    return [];
  }
}

/**
 * Dispara a purga dos APIMs soft-deleted em processo DESTACADO (fire-and-forget):
 * `az apim deletedservice purge` não tem --no-wait e bloqueia minutos — não vale
 * segurar o destroy por isso. Se a purga falhar, o soft-delete expira em 48h.
 */
export function purgeApimSoftDeleted(services: { name: string; location: string }[]): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawn } = require('child_process') as typeof import('child_process');
  for (const s of services) {
    const child = spawn('az', [
      'apim', 'deletedservice', 'purge',
      '--service-name', s.name, '--location', s.location,
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  }
}

/** `az group exists` — leitura simples, sem efeito colateral. Usado antes do deploy para decidir se precisa criar o resource group. */
export function resourceGroupExists(resourceGroup: string): boolean {
  try {
    const out = execFileSync('az', ['group', 'exists', '--name', resourceGroup], { stdio: 'pipe' }).toString().trim();
    return out === 'true';
  } catch {
    return false;
  }
}

export function requireResourceGroup(ctx: { resourceGroup?: string }): string {
  if (!ctx.resourceGroup) {
    throw new Error(t('Configure "resourceGroup" no iacmp.json para usar --provider azure (ex: "resourceGroup": "meu-rg").', 'Set "resourceGroup" in iacmp.json to use --provider azure (e.g. "resourceGroup": "my-rg").'));
  }
  return ctx.resourceGroup;
}

export function describeStackStatus(stackName: string, resourceGroup: string): StackStatus {
  try {
    const status = execFileSync(
      'az',
      ['stack', 'group', 'show', '--name', stackName, '--resource-group', resourceGroup, '--query', 'provisioningState', '--output', 'tsv'],
      { stdio: 'pipe' }
    ).toString().trim();
    return { deployed: true, status };
  } catch {
    return { deployed: false };
  }
}

// Azure ARM retorna provisioningState em camelCase mas pode ser lowercase dependendo da versão
// da API ou do CLI. Incluímos ambas as formas para garantir.
const NON_TERMINAL_STATES = new Set([
  'Deploying', 'deploying',
  'DeletingResources', 'deletingResources', 'deleting', 'Deleting',
  'Canceling', 'canceling',
  'Validating', 'validating',
]);

/**
 * Bloqueia até que a deployment stack saia de um estado não-terminal.
 * Polling a cada 30s — timeout 30min (60 tentativas).
 * Usado como preRun no az stack group create para evitar DeploymentStackInNonTerminalState.
 */
export function waitForStackTerminal(stackName: string, resourceGroup: string): void {
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    const { deployed, status } = describeStackStatus(stackName, resourceGroup);
    if (!deployed) return;
    if (!status || !NON_TERMINAL_STATES.has(status)) return;
    process.stdout.write(t(`[iacmp] Stack "${stackName}" em estado "${status}" — aguardando... (${i + 1}/${maxAttempts})\n`, `[iacmp] Stack "${stackName}" in state "${status}" — waiting... (${i + 1}/${maxAttempts})\n`));
    // Espera síncrona: deployment stacks de Container App Environment levam 15-20min
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  }
  throw new Error(t(`Stack "${stackName}" continua em estado não-terminal após 30 minutos. Cancele o deploy no portal e tente novamente.`, `Stack "${stackName}" is still in a non-terminal state after 30 minutes. Cancel the deployment in the portal and try again.`));
}

/**
 * Recuperação de crash do az CLI 2.87.0 com "RuntimeError: content already consumed".
 * O CLI crasha localmente mas o deploy pode ter iniciado no ARM. Espera o stack
 * chegar a um estado terminal e valida se teve sucesso. Se sim, suprime o erro
 * original; se não, lança erro indicando falha real.
 */
export function recoverFromAzCliCrash(stackName: string, resourceGroup: string): void {
  const { deployed } = describeStackStatus(stackName, resourceGroup);
  if (!deployed) {
    // Stack não existe no ARM — falha real, não recuperável.
    throw new Error(t(
      `Stack "${stackName}" não pôde ser criada. Verifique o portal Azure para detalhes.`,
      `Stack "${stackName}" could not be created. Check the Azure portal for details.`,
    ));
  }
  // Stack existe e pode estar deploying — aguarda até estado terminal.
  process.stdout.write(t(`[iacmp] az CLI crashou localmente mas deploy iniciou no ARM. Aguardando stack "${stackName}"...\n`, `[iacmp] az CLI crashed locally but the deployment started in ARM. Waiting for stack "${stackName}"...\n`));
  waitForStackTerminal(stackName, resourceGroup);
  const { status } = describeStackStatus(stackName, resourceGroup);
  if (status && /fail/i.test(status)) {
    throw new Error(t(
      `Stack "${stackName}" falhou (status: ${status}). Verifique o portal Azure para detalhes do erro.`,
      `Stack "${stackName}" failed (status: ${status}). Check the Azure portal for error details.`,
    ));
  }
  process.stdout.write(t(`[iacmp] Stack "${stackName}" concluída com sucesso (recuperado de crash do az CLI).\n`, `[iacmp] Stack "${stackName}" completed successfully (recovered from az CLI crash).\n`));
}
