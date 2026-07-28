import type { GCPRegistry } from '../refs.js';

export interface TFOutput {
  resources: Record<string, Record<string, unknown>>;
  outputs: Record<string, { value: string; sensitive?: boolean }>;
  needsZoneVar: boolean;
  /** hashicorp/random é adicionado a required_providers só quando usado (ver Database.SQL). */
  needsRandomProvider: boolean;
  /** hashicorp/google-beta é adicionado a required_providers só quando usado (ver Function.ApiGateway — google_api_gateway_* ainda não é GA no provider google). */
  needsGoogleBetaProvider: boolean;
  /**
   * true quando ALGUMA Database.DynamoDB/Database.DocumentDB (em qualquer stack
   * do projeto) precisa do Firestore database `(default)`. O Firestore só
   * permite UM `(default)` por projeto, então o recurso NUNCA é emitido aqui
   * por construct/stack — este flag só sinaliza a necessidade; quem emite o
   * singleton (endereço fixo `google_firestore_database.iacmp_default`) é
   * `emitGCPProviders` em gcp-terraform.ts, uma vez por diretório de synth.
   * Ver constructs/database.ts (cases DynamoDB/DocumentDB) e TYPE_DESCRIPTORS
   * em refs.ts.
   */
  needsFirestoreDefault: boolean;
  /** true quando QUALQUER construct que pediu needsFirestoreDefault também pediu deletionProtection — protege o singleton inteiro (não dá pra ter proteção "por tabela" num database compartilhado). */
  firestoreDeletionProtection: boolean;
  /**
   * Ids lógicos (constructId) de Network.VPC que precisam de "private services
   * access" para hospedar Database.SQL privado (ver constructs/database.ts,
   * case Database.SQL com vpcId). Um Set (não bool) porque, ao contrário do
   * Firestore `(default)` — que é 1 por PROJETO — aqui o recurso é 1 por VPC:
   * um projeto pode ter várias VPCs, cada uma com seu próprio peering de
   * serviço. Deduplicado por vpcId: 2+ Database.SQL na MESMA VPC (mesma stack
   * ou stacks diferentes, desde que emitido a partir do registro global de
   * `collectSharedFlags`) resultam em UM só par global_address+connection —
   * ver buildPrivateServiceNetworkingResources em gcp-terraform.ts.
   */
  privateNetworkVpcIds: Set<string>;
  /** Registro global (todas as stacks) usado para resolver ref() — ver ../refs.ts. */
  registry: GCPRegistry;
}

export function toTfId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

/**
 * Normaliza um id de construct para um `name` válido em recursos GCP cujo
 * campo `name` é restrito por RFC1035: minúsculas, começa com letra, só
 * `[a-z0-9-]`, termina em alfanumérico, máx 63 chars.
 * Use apenas nos recursos que a API do provider `google` de fato restringe
 * (docs/roadmap-fase2.md §2.2.2) — não em todo lugar.
 */
export function gcpName(id: string): string {
  let name = id.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z]/.test(name)) name = `a-${name}`;
  name = name.slice(0, 63).replace(/-+$/, '');
  return name || 'a';
}

/**
 * Nome de um Serverless VPC Access connector — restrição própria do recurso
 * (mais apertada que `gcpName`): `^[a-z][-a-z0-9]{0,23}[a-z0-9]$`, máx 25 chars.
 */
export function vpcConnectorName(vpcId: string): string {
  const base = gcpName(vpcId).slice(0, 20).replace(/-+$/, '') || 'vpc';
  return `${base}-con`.slice(0, 25).replace(/-+$/, '');
}

/**
 * Cloud Functions gen2 (`google_cloudfunctions2_function.build_config.entry_point`)
 * espera o NOME da função exportada pelo bundle, não um path de módulo — ao
 * contrário do `Handler` da AWS Lambda (`arquivo.exportName`, o runtime
 * resolve o arquivo E o export a partir da mesma string). `props.handler` do
 * iacmp segue a convenção agnóstica AWS-like (ex: `dist/process.handler`);
 * aqui extraímos só o último segmento após o `.` — o build do deploy
 * (packages/cli/src/deploy/gcp.ts) é quem garante que o bundle final
 * exporta uma função com ESSE nome (`exports.<entryPoint> = ...`),
 * ignorando o resto do path (que só faz sentido pro esbuild localizar o
 * arquivo fonte, não pro runtime do Cloud Functions).
 */
export function gcpEntryPoint(handler: string): string {
  const lastDot = handler.lastIndexOf('.');
  return lastDot >= 0 ? handler.slice(lastDot + 1) : handler;
}

/**
 * Nome do object (zip) do bundle desta function no bucket de artefatos —
 * um por-function (`gcpName(id).zip`), nunca o `function.zip` fixo antigo:
 * duas Fn.Lambda no mesmo projeto colidiriam no mesmo object, e a 2ª function
 * criada/atualizada sobrescreveria o código da 1ª no bucket.
 */
export function gcpFunctionZipObject(id: string): string {
  return `${gcpName(id)}.zip`;
}

export function addResource(
  resources: Record<string, Record<string, unknown>>,
  tfType: string,
  tfId: string,
  props: Record<string, unknown>,
): void {
  if (!resources[tfType]) resources[tfType] = {};
  resources[tfType][tfId] = props;
}

export const RUNTIME_MAP: Record<string, string> = {
  'nodejs20': 'nodejs20',
  'nodejs18': 'nodejs18',
  'python3.12': 'python312',
  'python3.11': 'python311',
  'java21': 'java21',
  'go1.x': 'go121',
  'dotnet8': 'dotnet8',
};
