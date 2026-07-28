import { Stack, BaseConstruct } from '@iacmp/core';
import { TFOutput, gcpEntryPoint, gcpFunctionZipObject, toTfId, gcpName } from './constructs/common.js';
import { buildRegistry, resolveRefsDeep, type GCPRegistry } from './refs.js';
import { synthMonitoring } from './constructs/monitoring.js';
import { synthStorage } from './constructs/storage.js';
import { synthFunction } from './constructs/function.js';
import { synthMessaging } from './constructs/messaging.js';
import { synthCompute } from './constructs/compute.js';
import { synthDatabase } from './constructs/database.js';
import { synthNetwork } from './constructs/network.js';
import { synthWorkflow } from './constructs/workflow.js';

function synthesizeConstruct(construct: BaseConstruct, ctx: TFOutput, registry: GCPRegistry): void {
  // Resolve ref() nas props ANTES de despachar — nenhum synthX precisa saber
  // de Ref: ao chegar aqui, todo valor do usuário já é string/número/etc.
  const resolved: BaseConstruct = {
    id: construct.id,
    type: construct.type,
    props: resolveRefsDeep(construct.props, registry) as Record<string, unknown>,
  };

  if (synthMonitoring(resolved, ctx)) return;
  if (synthStorage(resolved, ctx)) return;
  if (synthFunction(resolved, ctx)) return;
  if (synthMessaging(resolved, ctx)) return;
  if (synthCompute(resolved, ctx)) return;
  if (synthDatabase(resolved, ctx)) return;
  if (synthNetwork(resolved, ctx)) return;
  if (synthWorkflow(resolved, ctx)) return;
  console.warn(`[gcp] Construct type '${construct.type}' nao suportado — descartado.`);
}

function newCtx(registry: GCPRegistry): TFOutput {
  return {
    resources: {},
    outputs: {},
    needsZoneVar: false,
    needsRandomProvider: false,
    needsGoogleBetaProvider: false,
    needsFirestoreDefault: false,
    firestoreDeletionProtection: false,
    privateNetworkVpcIds: new Set<string>(),
    registry,
  };
}

type SharedFlags = Pick<
  TFOutput,
  | 'needsZoneVar'
  | 'needsRandomProvider'
  | 'needsGoogleBetaProvider'
  | 'needsFirestoreDefault'
  | 'firestoreDeletionProtection'
  | 'privateNetworkVpcIds'
>;

/**
 * Une os flags (needsZoneVar/needsRandomProvider/needsGoogleBetaProvider/
 * needsFirestoreDefault/firestoreDeletionProtection) de TODAS as stacks do
 * projeto — o bloco `terraform{required_providers}` é UM só por diretório de
 * synth (ver emitGCPProviders), então precisa refletir o que QUALQUER stack
 * usa, não só a stack atual (ex: google-beta só é exigido pela stack que tem
 * Function.ApiGateway, mas o provider block é compartilhado; o mesmo vale
 * para o Firestore `(default)` — ver buildFirestoreDefaultResource abaixo —
 * que precisa existir uma vez só mesmo que Database.DynamoDB/DocumentDB
 * estejam espalhados em várias stacks).
 *
 * Roda a síntese completa (mesmo dispatch que emitGCPResources) num ctx
 * descartável — os flags dependem de props resolvidas e de `registry.refTargets`
 * (Database.SQL só precisa de `random` quando Username/Password é referenciado
 * por ALGUMA stack), não dá pra inferir só do `construct.type`. console.warn é
 * silenciado aqui: os mesmos avisos já aparecem na passada real de
 * emitGCPResources por stack — sem isso o usuário veria cada aviso 2x.
 */
function collectSharedFlags(allStacks: Stack[], registry: GCPRegistry): SharedFlags {
  const scratch = newCtx(registry);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    for (const s of allStacks) {
      for (const construct of s.constructs) {
        synthesizeConstruct(construct, scratch, registry);
      }
    }
  } finally {
    console.warn = originalWarn;
  }
  return scratch;
}

function buildProviderBlocks(flags: SharedFlags): {
  variables: Record<string, unknown>;
  requiredProviders: Record<string, unknown>;
  providerBlock: Record<string, unknown>;
} {
  const variables: Record<string, unknown> = {
    project_id: { type: 'string' },
    gcp_region: { type: 'string', default: 'us-central1' },
  };
  if (flags.needsZoneVar) {
    variables.gcp_zone = { type: 'string', default: 'us-central1-a' };
  }

  const requiredProviders: Record<string, unknown> = {
    google: { source: 'hashicorp/google', version: '~> 5.0' },
  };
  if (flags.needsRandomProvider) {
    requiredProviders.random = { source: 'hashicorp/random', version: '~> 3.0' };
  }
  if (flags.needsGoogleBetaProvider) {
    requiredProviders['google-beta'] = { source: 'hashicorp/google-beta', version: '~> 5.0' };
  }

  const providerBlock: Record<string, unknown> = {
    google: {
      project: '${var.project_id}',
      region: '${var.gcp_region}',
    },
  };
  if (flags.needsGoogleBetaProvider) {
    // google_api_gateway_* (Function.ApiGateway) ainda não é GA no provider
    // `google` — precisa do provider `google-beta` com a MESMA config (sem
    // alias: é o provider default do tipo google-beta neste módulo).
    providerBlock['google-beta'] = {
      project: '${var.project_id}',
      region: '${var.gcp_region}',
    };
  }

  return { variables, requiredProviders, providerBlock };
}

/**
 * Firestore só permite UM database `(default)` por projeto GCP — este é o
 * ÚNICO ponto do synth GCP que emite `google_firestore_database` (endereço
 * FIXO `google_firestore_database.iacmp_default`), chamado uma vez por
 * diretório de synth a partir de `emitGCPProviders`, nunca por
 * construct/stack (ver constructs/database.ts). Declarar o mesmo
 * `name: "(default)"` sob endereços TF diferentes por stack faria o
 * Terraform tentar criar o database mais de uma vez — a API real do
 * Firestore rejeita com "already exists" a partir da 2ª tentativa.
 * `deletionProtection` é OR de todas as Database.DynamoDB/DocumentDB do
 * projeto: não existe "proteção por tabela" num database compartilhado —
 * se qualquer uma pediu proteção, o singleton inteiro fica protegido.
 */
function buildFirestoreDefaultResource(deletionProtection: boolean): Record<string, unknown> {
  return {
    google_firestore_database: {
      iacmp_default: {
        project: '${var.project_id}',
        name: '(default)',
        location_id: '${var.gcp_region}',
        type: 'FIRESTORE_NATIVE',
        deletion_policy: deletionProtection ? 'DELETE_PROTECTION_ENABLED' : 'DELETE_PROTECTION_DISABLED',
      },
    },
  };
}

/**
 * "Private services access" para Database.SQL privado (ver constructs/database.ts,
 * case Database.SQL com vpcId) — UM par global_address+connection POR VPC,
 * nunca por-instância de Database.SQL: dois Cloud SQL na MESMA VPC compartilham
 * o mesmo peering de serviço (a API do Service Networking também rejeitaria
 * uma 2ª connection para o mesmo par network+service). `privateNetworkVpcIds`
 * já chega deduplicado (é um Set, ver TFOutput) — este helper só materializa
 * os dois recursos TF por vpcId, mesmo raciocínio de singleton do Firestore
 * `(default)` acima, mas chaveado por VPC em vez de projeto inteiro.
 */
function buildPrivateServiceNetworkingResources(vpcIds: Set<string>): Record<string, unknown> {
  const globalAddress: Record<string, unknown> = {};
  const connection: Record<string, unknown> = {};
  for (const vpcId of vpcIds) {
    const vpcTfId = toTfId(vpcId);
    const addrId = `${vpcTfId}_psa_range`;
    const networkRef = `\${google_compute_network.${vpcTfId}.id}`;
    globalAddress[addrId] = {
      name: `${gcpName(vpcId)}-psa-range`,
      purpose: 'VPC_PEERING',
      address_type: 'INTERNAL',
      prefix_length: 16,
      network: networkRef,
    };
    connection[`${vpcTfId}_psa`] = {
      network: networkRef,
      service: 'servicenetworking.googleapis.com',
      reserved_peering_ranges: [`\${google_compute_global_address.${addrId}.name}`],
    };
  }
  return {
    google_compute_global_address: globalAddress,
    google_service_networking_connection: connection,
  };
}

/**
 * Blocos compartilhados do PROJETO GCP inteiro — `terraform{required_providers}`
 * + `provider{}` + `variable{}` (+ `resource{google_firestore_database}` quando
 * o projeto tem Database.DynamoDB/DocumentDB, ver buildFirestoreDefaultResource)
 * — para escrever UMA vez por diretório de synth (ex: `synth-out/gcp/_providers.tf.json`),
 * nunca por stack: o Terraform combina todo `*.tf.json` de um diretório num único
 * root module, então declarar estes blocos em cada `<stack>.tf.json` os duplicaria
 * e `terraform validate`/`plan` abortaria com "Duplicate required providers/
 * provider/variable configuration" assim que o projeto tiver 2+ stacks
 * (convenção do iacmp é 1 stack por domínio).
 */
export function emitGCPProviders(allStacks: Stack[]): string {
  const registry = buildRegistry(allStacks);
  const flags = collectSharedFlags(allStacks, registry);
  const { variables, requiredProviders, providerBlock } = buildProviderBlocks(flags);

  const tfJson: Record<string, unknown> = {
    terraform: { required_providers: requiredProviders },
    provider: providerBlock,
    variable: variables,
  };
  if (flags.needsFirestoreDefault) {
    tfJson.resource = buildFirestoreDefaultResource(flags.firestoreDeletionProtection);
  }
  if (flags.privateNetworkVpcIds.size > 0) {
    const privateNetRes = buildPrivateServiceNetworkingResources(flags.privateNetworkVpcIds);
    tfJson.resource = tfJson.resource
      ? { ...(tfJson.resource as Record<string, unknown>), ...privateNetRes }
      : privateNetRes;
  }
  return JSON.stringify(tfJson, null, 2) + '\n';
}

/**
 * `resource{}`/`output{}` de UMA stack — sem os blocos compartilhados (ver
 * emitGCPProviders). É o que `iacmp synth --provider gcp` grava em
 * `<stackName>.tf.json` para projetos multi-stack.
 */
export function emitGCPResources(stack: Stack, allStacks: Stack[] = [stack]): string {
  const registry = buildRegistry(allStacks);
  const ctx = newCtx(registry);

  for (const construct of stack.constructs) {
    synthesizeConstruct(construct, ctx, registry);
  }

  const tfJson: Record<string, unknown> = {};
  if (Object.keys(ctx.resources).length > 0) {
    tfJson.resource = ctx.resources;
  }
  if (Object.keys(ctx.outputs).length > 0) {
    tfJson.output = ctx.outputs;
  }
  return JSON.stringify(tfJson, null, 2) + '\n';
}

/**
 * tf.json self-contained de UMA stack (blocos compartilhados + resources num
 * arquivo só) — mantido para compatibilidade: testes que sintetizam uma stack
 * isolada (golden-tf, gcp-terraform.test.ts) e qualquer consumidor que precise
 * do projeto inteiro num único documento. Equivale a
 * `emitGCPProviders(allStacks) + emitGCPResources(stack, allStacks)` mesclados
 * (mesma ordem de chaves: terraform, provider, variable, resource?, output?).
 *
 * O `iacmp synth --provider gcp` NÃO usa esta função para gravar em disco —
 * projetos multi-stack precisam dos blocos compartilhados separados (ver
 * emitGCPProviders) para não duplicar `terraform`/`provider`/`variable` entre
 * os `*.tf.json` do mesmo diretório.
 */
export function emitGCPTerraform(stack: Stack, allStacks: Stack[] = [stack]): string {
  const providers = JSON.parse(emitGCPProviders(allStacks)) as Record<string, unknown>;
  const resources = JSON.parse(emitGCPResources(stack, allStacks)) as Record<string, unknown>;
  return JSON.stringify(mergeProvidersAndResources(providers, resources), null, 2) + '\n';
}

/**
 * Mescla os dois documentos self-contained (ver emitGCPTerraform). Não pode
 * ser um spread raso: desde que `buildFirestoreDefaultResource` passou a
 * poder colocar `resource{google_firestore_database}` no lado `providers`,
 * um `{...providers, ...resources}` ingênuo apagaria esse bloco inteiro toda
 * vez que a própria stack também emitir `resource{}` (ex: database-suite tem
 * Database.SQL/Redis/Memcached na MESMA stack que Database.DynamoDB/DocumentDB)
 * — `resources.resource` sobrescreveria `providers.resource` por inteiro em
 * vez de só adicionar as próprias chaves. Por isso `resource{}` (e `output{}`,
 * pela mesma lógica, mesmo que hoje só `resources` o preencha) mesclam por
 * tfType, os demais blocos (terraform/provider/variable) seguem shallow.
 */
function mergeProvidersAndResources(
  providers: Record<string, unknown>,
  resources: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...providers, ...resources };
  for (const key of ['resource', 'output'] as const) {
    if (providers[key] && resources[key]) {
      merged[key] = {
        ...(providers[key] as Record<string, unknown>),
        ...(resources[key] as Record<string, unknown>),
      };
    }
  }
  return merged;
}

// ── Function metadata for packaging (deploy build) ───────────────────────────
// Espelha AzureFunctionMeta (packages/providers/azure/src/synth/bicep.ts) — o
// `iacmp deploy --provider gcp` (packages/cli/src/deploy/gcp.ts) lê este
// sidecar (`<stackName>.iacmp-meta.json`, gravado pelo synth.ts) para saber
// QUAIS Fn.Lambda desta stack precisam de bundle+zip+upload antes do
// `terraform apply`, sem precisar reimplementar a lógica de handler/entry
// point/object aqui — `entryPoint`/`zipObject` já saem calculados com as
// MESMAS funções (`gcpEntryPoint`/`gcpFunctionZipObject`) que o synth usa
// para preencher `build_config.entry_point`/`.object` (ver constructs/function.ts),
// garantindo que o zip publicado bate com o que o Terraform espera no bucket.
export interface GCPFunctionMeta {
  constructId: string;
  handler: string;
  code: string;
  runtime: string;
  /** Nome da função exportada que o bundle precisa expor — ver gcpEntryPoint. */
  entryPoint: string;
  /** Nome do object (zip) no bucket `<project_id>-artifacts` — ver gcpFunctionZipObject. */
  zipObject: string;
  /**
   * 'event' quando a Fn.Lambda tem `eventSources[].queueId` (dispara a partir
   * de uma Messaging.Queue/Pub/Sub) — MESMA detecção que
   * `constructs/function.ts` usa para emitir `event_trigger` no
   * `google_cloudfunctions2_function` (ver eventTrigger/pubsubSource lá).
   * O deploy (`packages/cli/src/deploy/gcp.ts`) usa este flag para registrar
   * o handler via `functions.cloudEvent` (CloudEvent entregue DIRETO ao
   * handler do usuário) em vez do wrapper HTTP-Lambda — Cloud Functions gen2
   * com trigger Pub/Sub recebe um CloudEvent, não um `req` estilo Express;
   * usar o wrapper HTTP nesse caso monta um event vazio e
   * `event.data.message.data` chega em branco no handler (bug provado em
   * deploy real). Default 'http' preserva o comportamento anterior para
   * sidecars antigos sem este campo.
   */
  trigger: 'http' | 'event';
}

export interface GCPContainerMeta {
  constructId: string;
  /** gcpName(constructId) — nome RFC1035 usado na tag da imagem: gcr.io/<project>/<imageName>:latest */
  imageName: string;
  /** Contexto do build (relativo à raiz do projeto). */
  context: string;
  dockerfile?: string;
}

export function extractGCPContainerMeta(stack: Stack): GCPContainerMeta[] {
  return stack.constructs
    .filter((c) => c.type === 'Compute.Container')
    .filter((c) => {
      const props = c.props as Record<string, unknown>;
      return typeof props.build === 'object' && props.build !== null;
    })
    .map((c) => {
      const props = c.props as Record<string, unknown>;
      const build = props.build as { context?: string; dockerfile?: string };
      return {
        constructId: c.id,
        imageName: gcpName(c.id),
        context: build.context ?? '.',
        ...(build.dockerfile ? { dockerfile: build.dockerfile } : {}),
      };
    });
}

export function extractGCPFunctionMeta(stack: Stack): GCPFunctionMeta[] {
  return stack.constructs
    .filter((c) => c.type === 'Function.Lambda')
    .map((c) => {
      const props = c.props as Record<string, unknown>;
      const handler = (props.handler as string) ?? 'dist/handler.handler';
      const eventSources = (props.eventSources as Array<Record<string, unknown>>) ?? [];
      const hasPubsubTrigger = eventSources.some((es) => typeof es.queueId === 'string');
      return {
        constructId: c.id,
        handler,
        code: (props.code as string) ?? 'dist/',
        runtime: (props.runtime as string) ?? 'nodejs20',
        entryPoint: gcpEntryPoint(handler),
        zipObject: gcpFunctionZipObject(c.id),
        trigger: hasPubsubTrigger ? 'event' : 'http',
      };
    });
}
