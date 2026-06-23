import { execFileSync } from 'child_process';
import { DeployContext, DeployExecutor, DestroyContext, NativeCommand, StackStatus } from './types';

/** Resolve o projectId: usa o configurado no iacmp.json, senão cai para o default do gcloud. */
export function resolveProjectId(configuredProjectId?: string): string {
  if (configuredProjectId) return configuredProjectId;
  try {
    const out = execFileSync('gcloud', ['config', 'get-value', 'project'], { stdio: 'pipe' }).toString().trim();
    if (out && out !== '(unset)') return out;
  } catch {
    /* cai no erro abaixo */
  }
  throw new Error(
    'Nenhum projectId configurado. Defina "projectId" no iacmp.json ou rode: gcloud config set project <id>'
  );
}

/** Deployment Manager não é idempotente como os outros (create falha se já existir) — precisa checar antes. */
export function deploymentExists(name: string, projectId: string): boolean {
  try {
    execFileSync('gcloud', ['deployment-manager', 'deployments', 'describe', name, '--project', projectId], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export const gcpExecutor: DeployExecutor = {
  provider: 'gcp',
  requiredBinary: 'gcloud',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const projectId = resolveProjectId(ctx.projectId);
    // describe() é uma leitura — roda mesmo em --dry-run para mostrar a etapa real (create vs update).
    const action = deploymentExists(ctx.stackName, projectId) ? 'update' : 'create';
    return [{
      bin: 'gcloud',
      args: [
        'deployment-manager', 'deployments', action,
        ctx.stackName,
        '--config', ctx.templatePath,
        '--project', projectId,
      ],
    }];
  },

  async planDestroy(ctx: DestroyContext): Promise<NativeCommand[]> {
    const projectId = resolveProjectId(ctx.projectId);
    return [{
      bin: 'gcloud',
      args: ['deployment-manager', 'deployments', 'delete', ctx.stackName, '--project', projectId, '--quiet'],
    }];
  },

  describeStatus(stackName: string, ctx: { projectId?: string }): StackStatus {
    try {
      const projectId = resolveProjectId(ctx.projectId);
      return { deployed: deploymentExists(stackName, projectId) };
    } catch {
      return { deployed: false };
    }
  },
};
