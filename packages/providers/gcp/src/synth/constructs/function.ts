import { BaseConstruct } from '@iacmp/core';
import { TFOutput, toTfId, addResource, gcpName, RUNTIME_MAP, vpcConnectorName, gcpEntryPoint, gcpFunctionZipObject } from './common.js';

/**
 * Nome da securityDefinition (OpenAPI 2.0) para um dado par authType/authorizerLambdaId
 * — dedupe: rotas diferentes que usam o MESMO authorizer (ou o mesmo authType a nível
 * de gateway) caem na MESMA securityDefinition, uma vez só no documento.
 */
function jwtSecurityDefinitionName(authType: string, authorizerLambdaId?: string): string {
  const suffix = authorizerLambdaId ? toTfId(authorizerLambdaId) : authType.toLowerCase();
  return `${suffix}_auth`;
}

/**
 * Google API Gateway valida JWT NATIVAMENTE via issuer/jwks_uri (extensões
 * `x-google-issuer`/`x-google-jwks_uri` no OpenAPI 2.0) — não existe o conceito de
 * "Lambda authorizer" arbitrário como no API Gateway da AWS (authorizerLambdaId).
 * `Fn.ApiGatewayProps` (packages/core/src/constructs/function.ts) é agnóstico e não
 * carrega issuer/jwksUri — por isso preenchemos um ESQUELETO com placeholders
 * documentados via x-iacmp-authorizer-lambda-id (metadado não-padrão, ignorado pela
 * API do Google, só para rastrear a origem do gap). Quem for de fato fazer o deploy
 * PRECISA sobrescrever x-google-issuer/x-google-jwks_uri com o provedor de identidade
 * real (Firebase Auth, Auth0, Cognito, etc.) — sem isso a validação de JWT no Gateway
 * não funciona. Mesma lacuna vale para authType AWS_IAM/COGNITO (sem equivalente
 * nativo no GCP): usamos o mesmo esqueleto, só documentando a intenção original.
 */
function buildSecurityDefinition(
  apiName: string,
  authType: string,
  authorizerLambdaId?: string,
): Record<string, unknown> {
  return {
    authorizationUrl: '',
    flow: 'implicit',
    type: 'oauth2',
    'x-google-issuer': 'https://ISSUER_PLACEHOLDER.example.com/',
    'x-google-jwks_uri': 'https://ISSUER_PLACEHOLDER.example.com/.well-known/jwks.json',
    'x-google-audiences': apiName,
    ...(authorizerLambdaId ? { 'x-iacmp-authorizer-lambda-id': authorizerLambdaId } : {}),
    ...(authType !== 'JWT' ? { 'x-iacmp-source-auth-type': authType } : {}),
  };
}

const ANY_METHODS = ['get', 'post', 'put', 'delete', 'patch'];

/**
 * Extrai os nomes de path param de um template de rota (ex: `/messages/{id}`
 * → `['id']`, `/users/{userId}/posts/{postId}` → `['userId', 'postId']`).
 * Swagger 2.0 EXIGE que todo `{param}` do path esteja declarado em
 * `parameters` (com `in: path`) na própria operação — sem isso o API Gateway
 * (Cloud Endpoints) tenta mapear o param pra um campo da mensagem de request
 * (google.protobuf.Empty, já que backends REST não têm proto) e falha com
 * "undefined field '<param>' on message 'google.protobuf.Empty'". Isso é
 * INDEPENDENTE de `path_translation` (que controla como o BACKEND recebe o
 * path, não a validação do swagger em si).
 */
function extractPathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/**
 * Marca um valor como EXPRESSÃO Terraform crua (não string literal) para
 * `toHclValue` abaixo — ver comentário de `toHclValue` para o porquê disso
 * existir (o `contents` do openapi_documents precisa ser montado como
 * expressão HCL, não como JSON pré-serializado em JS, senão refs tipo
 * `${google_cloudfunctions2_function...}` nunca são resolvidas pelo Terraform).
 */
interface RawExpr { readonly __gcpRawExpr: true; readonly expr: string }
function rawExpr(expr: string): RawExpr {
  return { __gcpRawExpr: true, expr };
}
function isRawExpr(v: unknown): v is RawExpr {
  return !!v && typeof v === 'object' && (v as Record<string, unknown>).__gcpRawExpr === true;
}

/**
 * Serializa uma string como literal HCL — igual a um literal JSON (mesmas
 * regras de escape de aspas/backslash/controle), MAIS o escape dos
 * introdutores de template do HCL (`${` e `%{`), que JSON.stringify não
 * conhece. Sem isso, um texto de usuário (ex: `route.description`) que por
 * acaso contenha `${` seria interpretado como interpolação pelo Terraform.
 */
function hclString(s: string): string {
  return JSON.stringify(s).replace(/\$\{/g, '$${').replace(/%\{/g, '%%{');
}

/**
 * Converte um valor JS (objeto/array/string/número/booleano/RawExpr) numa
 * expressão HCL (constructor de objeto/array, igual ao que `jsonencode()`
 * aceita como argumento) — ver `toHclValue` na chamada do `contents` do
 * openapi_documents abaixo pro porquê: o documento OpenAPI é montado
 * DINAMICAMENTE em JS (paths, security, backend address), mas o backend
 * address de cada rota é uma REF pro Cloud Function (`google_cloudfunctions2_function...uri`,
 * um atributo só conhecido em tempo de apply). Se serializássemos o JSON e
 * codificássemos em base64 aqui no JS (como antes), a ref viraria bytes
 * base64 opacos — o Terraform nunca teria a chance de ver o `${...}` e
 * resolvê-lo. Construindo a expressão HCL (`jsonencode({...})`) em vez do
 * JSON literal, o Terraform primeiro AVALIA as refs (substituindo pela URI
 * real da function) e só DEPOIS serializa+codifica — via
 * `base64encode(jsonencode(<expr>))` no `contents` final.
 */
function toHclValue(v: unknown): string {
  if (isRawExpr(v)) return v.expr;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return hclString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(toHclValue).join(', ')}]`;
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${hclString(k)} = ${toHclValue(val)}`);
    return `{${entries.join(', ')}}`;
  }
  return hclString(String(v));
}

/**
 * Monta `paths` (OpenAPI 2.0) a partir de `routes` do Fn.ApiGateway — cada rota vira
 * uma operação com `x-google-backend.address` apontando pra URI da Cloud Function
 * (resolvida via `ctx.registry`, igual ao padrão cross-stack de vpcId/queueId acima).
 * authType/authorizerLambdaId por rota sobrepõem o nível do gateway (mesma regra do
 * core); authType 'NONE' explícito na rota deixa a rota pública mesmo com o gateway
 * inteiro exigindo auth (ver fixture gcp-jwt-authorizer, rota /health).
 *
 * `backendAddress` é um `RawExpr` (não uma string `${...}` literal) quando aponta
 * pra uma Function.Lambda: o documento inteiro é serializado depois via
 * `toHclValue` + `jsonencode()`/`base64encode()` do PRÓPRIO Terraform (ver
 * `Function.ApiGateway` abaixo) — só assim a ref é resolvida pro valor real
 * antes de virar base64.
 *
 * Também devolve `backendLambdaIds` — o conjunto de Function.Lambda que
 * aparecem como backend de ALGUMA rota (não confundir com o authorizer:
 * `authorizerLambdaId` é só documentado no securityDefinition, NUNCA chamado
 * pelo Gateway como backend HTTP). É a partir desse conjunto que o caller monta
 * as permissões `run.invoker` (ver Function.ApiGateway abaixo, e o bug real de
 * deploy: Cloud Functions gen2 rodam sobre Cloud Run e exigem IAM auth por
 * padrão — sem o `run.invoker` pra SA do Gateway, toda chamada volta 403
 * "Forbidden" do Cloud Run, mesmo com o OpenAPI e o JWT corretos).
 */
function buildOpenApiPaths(
  routes: Array<Record<string, unknown>>,
  apiName: string,
  gatewayAuthType: string | undefined,
  gatewayAuthorizerLambdaId: string | undefined,
  ctx: TFOutput,
): { paths: Record<string, Record<string, unknown>>; securityDefinitions: Record<string, unknown>; backendLambdaIds: Set<string> } {
  const paths: Record<string, Record<string, unknown>> = {};
  const securityDefinitions: Record<string, unknown> = {};
  const backendLambdaIds = new Set<string>();

  for (const route of routes) {
    const path = route.path as string | undefined;
    if (!path) continue;
    const methodRaw = ((route.method as string) ?? 'GET').toLowerCase();
    const methods = methodRaw === 'any' ? ANY_METHODS : [methodRaw];

    const lambdaId = route.lambdaId as string | undefined;
    const lambdaTarget = lambdaId ? ctx.registry.byId.get(lambdaId) : undefined;
    const isLambdaBackend = lambdaTarget?.type === 'Function.Lambda';
    const backendAddress: RawExpr | string | undefined = lambdaId
      ? (isLambdaBackend
        ? rawExpr(`google_cloudfunctions2_function.${toTfId(lambdaId)}.service_config[0].uri`)
        : lambdaId)
      : undefined;
    if (isLambdaBackend) backendLambdaIds.add(lambdaId!);

    const routeAuthType = (route.authType as string | undefined) ?? gatewayAuthType;
    const routeAuthorizerLambdaId = (route.authorizerLambdaId as string | undefined) ?? gatewayAuthorizerLambdaId;
    const needsAuth = !!routeAuthType && routeAuthType !== 'NONE';

    let securityName: string | undefined;
    if (needsAuth) {
      securityName = jwtSecurityDefinitionName(routeAuthType!, routeAuthorizerLambdaId);
      if (!securityDefinitions[securityName]) {
        securityDefinitions[securityName] = buildSecurityDefinition(apiName, routeAuthType!, routeAuthorizerLambdaId);
      }
    }

    const pathParams = extractPathParams(path);

    if (!paths[path]) paths[path] = {};
    for (const method of methods) {
      paths[path][method] = {
        operationId: `${method}_${path}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase(),
        ...(route.description ? { summary: route.description as string } : {}),
        // Swagger 2.0: todo {param} do path precisa estar declarado aqui (in: path,
        // required: true) — omitido quando a rota não tem path param (ver
        // extractPathParams). `type` fica direto no parameter (não em `schema`,
        // que é sintaxe OpenAPI 3.x).
        ...(pathParams.length > 0 ? {
          parameters: pathParams.map((name) => ({ name, in: 'path', required: true, type: 'string' })),
        } : {}),
        responses: { '200': { description: 'OK' } },
        // path_translation: APPEND_PATH_TO_ADDRESS — o default do API Gateway pra
        // backend HTTP é CONSTANT_ADDRESS, que tenta mapear path params (ex: {id})
        // em campos de uma mensagem protobuf (Empty, já que não há gRPC aqui) e
        // falha com "undefined field 'id' on message 'google.protobuf.Empty'" em
        // TODA rota com path param. A Cloud Function roteia o path internamente
        // (Express/router do handler) — precisamos que o Gateway ANEXE o path
        // completo ao endereço em vez de tentar mapear params, por isso em TODA
        // rota (não só as com {param}: uma rota sem param também quebraria — o
        // handler receberia sempre o endereço base sem o path real).
        ...(backendAddress ? { 'x-google-backend': { address: backendAddress, path_translation: 'APPEND_PATH_TO_ADDRESS' } } : {}),
        ...(securityName ? { security: [{ [securityName]: [] }] } : {}),
      };
    }
  }

  return { paths, securityDefinitions, backendLambdaIds };
}

/**
 * account_id de `google_service_account` — restrição própria do recurso:
 * `[a-z][a-z0-9-]{4,28}[a-z0-9]` (6-30 chars). Igual espírito de
 * `vpcConnectorName` acima (trunca a base pra sobrar espaço pro sufixo fixo).
 */
function apiGatewayInvokerAccountId(constructId: string): string {
  const base = gcpName(constructId).slice(0, 19).replace(/-+$/, '') || 'api';
  return `${base}-gw-invoker`.slice(0, 30).replace(/-+$/, '');
}

/**
 * WebSocket (Fn.ApiGateway type: 'WEBSOCKET') no GCP — APROXIMAÇÃO DOCUMENTADA.
 *
 * O GCP não tem um "API Gateway WebSocket": `google_api_gateway_*` (usado no
 * branch HTTP/REST abaixo) só fala REST/OpenAPI, sem suporte a upgrade de
 * conexão WebSocket. O análogo real do GCP é **Cloud Run**, que aceita
 * WebSocket nativamente numa conexão HTTP persistente — por isso, quando
 * `props.type === 'WEBSOCKET'`, emitimos um `google_cloud_run_v2_service`
 * (não `google_api_gateway_*`) com `session_affinity = true` (mesma conexão
 * volta pra mesma instância — necessário pra manter estado em memória do
 * socket) e `timeout` longo (1h) — sem isso o LB do Cloud Run derruba a
 * conexão bem antes do timeout HTTP normal.
 *
 * LIMITAÇÃO vs. AWS (documentar sempre que este branch for tocado): o modelo
 * AWS de rotas $connect/$disconnect/$default SEPARADAS (cada uma uma Lambda
 * distinta, ver Fn.ApiGateway WEBSOCKET no synth AWS) NÃO existe no Cloud
 * Run — uma conexão WS persistente é servida por UM ÚNICO handler de longa
 * duração dentro do container, que precisa demultiplexar connect/disconnect/
 * mensagem internamente (ex: no primeiro upgrade de conexão, no fechamento,
 * a cada frame). O backend escolhido é o lambdaId da rota `$default` (onde
 * as mensagens de fato chegam); `$connect` é usado como fallback quando não
 * há `$default`. As Fn.Lambda referenciadas pelas rotas AINDA são
 * sintetizadas normalmente como `google_cloudfunctions2_function` (case
 * Function.Lambda abaixo) — elas ficam DESCONECTADAS deste Cloud Run
 * (Cloud Functions Gen2 não sustenta conexão persistente), o que é uma
 * lacuna conhecida: o `image` do container é um PLACEHOLDER derivado do
 * nome da Lambda alvo, não uma imagem real construída a partir do handler
 * (mesma limitação de Compute.Container, que também exige `props.image`
 * explícita do usuário — o iacmp não builda imagens Docker a partir de
 * código de handler). Quem for de fato fazer o deploy PRECISA publicar uma
 * imagem real que sirva as conexões WebSocket nesse endereço.
 */
function buildWebsocketCloudRun(
  construct: BaseConstruct,
  props: Record<string, unknown>,
  id: string,
  r: TFOutput['resources'],
  ctx: TFOutput,
): void {
  const routes = (props.routes as Array<Record<string, unknown>>) ?? [];
  const backendRoute = routes.find((rt) => rt.path === '$default' && rt.lambdaId)
    ?? routes.find((rt) => rt.path === '$connect' && rt.lambdaId)
    ?? routes.find((rt) => rt.lambdaId);
  const backendLambdaId = backendRoute?.lambdaId as string | undefined;
  const imageName = gcpName(backendLambdaId ?? construct.id);

  addResource(r, 'google_cloud_run_v2_service', id, {
    name: gcpName(construct.id),
    location: '${var.gcp_region}',
    template: [{
      // Afinidade de sessão: reconexões do MESMO cliente caem na MESMA
      // instância — sem isso o estado em memória da conexão WS se perde a
      // cada novo request roteado para outra réplica.
      session_affinity: true,
      // 1h — Cloud Run corta em 3600s no máximo; sem isto o default (300s)
      // derrubaria a conexão bem antes do esperado para um socket persistente.
      timeout: '3600s',
      containers: [{
        // PLACEHOLDER — ver comentário da função acima: substitua pela
        // imagem real do serviço que trata $connect/$disconnect/$default.
        image: `gcr.io/\${var.project_id}/${imageName}:latest`,
        ports: [{ container_port: 8080 }],
      }],
      scaling: [{ min_instance_count: 0, max_instance_count: 10 }],
    }],
    ingress: 'INGRESS_TRAFFIC_ALL',
  });
  ctx.outputs[`${construct.id}WebSocketUrl`] = { value: `\${google_cloud_run_v2_service.${id}.uri}` };
}

// Role usada quando nenhuma action do statement bate com um padrão conhecido
// (serviço AWS sem tradução GCP mapeada, ou action já vazia/genérica) — a
// MESMA que o comportamento antigo usava para TUDO. Mantém o synth "sensato
// e sem erro" mesmo pra casos não cobertos, só documentando a lacuna aqui em
// vez de escondê-la atrás de um fallback silencioso universal.
const FALLBACK_ROLE = 'roles/viewer';

// Tradução best-effort de action IAM estilo AWS ('service:Verb', ver
// PolicyStatement em packages/core/src/constructs/policy.ts) → role
// predefinida do GCP. NÃO é 1:1: o modelo AWS é permissão granular por
// recurso+verbo (Resource + Condition); o GCP concede a role a nível de
// PROJETO inteiro (google_project_iam_member) — sempre mais permissivo que o
// statement original pedia. Cobre os serviços mais comuns dos exemplos do
// projeto (S3->Storage, DynamoDB->Firestore/Datastore, SQS/SNS->Pub/Sub, Secrets Manager->
// Secret Manager, Logs/CloudWatch→Logging/Monitoring, Lambda invoke→Cloud
// Functions invoker, KMS→Cloud KMS). `effect: 'Deny'` não tem equivalente
// (IAM condicional do GCP é outro recurso, fora de escopo) — statements Deny
// caem no mesmo mapeamento de role de leitura/escrita do serviço, sem negar
// nada; isso é uma lacuna conhecida, não um bug silencioso: statements Deny
// não são comuns nos exemplos do projeto (nenhum uso hoje). Action sem prefixo
// reconhecido cai em FALLBACK_ROLE (roles/viewer).
const ACTION_ROLE_PATTERNS: Array<{ pattern: RegExp; role: string }> = [
  // Storage (S3 → google_storage_bucket)
  { pattern: /^s3:(Get|List|Head)/i, role: 'roles/storage.objectViewer' },
  { pattern: /^s3:/i, role: 'roles/storage.objectAdmin' },

  // Secrets (Secrets Manager / SSM → Secret Manager)
  { pattern: /^(secretsmanager|ssm):/i, role: 'roles/secretmanager.secretAccessor' },

  // Messaging (SQS/SNS → Pub/Sub)
  { pattern: /^sns:Publish/i, role: 'roles/pubsub.publisher' },
  { pattern: /^sns:/i, role: 'roles/pubsub.viewer' },
  { pattern: /^sqs:(Send|Publish)/i, role: 'roles/pubsub.publisher' },
  { pattern: /^sqs:(Receive|Delete|Consume|Get)/i, role: 'roles/pubsub.subscriber' },
  { pattern: /^sqs:/i, role: 'roles/pubsub.editor' },

  // Database (DynamoDB -> Firestore/Datastore; ver TYPE_DESCRIPTORS em ../refs.ts —
  // Database.DynamoDB é uma coleção do Firestore database `(default)`, não Bigtable)
  { pattern: /^dynamodb:(Get|Query|Scan|BatchGetItem)/i, role: 'roles/datastore.viewer' },
  { pattern: /^dynamodb:/i, role: 'roles/datastore.user' },

  // Observabilidade
  { pattern: /^logs:/i, role: 'roles/logging.logWriter' },
  { pattern: /^cloudwatch:Put/i, role: 'roles/monitoring.metricWriter' },
  { pattern: /^cloudwatch:/i, role: 'roles/monitoring.viewer' },

  // Compute/invocação
  { pattern: /^lambda:Invoke/i, role: 'roles/cloudfunctions.invoker' },
  { pattern: /^execute-api:/i, role: 'roles/run.invoker' },

  // Criptografia
  { pattern: /^kms:(Encrypt|Decrypt|GenerateDataKey)/i, role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter' },
  { pattern: /^kms:/i, role: 'roles/cloudkms.viewer' },
];

/**
 * Resolve uma action de Policy.IAM (statement.actions[i]) para uma role GCP —
 * ver ACTION_ROLE_PATTERNS acima pras limitações do mapeamento. Actions já no
 * formato GCP ('roles/...', passthrough explícito do usuário) são aceitas
 * como estão.
 */
function mapActionToRole(action: string): string {
  if (action.startsWith('roles/')) return action;
  for (const { pattern, role } of ACTION_ROLE_PATTERNS) {
    if (pattern.test(action)) return role;
  }
  return FALLBACK_ROLE;
}

export function synthFunction(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Function.Lambda': {
      const environment = (props.environment as Record<string, string>) ?? {};
      const runtime = RUNTIME_MAP[(props.runtime as string) ?? 'nodejs20'] ?? 'nodejs20';

      // VPC: uma Cloud Function só alcança IPs privados (Redis/Cloud SQL em VPC)
      // através de um Serverless VPC Access connector — sem ele, vpcId/subnetIds
      // na stack não têm efeito nenhum no deploy real.
      const vpcId = props.vpcId as string | undefined;
      let vpcConnectorId: string | undefined;
      if (vpcId) {
        // vpcId aponta pro id lógico de um Network.VPC — quase sempre numa
        // stack SEPARADA (rede vs. compute); por isso resolve pelo registro
        // GLOBAL do projeto (ctx.registry), não pelos resources já emitidos
        // NESTA passada (`r`), que só enxerga a stack atual. A interpolação
        // cross-arquivo funciona porque todo .tf.json do projeto cai no MESMO
        // diretório e o Terraform combina tudo num único módulo (ver refs.ts).
        const vpcTarget = ctx.registry.byId.get(vpcId);
        const networkRef = vpcTarget?.type === 'Network.VPC'
          ? `\${google_compute_network.${toTfId(vpcId)}.id}`
          : vpcId;
        vpcConnectorId = `${toTfId(vpcId)}_vpc_connector`;
        // Um connector é compartilhável entre várias functions na mesma VPC —
        // tfId derivado só do vpcId (não do id da function) garante isso: a
        // 2a Fn.Lambda na mesma VPC reaproveita o MESMO connector (addResource
        // com o mesmo tfId/conteúdo é idempotente, não duplica).
        addResource(r, 'google_vpc_access_connector', vpcConnectorId, {
          name: vpcConnectorName(vpcId),
          region: '${var.gcp_region}',
          network: networkRef,
          // Range dedicado do connector — NÃO é o subnetIds da function (esses
          // são para os recursos da VPC, o connector exige um /28 próprio, sem
          // overlap com outras subnets da mesma rede).
          ip_cidr_range: '10.8.0.0/28',
        });
      }

      // eventSources: dispara a function a partir de uma Messaging.Queue
      // (Pub/Sub) — padrão "worker de fila" agnóstico (ver core Fn.Lambda).
      const eventSources = (props.eventSources as Array<Record<string, unknown>>) ?? [];
      const pubsubSource = eventSources.find((es) => typeof es.queueId === 'string');
      const bucketSource = eventSources.find((es) => typeof es.bucketId === 'string');
      let eventTrigger: Record<string, unknown> | undefined;
      if (pubsubSource) {
        const queueId = pubsubSource.queueId as string;
        // Mesmo raciocínio do vpcId acima: JobsQueue tipicamente vive numa
        // stack de messaging separada da stack do worker — resolve pelo
        // registro global, não pelos resources desta passada.
        const queueTarget = ctx.registry.byId.get(queueId);
        const topicRef = queueTarget?.type === 'Messaging.Queue'
          ? `\${google_pubsub_topic.${toTfId(queueId)}.id}`
          : queueId;
        eventTrigger = {
          trigger_region: '${var.gcp_region}',
          event_type: 'google.cloud.pubsub.topic.v1.messagePublished',
          pubsub_topic: topicRef,
          retry_policy: 'RETRY_POLICY_RETRY',
        };
      } else if (bucketSource) {
        const bucketId = bucketSource.bucketId as string;
        const bucketTarget = ctx.registry.byId.get(bucketId);
        const bucketRef = bucketTarget?.type === 'Storage.Bucket'
          ? `\${google_storage_bucket.${toTfId(bucketId)}.name}`
          : bucketId;
        eventTrigger = {
          trigger_region: '${var.gcp_region}',
          event_type: 'google.cloud.storage.object.v1.finalized',
          event_filters: [{ attribute: 'bucket', value: bucketRef }],
          retry_policy: 'RETRY_POLICY_RETRY',
        };
      }

      addResource(r, 'google_cloudfunctions2_function', id, {
        name: construct.id,
        location: '${var.gcp_region}',
        build_config: [{
          runtime,
          entry_point: gcpEntryPoint((props.handler as string) ?? 'handler'),
          source: [{
            storage_source: [{
              bucket: '${var.project_id}-artifacts',
              object: gcpFunctionZipObject(construct.id),
            }],
          }],
        }],
        service_config: [{
          available_memory: `${(props.memory as number) ?? 128}Mi`,
          timeout_seconds: (props.timeout as number) ?? 30,
          // IACMP_CLOUD=gcp — o mecanismo PRIMÁRIO de seleção do adapter é o
          // alias de bundle no build do deploy (packages/cli/src/deploy/gcp.ts,
          // troca '@iacmp/runtime' por '@iacmp/runtime/gcp' em tempo de esbuild);
          // esta env var é só o FALLBACK em runtime (ver getAdapter() em
          // packages/runtime/src/index.ts) para o caso do handler acessar o
          // pacote por um caminho que o alias não cobriu.
          environment_variables: { IACMP_CLOUD: 'gcp', ...environment },
          ...(vpcConnectorId ? {
            vpc_connector: `\${google_vpc_access_connector.${vpcConnectorId}.id}`,
            vpc_connector_egress_settings: 'PRIVATE_RANGES_ONLY',
          } : {}),
        }],
        ...(eventTrigger ? { event_trigger: [eventTrigger] } : {}),
      });
      // Functions HTTP (sem eventSources) precisam de allUsers run.invoker no Cloud
      // Run subjacente — Cloud Functions gen2 rodam sobre Cloud Run, e o Cloud Run
      // exige IAM auth por padrão (ingress ALLOW_ALL é só rede, não dispensa auth).
      // Functions event-triggered (Pub/Sub, eventSources) NÃO precisam: o Eventarc
      // invoca com sua própria SA, não via HTTP anônimo.
      if (!eventTrigger) {
        addResource(r, 'google_cloud_run_v2_service_iam_member', `${id}_public`, {
          project: '${var.project_id}',
          location: '${var.gcp_region}',
          name: `\${lower(google_cloudfunctions2_function.${id}.name)}`,
          role: 'roles/run.invoker',
          member: 'allUsers',
        });
      }
      ctx.outputs[`${construct.id}FunctionUrl`] = { value: `\${google_cloudfunctions2_function.${id}.service_config[0].uri}` };
      return true;
    }

    case 'Function.ApiGateway': {
      // WEBSOCKET não passa por google_api_gateway_* (sem suporte a upgrade de
      // conexão) — vira google_cloud_run_v2_service. Ver buildWebsocketCloudRun.
      if ((props.type as string | undefined) === 'WEBSOCKET') {
        buildWebsocketCloudRun(construct, props, id, r, ctx);
        return true;
      }

      const apiId = toTfId(`${construct.id}_api`);
      const configId = toTfId(`${construct.id}_config`);
      const gatewayId = toTfId(`${construct.id}_gw`);
      const apiName = (props.name as string) ?? construct.id;
      // google_api_gateway_* ainda não é GA no provider `google` (rejeitado
      // como "does not support resource type") — só existe em `google-beta`.
      ctx.needsGoogleBetaProvider = true;
      addResource(r, 'google_api_gateway_api', apiId, {
        provider: 'google-beta',
        api_id: apiName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        display_name: apiName,
      });
      const routes = (props.routes as Array<Record<string, unknown>>) ?? [];
      const { paths, securityDefinitions, backendLambdaIds } = buildOpenApiPaths(
        routes,
        apiName,
        props.authType as string | undefined,
        props.authorizerLambdaId as string | undefined,
        ctx,
      );
      const openApiDoc = {
        swagger: '2.0',
        info: { title: apiName, version: '1.0' },
        ...(Object.keys(securityDefinitions).length > 0 ? { securityDefinitions } : {}),
        paths,
      };

      // Cloud Functions gen2 rodam sobre Cloud Run e exigem IAM auth por padrão
      // (ingress: ALLOW_ALL é só rede, não dispensa auth) — sem uma SA dedicada
      // pro Gateway assinar as chamadas de backend + run.invoker concedido em
      // CADA function-backend, a chamada gateway→function volta 403 "Forbidden"
      // do Cloud Run (confirmado em deploy real), mesmo com o OpenAPI/JWT
      // corretos. Só emitimos a SA/gateway_config/bindings quando HÁ pelo menos
      // 1 rota com backend Function.Lambda (backendLambdaIds) — uma API só com
      // endereços literais não-Lambda não precisa de nada disso.
      let gatewayConfig: Record<string, unknown> | undefined;
      if (backendLambdaIds.size > 0) {
        const gwSaId = `${id}_gw_invoker`;
        addResource(r, 'google_service_account', gwSaId, {
          account_id: apiGatewayInvokerAccountId(construct.id),
          display_name: `API Gateway invoker for ${construct.id}`,
        });
        gatewayConfig = {
          backend_config: [{
            google_service_account: `\${google_service_account.${gwSaId}.email}`,
          }],
        };
        // Um binding por function-backend DISTINTA (não por rota — duas rotas
        // pra mesma function não duplicam o binding). O "nome" do Cloud Run
        // service subjacente a uma Cloud Function gen2 é o próprio `name` da
        // function (mesmo recurso, `google_cloudfunctions2_function.<id>.name`).
        for (const lambdaId of backendLambdaIds) {
          const fnTfId = toTfId(lambdaId);
          addResource(r, 'google_cloud_run_v2_service_iam_member', `${id}_invoker_${fnTfId}`, {
            project: '${var.project_id}',
            location: '${var.gcp_region}',
            // O Cloud Run service subjacente a uma Cloud Function gen2 usa o
            // nome em LOWERCASE, não o `.name` da function (que preserva o
            // PascalCase do construct.id, ex: "UpdateMessageFn"). Confirmado
            // em deploy real: `gcloud run services list` e o próprio
            // `service_config[0].service` da function no state mostram
            // "updatemessagefn" (lowercase) — usar o `.name` cru aqui produz
            // 404 "Resource '<PascalCase>' of kind 'SERVICE' ... does not
            // exist" (o service com esse nome exato nunca existiu).
            name: `\${lower(google_cloudfunctions2_function.${fnTfId}.name)}`,
            role: 'roles/run.invoker',
            member: `serviceAccount:\${google_service_account.${gwSaId}.email}`,
          });
        }
      }

      addResource(r, 'google_api_gateway_api_config', configId, {
        provider: 'google-beta',
        api: `\${google_api_gateway_api.${apiId}.api_id}`,
        display_name: `${construct.id} config`,
        // google_api_gateway_api_config é IMUTÁVEL — qualquer mudança de
        // conteúdo (openapi_documents, gateway_config) força replace
        // (destroy+create). SEM create_before_destroy, a ordem default é
        // destruir o config ANTIGO primeiro — mas o google_api_gateway_gateway
        // (abaixo) ainda referencia esse config antigo nesse momento (seu
        // update/replace só roda DEPOIS, já que depende do id do novo config),
        // e o apply falha com "config is in use in <region>: [<gateway>]"
        // (confirmado em redeploy real — travava TODO redeploy que mudasse
        // rotas/backend). Com create_before_destroy, o Terraform cria o config
        // NOVO primeiro, atualiza/recria o gateway apontando pra ele, e só
        // então destrói o config velho (já sem nenhum gateway referenciando).
        // `api_config_id` é gerado único por apply (prefixo timestamp), então
        // CBD não colide de id entre a instância velha e a nova.
        lifecycle: { create_before_destroy: true },
        ...(gatewayConfig ? { gateway_config: [gatewayConfig] } : {}),
        openapi_documents: [{
          document: [{
            // Conteúdo é JSON (não YAML) — path com extensão .json evita mismatch
            // entre o Content-Type inferido pela extensão e o conteúdo real.
            path: 'openapi.json',
            // NÃO codificar em base64 aqui no JS: `openApiDoc` carrega RawExpr
            // (ver backendAddress acima) apontando pra `google_cloudfunctions2_function
            // ...service_config[0].uri`, um atributo só conhecido em tempo de apply.
            // Codificar agora colapsaria a ref em bytes base64 opacos, que o
            // Terraform nunca teria como interpolar (bug original: API Gateway
            // recebia a string literal "${google_cloudfunctions2_function...}"
            // como address e rejeitava — "not a valid URL"). Em vez disso, emitimos
            // a EXPRESSÃO `base64encode(jsonencode({...}))` pro próprio Terraform
            // avaliar: primeiro resolve a ref pra URI real da function, monta o
            // JSON, e só então codifica em base64.
            contents: `\${base64encode(jsonencode(${toHclValue(openApiDoc)}))}`,
          }],
        }],
      });
      addResource(r, 'google_api_gateway_gateway', gatewayId, {
        provider: 'google-beta',
        // google_api_gateway_gateway não tem atributo `api_id` — só
        // `api_config` (resource name completo do api_config, que já
        // referencia a api por trás) + `gateway_id`.
        api_config: `\${google_api_gateway_api_config.${configId}.id}`,
        gateway_id: `${construct.id}-gateway`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        region: '${var.gcp_region}',
      });
      return true;
    }

    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachTo = (props.attachTo as string) ?? construct.id;
      const accountId = attachTo.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
      const saId = `${id}_sa`;
      addResource(r, 'google_service_account', saId, {
        account_id: accountId,
        display_name: `Service Account for ${attachTo}`,
      });
      // Traduz cada action (statement.actions é IAM-AWS: 'service:Verb', ver
      // PolicyStatement em packages/core/src/constructs/policy.ts) para uma
      // role predefinida do GCP via mapActionToRole — best-effort, NÃO 1:1
      // (AWS é permissão por recurso+verbo, GCP é role agregada por serviço;
      // ver comentário de mapActionToRole abaixo pras limitações). Deduplica
      // por role: várias actions do mesmo serviço (ex: s3:GetObject +
      // s3:PutObject) ou statements diferentes que caem na mesma role geram
      // UM binding só. Usa google_project_iam_member (aditivo) em vez de
      // google_project_iam_binding (autoritativo) — evita duas roles bindings
      // pra mesma role brigarem pelos `members` quando a policy tem 2+
      // statements que mapeiam pro mesmo role.
      const roles = new Set<string>();
      for (const s of statements) {
        for (const action of (s.actions as string[]) ?? []) {
          roles.add(mapActionToRole(action));
        }
      }
      if (roles.size === 0) roles.add(FALLBACK_ROLE);
      let i = 0;
      for (const role of roles) {
        addResource(r, 'google_project_iam_member', `${id}_member_${i}`, {
          project: '${var.project_id}',
          role,
          member: `serviceAccount:\${google_service_account.${saId}.email}`,
        });
        i++;
      }
      return true;
    }

    default:
      return false;
  }
}
