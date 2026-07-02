import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { providerOutDir } from '../synth-out';
import { DeployContext, DeployExecutor, DestroyContext, NativeCommand, StackStatus } from './types';

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

function ensureGCPProviderBlock(dir: string, projectId: string, region: string): void {
  const providerPath = path.join(dir, '_provider.tf.json');
  const block = {
    variable: {
      project_id: { type: 'string', default: projectId },
      gcp_region: { type: 'string', default: region },
      gcp_zone: { type: 'string', default: `${region}-a` },
    },
  };
  fs.writeFileSync(providerPath, JSON.stringify(block, null, 2) + '\n', 'utf-8');
}

export const gcpExecutor: DeployExecutor = {
  provider: 'gcp',
  requiredBinary: 'terraform',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const projectId = resolveProjectId(ctx.projectId);
    const dir = providerOutDir(ctx.cwd, 'gcp');
    ensureGCPProviderBlock(dir, projectId, ctx.region ?? 'us-central1');
    return [
      { bin: 'terraform', args: ['init', '-input=false'], cwd: dir },
      {
        bin: 'terraform',
        args: [
          'apply', '-auto-approve',
          `-var=project_id=${projectId}`,
          `-var=gcp_region=${ctx.region ?? 'us-central1'}`,
        ],
        cwd: dir,
      },
    ];
  },

  async planDestroy(ctx: DestroyContext): Promise<NativeCommand[]> {
    const projectId = resolveProjectId(ctx.projectId);
    const dir = providerOutDir(ctx.cwd, 'gcp');
    return [
      { bin: 'terraform', args: ['init', '-input=false'], cwd: dir },
      {
        bin: 'terraform',
        args: [
          'destroy', '-auto-approve',
          `-var=project_id=${projectId}`,
          `-var=gcp_region=${ctx.region ?? 'us-central1'}`,
        ],
        cwd: dir,
      },
    ];
  },

  describeStatus(_stackName: string, _ctx: unknown): StackStatus {
    return { deployed: false };
  },
};
