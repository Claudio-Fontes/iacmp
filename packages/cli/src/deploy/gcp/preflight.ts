import { execFileSync } from 'child_process';

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
  throw new Error(
    'Nenhum projectId configurado. Defina "projectId" no iacmp.json ou rode: gcloud config set project <id>'
  );
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
const REQUIRED_COMPUTE_SA_ROLES = [
  'roles/cloudbuild.builds.builder',    // build gen2 (Cloud Build)
  'roles/logging.logWriter',            // logs de build/runtime
  'roles/artifactregistry.writer',      // gen2 publica a imagem no Artifact Registry
  'roles/storage.objectAdmin',          // blob(): Cloud Storage + bucket de artefatos
  'roles/datastore.user',               // table(): Firestore
  'roles/pubsub.editor',                // Messaging.Stream / Events / fan-out
  'roles/secretmanager.secretAccessor', // Secrets
  'roles/cloudsql.client',              // Database.SQL
  'roles/monitoring.editor',            // Monitoring
  'roles/run.invoker',                  // event_trigger Pub/Sub (Eventarc invoca o Cloud Run gen2)
] as const;

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

  process.stdout.write(`[iacmp] Habilitando ${missing.length} API(s) GCP necessária(s): ${missing.join(', ')}\n`);
  try {
    execFileSync('gcloud', ['services', 'enable', ...missing, `--project=${projectId}`], { stdio: 'pipe' });
  } catch {
    process.stdout.write(
      `[iacmp] Falha ao habilitar algumas APIs (permissão?). Rode manualmente:\n` +
        `        gcloud services enable ${missing.join(' ')} --project=${projectId}\n`,
    );
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
export function ensureComputeServiceAccountRoles(projectId: string): void {
  const projectNumber = resolveProjectNumber(projectId);
  if (!projectNumber) {
    process.stdout.write('[iacmp] Não consegui resolver o número do projeto GCP — pulei a checagem de roles da compute SA.\n');
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

  const missing = REQUIRED_COMPUTE_SA_ROLES.filter((r) => !current.has(r));
  if (missing.length === 0) return;

  process.stdout.write(`[iacmp] Compute SA sem ${missing.length} role(s) necessária(s) — concedendo: ${missing.join(', ')}\n`);
  for (const role of missing) {
    try {
      execFileSync(
        'gcloud',
        ['projects', 'add-iam-policy-binding', projectId, `--member=${member}`, `--role=${role}`, '--condition=None'],
        { stdio: 'pipe' },
      );
    } catch {
      process.stdout.write(
        `[iacmp] Falha ao conceder ${role} (permissão de IAM insuficiente?). Rode manualmente:\n` +
          `        gcloud projects add-iam-policy-binding ${projectId} --member=${member} --role=${role} --condition=None\n`,
      );
    }
  }
}
