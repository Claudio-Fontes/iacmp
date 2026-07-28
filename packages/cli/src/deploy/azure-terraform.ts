import { execFileSync } from 'child_process';
import { providerOutDir } from '../synth-out';
import { DeployContext, DeployExecutor, DestroyContext, NativeCommand } from './types';

function rgExists(rg: string): boolean {
  try {
    execFileSync('az', ['group', 'show', '--name', rg, '--query', 'name', '-o', 'tsv'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function rgResourceId(subscriptionId: string, rg: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${rg}`;
}

function getSubscriptionId(): string {
  try {
    return execFileSync('az', ['account', 'show', '--query', 'id', '-o', 'tsv'], { stdio: 'pipe' }).toString().trim();
  } catch {
    return '';
  }
}

export const azureTerraformExecutor: DeployExecutor = {
  provider: 'azure-tf',
  requiredBinary: 'terraform',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const dir = providerOutDir(ctx.cwd, 'azure-tf');
    const rg = ctx.resourceGroup ?? 'iacmp-rg';
    const vars = [
      '-var', `resource_group=${rg}`,
      '-var', `location=${ctx.region ?? 'eastus2'}`,
    ];
    const cmds: NativeCommand[] = [
      { bin: 'terraform', args: ['init', '-input=false'], cwd: dir },
    ];
    // Se o RG já existe (criado antes fora do Terraform), importa para o state
    // para evitar "resource already exists" no apply.
    if (!ctx.dryRun && rgExists(rg)) {
      const subId = getSubscriptionId();
      if (subId) {
        cmds.push({
          bin: 'terraform',
          args: ['import', ...vars, 'azurerm_resource_group.main', rgResourceId(subId, rg)],
          cwd: dir,
          onError: () => { /* já importado num deploy anterior → ignora */ },
        });
      }
    }
    cmds.push({ bin: 'terraform', args: ['apply', '-auto-approve', ...vars], cwd: dir });
    return cmds;
  },

  async planDestroy(ctx: DestroyContext): Promise<NativeCommand[]> {
    const dir = providerOutDir(ctx.cwd, 'azure-tf');
    const vars = [
      '-var', `resource_group=${ctx.resourceGroup ?? 'iacmp-rg'}`,
      '-var', `location=${ctx.region ?? 'eastus2'}`,
    ];
    return [
      { bin: 'terraform', args: ['init', '-input=false'], cwd: dir },
      { bin: 'terraform', args: ['destroy', '-auto-approve', ...vars], cwd: dir },
    ];
  },
};
