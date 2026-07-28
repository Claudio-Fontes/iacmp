import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { providerOutDir } from '../../synth-out';
import { DeployContext, DeployExecutor, DestroyContext, NativeCommand, StackStatus } from '../types';
import { resolveProjectId, ensureRequiredApis, ensureComputeServiceAccountRoles } from './preflight';
import { buildAndUploadFunctions } from './function-bundle';
import { buildAndPushContainers, patchContainerImages } from './containers';

// API pública do módulo — consumida por deploy/index.ts e testes.
export { resolveProjectId, ensureRequiredApis, ensureComputeServiceAccountRoles, REQUIRED_GCP_APIS } from './preflight';
export { renderGcpFunctionWrapper, renderGcpEventWrapper } from './wrappers';
export { hashFunctionBundle, versionedZipObject, patchFunctionZipObjects } from './function-bundle';

/**
 * Monta os `-var=NAME=value` do terraform apply/destroy, mas SÓ para as
 * variáveis que o synth realmente declarou em `_providers.tf.json`. O terraform
 * ERRA ("Value for undeclared variable") ao receber `-var` de uma variável que
 * o root module não declara — e `gcp_zone` só é emitida quando há construct
 * zonal (ver emitGCPProviders/needsZoneVar). project_id e gcp_region são sempre
 * declarados; gcp_zone é condicional. Ler o arquivo mantém deploy e synth em
 * contrato: passamos exatamente o conjunto de vars que o módulo aceita.
 */
function terraformVarArgs(dir: string, projectId: string, region: string): string[] {
  const values: Record<string, string> = {
    project_id: projectId,
    gcp_region: region,
    gcp_zone: `${region}-a`,
  };
  let declared: Record<string, unknown> = {};
  try {
    const providers = JSON.parse(fs.readFileSync(path.join(dir, '_providers.tf.json'), 'utf8'));
    declared = providers.variable ?? {};
  } catch {
    /* sem _providers.tf.json (synth não rodou / projeto vazio): não passa nenhum -var */
  }
  return Object.entries(values)
    .filter(([name]) => name in declared)
    .map(([name, value]) => `-var=${name}=${value}`);
}

/**
 * O Firestore `(default)` é um SINGLETON DO PROJETO: só existe um por projeto e
 * persiste entre deploys/destroys (o `terraform destroy` o remove do state, mas
 * o GCP mantém o database físico). Quando o synth declara
 * `google_firestore_database.iacmp_default` (Database.DynamoDB/DocumentDB) e o
 * database já existe na nuvem mas não está no tfstate local, o `apply` tenta
 * CRIAR → `409 Database already exists`. Este pré-flight importa o recurso pro
 * state antes do apply, tornando o deploy idempotente. Retorna o comando
 * `terraform import` a inserir entre init e apply, ou null quando não aplicável
 * (synth não usa Firestore / já está no state / não existe na nuvem ainda).
 */
function firestoreImportCommand(dir: string, projectId: string, region: string): NativeCommand | null {
  // 1. o synth declara o Firestore default? (só Database.DynamoDB/DocumentDB o emitem)
  try {
    const providers = JSON.parse(fs.readFileSync(path.join(dir, '_providers.tf.json'), 'utf8'));
    if (!providers.resource?.google_firestore_database?.iacmp_default) return null;
  } catch {
    return null;
  }

  // 2. já está no tfstate local? (importar de novo daria "already managed")
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'terraform.tfstate'), 'utf8'));
    const inState = (state.resources ?? []).some(
      (r: { type?: string; name?: string }) => r.type === 'google_firestore_database' && r.name === 'iacmp_default',
    );
    if (inState) return null;
  } catch {
    /* sem tfstate = primeiro deploy do projeto */
  }

  // 3. o database (default) já existe na nuvem? (senão o apply cria normalmente)
  try {
    execFileSync('gcloud', ['firestore', 'databases', 'describe', '--database=(default)', `--project=${projectId}`], { stdio: 'pipe' });
  } catch {
    return null;
  }

  // 4. existe na nuvem mas fora do state → importa (as -var são necessárias: a
  //    config do recurso referencia var.project_id/var.gcp_region).
  return {
    bin: 'terraform',
    args: [
      'import',
      ...terraformVarArgs(dir, projectId, region),
      'google_firestore_database.iacmp_default',
      `projects/${projectId}/databases/(default)`,
    ],
    cwd: dir,
  };
}

export const gcpExecutor: DeployExecutor = {
  provider: 'gcp',
  requiredBinary: 'terraform',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const projectId = resolveProjectId(ctx.projectId);
    const dir = providerOutDir(ctx.cwd, 'gcp');
    const region = ctx.region ?? 'us-central1';

    // Pré-flight (pulado em --dry-run — não mexem na nuvem). Ordem importa: ligar
    // as APIs primeiro dá tempo de propagarem enquanto os handlers buildam/sobem.
    if (!ctx.dryRun) {
      ensureRequiredApis(projectId);                 // APIs desligadas → SERVICE_DISABLED no apply
      ensureComputeServiceAccountRoles(projectId);   // compute SA sem roles → build gen2 falha
    }

    // Build+upload de handlers: efeito local (esbuild/zip) + efeito remoto
    // (gcloud storage cp) — pulado em --dry-run, igual ao container build do
    // Azure (ver DeployContext.dryRun).
    const uploadCmds = ctx.dryRun ? [] : buildAndUploadFunctions(ctx, projectId, region, dir);

    // Build+push de imagens de Compute.Container com props.build — gcloud builds
    // submit envia o contexto ao Cloud Build e pusha para gcr.io. Após o push,
    // patchContainerImages substitui o placeholder nos tf.json ANTES do apply.
    if (!ctx.dryRun) {
      const containerImages = buildAndPushContainers(ctx, projectId, dir);
      patchContainerImages(dir, containerImages);
    }

    // Import do Firestore (default) preexistente — precisa rodar DEPOIS do init
    // (usa o backend/config) e ANTES do apply (senão o apply erra 409). Pulado
    // em --dry-run e quando não aplicável.
    const importCmd = ctx.dryRun ? null : firestoreImportCommand(dir, projectId, region);

    return [
      ...uploadCmds,
      { bin: 'terraform', args: ['init', '-input=false'], cwd: dir },
      ...(importCmd ? [importCmd] : []),
      { bin: 'terraform', args: ['apply', '-auto-approve', ...terraformVarArgs(dir, projectId, region)], cwd: dir },
    ];
  },

  async planDestroy(ctx: DestroyContext): Promise<NativeCommand[]> {
    const projectId = resolveProjectId(ctx.projectId);
    const dir = providerOutDir(ctx.cwd, 'gcp');
    const region = ctx.region ?? 'us-central1';
    return [
      { bin: 'terraform', args: ['init', '-input=false'], cwd: dir },
      { bin: 'terraform', args: ['destroy', '-auto-approve', ...terraformVarArgs(dir, projectId, region)], cwd: dir },
    ];
  },

  describeStatus(_stackName: string, ctx: { cwd?: string }): StackStatus {
    // GCP: todas as stacks do projeto compartilham UM único tfstate no
    // providerOutDir (single Terraform root module — vários *.tf.json, um state).
    // "deployed" = o tfstate existe e tem ao menos um recurso. Sem isso o destroy
    // pulava TODAS as stacks ("não deployada") e nunca rodava `terraform destroy`.
    // Como o state é compartilhado, o primeiro `terraform destroy` já remove tudo;
    // nas stacks seguintes o state fica vazio → deployed=false → puladas.
    const dir = providerOutDir(ctx.cwd ?? process.cwd(), 'gcp');
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'terraform.tfstate'), 'utf8'));
      const resources = Array.isArray(state.resources) ? state.resources : [];
      const count = resources.reduce(
        (n: number, r: { instances?: unknown[] }) => n + (Array.isArray(r.instances) ? r.instances.length : 0),
        0,
      );
      return count > 0 ? { deployed: true } : { deployed: false };
    } catch {
      return { deployed: false };
    }
  },
};
