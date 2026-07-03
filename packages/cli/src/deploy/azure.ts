import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { DeployContext, DeployExecutor, DestroyContext, NativeCommand, StackStatus } from './types';

/** Parâmetros Bicep sem valor default — precisam vir de stacks anteriores. */
function getCrossStackParams(templatePath: string): string[] {
  const content = fs.readFileSync(templatePath, 'utf-8');
  const params: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^param\s+(\w+)\s+\w+\s*$/);
    if (m) params.push(m[1]);
  }
  return params;
}

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

/** `az group exists` — leitura simples, sem efeito colateral. Usado antes do deploy para decidir se precisa criar o resource group. */
export function resourceGroupExists(resourceGroup: string): boolean {
  try {
    const out = execFileSync('az', ['group', 'exists', '--name', resourceGroup], { stdio: 'pipe' }).toString().trim();
    return out === 'true';
  } catch {
    return false;
  }
}

function requireResourceGroup(ctx: { resourceGroup?: string }): string {
  if (!ctx.resourceGroup) {
    throw new Error('Configure "resourceGroup" no iacmp.json para usar --provider azure (ex: "resourceGroup": "meu-rg").');
  }
  return ctx.resourceGroup;
}

export const azureExecutor: DeployExecutor = {
  provider: 'azure',
  requiredBinary: 'az',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const resourceGroup = requireResourceGroup(ctx);
    // Usa "deployment stacks" (az stack group) em vez de `az deployment group
    // create` — dá um objeto rastreável que o destroy consegue remover por
    // completo (todos os recursos que ele criou), igual ao stack do CloudFormation.
    // Flags conferidas contra a documentação do recurso (Azure CLI 2.49+);
    // revisar se a versão instalada do `az` divergir.
    const args = [
      'stack', 'group', 'create',
      '--name', ctx.stackName,
      '--resource-group', resourceGroup,
      '--template-file', ctx.templatePath,
      '--deny-settings-mode', 'none',
      '--action-on-unmanage', 'deleteResources',
      '--yes',
    ];
    // Parâmetros cross-stack: param Bicep sem default que coincide com output de stack anterior
    if (ctx.templatePath && ctx.outputParams) {
      const crossParams = getCrossStackParams(ctx.templatePath);
      const paramValues = crossParams
        .filter(p => ctx.outputParams![p] !== undefined)
        .map(p => `${p}=${ctx.outputParams![p]}`);
      if (paramValues.length > 0) {
        args.push('--parameters', ...paramValues);
      }
    }
    return [{ bin: 'az', args }];
  },

  async planDestroy(ctx: DestroyContext): Promise<NativeCommand[]> {
    const resourceGroup = requireResourceGroup(ctx);
    return [{
      bin: 'az',
      args: [
        'stack', 'group', 'delete',
        '--name', ctx.stackName,
        '--resource-group', resourceGroup,
        '--action-on-unmanage', 'deleteAll',
        '--yes',
      ],
    }];
  },

  describeStatus(stackName: string, ctx: { resourceGroup?: string }): StackStatus {
    if (!ctx.resourceGroup) return { deployed: false };
    return describeStackStatus(stackName, ctx.resourceGroup);
  },
};

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
