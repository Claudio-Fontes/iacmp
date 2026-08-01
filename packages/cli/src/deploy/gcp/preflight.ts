import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../../i18n';

/**
 * Pré-flight do deploy GCP: projeto resolvido, APIs habilitadas e roles da
 * default compute SA concedidas — tudo idempotente e best-effort, executado
 * ANTES do terraform apply (pulado em --dry-run pelo executor).
 */

export function resolveProjectId(configuredProjectId?: string): string {
  if (configuredProjectId) return configuredProjectId;
  try {
    const out = execFileSync('gcloud', ['config', 'get-value', 'project'], { stdio: 'pipe' }).toString().trim();
    if (out && out !== '(unset)') return out;
  } catch {
    /* cai no erro abaixo */
  }
  throw new Error(t(
    'Nenhum projectId configurado. Defina "projectId" no iacmp.json ou rode: gcloud config set project <id>',
    'No projectId configured. Set "projectId" in iacmp.json or run: gcloud config set project <id>',
  ));
}

/**
 * Roles que a default compute service account precisa para o deploy GCP
 * funcionar. Ela é a identidade tanto do BUILD (Cloud Build empacota a Function
 * gen2) quanto do RUNTIME (a função executa sob ela). Uma conta GCP nova cria a
 * compute SA SEM nenhuma role → o primeiro deploy falha no Cloud Build com erro
 * opaco ("missing permission on the build service account") e, mesmo buildando,
 * a função não acessaria os recursos (blob/table/pubsub/secret/sql...). Concedemos
 * o conjunto que cobre a bateria e2e (build + runtime dos cenários) antes do apply.
 */
const BASE_COMPUTE_SA_ROLES = [
  'roles/cloudbuild.builds.builder',    // build gen2 (Cloud Build)
  'roles/logging.logWriter',            // logs de build/runtime
  'roles/artifactregistry.writer',      // gen2 publica a imagem no Artifact Registry
] as const;

/**
 * Roles concedidas SOB DEMANDA — só quando o artefato que vai subir contém o
 * recurso correspondente. Antes o conjunto inteiro era concedido a todo projeto
 * (achado P1-01 da auditoria de 2026-07-31: "permissões excessivas na SA
 * padrão"): um projeto que só tinha uma function HTTP recebia acesso a Storage,
 * Pub/Sub, Secret Manager, Cloud SQL e Monitoring.
 */
const ROLE_BY_RESOURCE_PREFIX: Array<{ prefix: RegExp; role: string; why: string }> = [
  { prefix: /^google_storage_bucket/, role: 'roles/storage.objectAdmin', why: 'blob(): Cloud Storage' },
  { prefix: /^google_firestore_/, role: 'roles/datastore.user', why: 'table(): Firestore' },
  { prefix: /^google_pubsub_/, role: 'roles/pubsub.editor', why: 'Messaging / Events' },
  { prefix: /^google_secret_manager_/, role: 'roles/secretmanager.secretAccessor', why: 'Secret.Vault' },
  { prefix: /^google_sql_/, role: 'roles/cloudsql.client', why: 'Database.SQL' },
  { prefix: /^google_monitoring_/, role: 'roles/monitoring.editor', why: 'Monitoring.Alarm' },
  // event_trigger (Eventarc) invoca o Cloud Run gen2 usando a compute SA.
  { prefix: /^google_(cloudfunctions2_function|cloud_run_v2_service)$/, role: 'roles/run.invoker', why: 'invocação de Cloud Run/Functions' },
];

/**
 * Deriva o conjunto MÍNIMO de roles a partir dos recursos realmente presentes
 * nos artefatos `.tf.json` — em vez de conceder o superconjunto fixo. Sem
 * artefatos legíveis, devolve só as roles base de build (fail-safe: o apply
 * mostra o erro real se faltar alguma, e o usuário concede pontualmente).
 */
export function requiredComputeSaRoles(synthDir: string): { roles: string[]; reasons: Map<string, string> } {
  const roles = new Set<string>(BASE_COMPUTE_SA_ROLES);
  const reasons = new Map<string, string>();
  for (const r of BASE_COMPUTE_SA_ROLES) reasons.set(r, 'build/deploy (sempre necessário)');
  let files: string[] = [];
  try {
    files = fs.readdirSync(synthDir).filter(f => f.endsWith('.tf.json'));
  } catch {
    return { roles: [...roles], reasons };
  }
  for (const file of files) {
    let doc: { resource?: Record<string, unknown> };
    try {
      doc = JSON.parse(fs.readFileSync(path.join(synthDir, file), 'utf-8')) as { resource?: Record<string, unknown> };
    } catch {
      continue;
    }
    for (const resourceType of Object.keys(doc.resource ?? {})) {
      for (const { prefix, role, why } of ROLE_BY_RESOURCE_PREFIX) {
        if (prefix.test(resourceType)) {
          roles.add(role);
          if (!reasons.has(role)) reasons.set(role, why);
        }
      }
    }
  }
  return { roles: [...roles], reasons };
}

/**
 * APIs GCP que os construct types do iacmp podem exigir. Uma conta/projeto novo
 * traz a maioria DESABILITADA → o terraform falha no apply com `SERVICE_DISABLED`
 * (ex: API Gateway, Compute Engine para LB/CDN). Habilitamos as faltantes antes
 * do apply (idempotente). Conjunto amplo de propósito: habilitar uma API já
 * disponível é no-op, e o custo real vem do RECURSO criado, não da API ligada.
 */
export const REQUIRED_GCP_APIS = [
  'cloudfunctions.googleapis.com',      // Fn.Lambda (gen2)
  'run.googleapis.com',                 // gen2 roda sobre Cloud Run
  'cloudbuild.googleapis.com',          // build gen2 + gcloud builds submit (Compute.Container)
  'artifactregistry.googleapis.com',    // imagem do build gen2
  'containerregistry.googleapis.com',   // gcr.io push via gcloud builds submit
  'eventarc.googleapis.com',            // event triggers
  'pubsub.googleapis.com',              // Messaging / Events / fan-out
  'cloudscheduler.googleapis.com',      // Events.EventBridge (cron)
  'secretmanager.googleapis.com',       // Secret.Vault
  'firestore.googleapis.com',           // table() / Database.DocumentDB
  'monitoring.googleapis.com',          // Monitoring
  'apigateway.googleapis.com',          // Fn.ApiGateway
  'servicemanagement.googleapis.com',   // dependência do API Gateway
  'servicecontrol.googleapis.com',      // dependência do API Gateway
  'compute.googleapis.com',             // Network.LoadBalancer / CDN / VPC
  'vpcaccess.googleapis.com',           // VPC connector (Fn em VPC)
  'sqladmin.googleapis.com',            // Database.SQL
  'servicenetworking.googleapis.com',   // Database.SQL privado (private services access / VPC peering)
  'redis.googleapis.com',               // Cache.Redis
  'certificatemanager.googleapis.com',  // Certificate.TLS
  'iam.googleapis.com',                 // service accounts das Policy.IAM
] as const;

/**
 * Habilita as APIs de REQUIRED_GCP_APIS que ainda não estão ativas no projeto —
 * lê as habilitadas e liga só as faltantes num único `gcloud services enable`
 * (idempotente, best-effort). Roda ANTES do build/apply para ganhar tempo de
 * propagação. APIs recém-ligadas podem levar alguns minutos para propagar; se o
 * apply ainda pegar SERVICE_DISABLED, basta re-rodar o deploy.
 */
export function ensureRequiredApis(projectId: string): void {
  let enabled = new Set<string>();
  try {
    const out = execFileSync(
      'gcloud',
      ['services', 'list', '--enabled', `--project=${projectId}`, '--format=value(config.name)'],
      { stdio: 'pipe' },
    ).toString();
    enabled = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    /* não deu pra listar — segue e tenta habilitar tudo (enable é idempotente) */
  }

  const missing = REQUIRED_GCP_APIS.filter((a) => !enabled.has(a));
  if (missing.length === 0) return;

  process.stdout.write(t(`[iacmp] Habilitando ${missing.length} API(s) GCP necessária(s): ${missing.join(', ')}\n`, `[iacmp] Enabling ${missing.length} required GCP API(s): ${missing.join(', ')}\n`));
  try {
    execFileSync('gcloud', ['services', 'enable', ...missing, `--project=${projectId}`], { stdio: 'pipe' });
  } catch {
    process.stdout.write(t(
      `[iacmp] Falha ao habilitar algumas APIs (permissão?). Rode manualmente:\n` +
        `        gcloud services enable ${missing.join(' ')} --project=${projectId}\n`,
      `[iacmp] Failed to enable some APIs (permissions?). Run manually:\n` +
        `        gcloud services enable ${missing.join(' ')} --project=${projectId}\n`,
    ));
  }
}

/** Nome da default compute SA a partir do NÚMERO do projeto (não do id). */
function computeServiceAccount(projectNumber: string): string {
  return `${projectNumber}-compute@developer.gserviceaccount.com`;
}

/** Resolve o número do projeto GCP (a compute SA default usa `<número>-compute@…`). */
function resolveProjectNumber(projectId: string): string | null {
  try {
    const out = execFileSync('gcloud', ['projects', 'describe', projectId, '--format=value(projectNumber)'], { stdio: 'pipe' })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Garante que a default compute SA tenha as roles de REQUIRED_COMPUTE_SA_ROLES —
 * lê as atuais e concede só as que faltam (idempotente; add-iam-policy-binding
 * também é idempotente). Roda antes do apply. Best-effort: se não der pra ler a
 * policy ou conceder (permissão de IAM insuficiente), avisa com o comando manual
 * e segue — o apply mostra o erro real. Pulado em --dry-run pelo chamador.
 */
export function ensureComputeServiceAccountRoles(projectId: string, synthDir?: string): void {
  const projectNumber = resolveProjectNumber(projectId);
  if (!projectNumber) {
    process.stdout.write(t('[iacmp] Não consegui resolver o número do projeto GCP — pulei a checagem de roles da compute SA.\n', '[iacmp] Could not resolve the GCP project number — skipped the compute SA role check.\n'));
    return;
  }
  const member = `serviceAccount:${computeServiceAccount(projectNumber)}`;

  let current = new Set<string>();
  try {
    const out = execFileSync(
      'gcloud',
      [
        'projects', 'get-iam-policy', projectId,
        '--flatten=bindings[].members',
        `--filter=bindings.members:${member}`,
        '--format=value(bindings.role)',
      ],
      { stdio: 'pipe' },
    ).toString();
    current = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    /* não deu pra ler a policy — segue e tenta conceder tudo (add é idempotente) */
  }

  // Só as roles exigidas pelos recursos que vão subir (menor privilégio).
  const { roles: required, reasons } = synthDir
    ? requiredComputeSaRoles(synthDir)
    : { roles: [...BASE_COMPUTE_SA_ROLES] as string[], reasons: new Map<string, string>() };
  const missing = required.filter((r) => !current.has(r));
  if (missing.length === 0) return;

  // Plano explícito antes de mexer em IAM: o usuário vê o que será concedido e
  // por quê (auditoria P1-01 pedia "nunca alterar IAM sem exibir um plano").
  process.stdout.write(t(
    `[iacmp] IAM: concedendo ${missing.length} role(s) à service account de compute (mínimo para este projeto):\n`,
    `[iacmp] IAM: granting ${missing.length} role(s) to the compute service account (minimum for this project):\n`,
  ));
  for (const role of missing) {
    const why = reasons.get(role);
    process.stdout.write(`        · ${role}${why ? ` — ${why}` : ''}\n`);
  }
  for (const role of missing) {
    try {
      execFileSync(
        'gcloud',
        ['projects', 'add-iam-policy-binding', projectId, `--member=${member}`, `--role=${role}`, '--condition=None'],
        { stdio: 'pipe' },
      );
    } catch {
      process.stdout.write(t(
        `[iacmp] Falha ao conceder ${role} (permissão de IAM insuficiente?). Rode manualmente:\n` +
          `        gcloud projects add-iam-policy-binding ${projectId} --member=${member} --role=${role} --condition=None\n`,
        `[iacmp] Failed to grant ${role} (insufficient IAM permission?). Run manually:\n` +
          `        gcloud projects add-iam-policy-binding ${projectId} --member=${member} --role=${role} --condition=None\n`,
      ));
    }
  }
}
