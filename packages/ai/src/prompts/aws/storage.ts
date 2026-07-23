export const STORAGE_AWS = `
## Regras AWS — Storage (S3)

**REGRA ABSOLUTA — acesso a Storage.Bucket usa o facade \`@iacmp/runtime\`, NUNCA \`@aws-sdk/client-s3\`/\`@aws-sdk/s3-request-presigner\` direto:**
\`\`\`typescript
import { blob } from '@iacmp/runtime';
const b = blob(process.env.BUCKET_NAME!);
await b.put(key, body, { contentType });          // upload
const obj = await b.get(key);                     // → { body: Buffer, contentType? } | null
await b.delete(key);
const keys = await b.list(prefix);
const putUrl = await b.presignPut(key);           // URL pré-assinada de upload
const getUrl = await b.presignGet(key);           // URL pré-assinada de download
\`\`\`
\`blob(name)\` aceita QUALQUER nome de bucket — inclusive o bucket-origem vindo de \`record.s3.bucket.name\` num trigger (não precisa ser um \`ref()\` de env var). Só volte para o SDK cru quando o cenário exigir algo que o facade NÃO cobre: \`StorageClass\` (ex: \`DEEP_ARCHIVE\`), Object Lock, multipart upload, ou leitura de metadados sem baixar o body (\`HeadObjectCommand\`).

**REGRA — CORS do S3:** para permitir upload/download do browser (presigned URL, SPA), use a prop \`cors\` DO PRÓPRIO \`Storage.Bucket\`: \`cors: [{ allowedMethods: ['GET','PUT','POST'], allowedOrigins: ['*'], allowedHeaders: ['*'] }]\` — o synth gera a \`CorsConfiguration\` no bucket. NUNCA implemente CORS com \`Custom.Resource\` / \`AWS::S3::BucketPolicy\` (BucketPolicy é controle de ACESSO, não CORS; e o preflight OPTIONS do browser não funciona assim).
**REGRA — nome do bucket para os handlers:** a env var com o nome do bucket (ex: \`BUCKET_NAME\`) usa \`ref('MeuBucket', 'Name')\` — NUNCA \`ref('MeuBucket','Arn')\` (o ARN não é aceito como Bucket nas chamadas do SDK S3). Atributos válidos do \`Storage.Bucket\`: \`Arn\` (para Policy.IAM resources) e \`Name\` (para o SDK).
**REGRA — Policy.IAM para S3 (bucket + objetos):** um \`ref()\` é um OBJETO, NUNCA concatene com string (\`ref('B','Arn') + '/*'\` vira \`"[object Object]/*"\` e o deploy falha). Para o bucket em si use \`ref('MeuBucket','Arn')\`; para os OBJETOS dentro dele use a STRING \`'MeuBucket/*'\` (o synth resolve para \`<arn>/*\`). Ex: \`resources: [ref('MeuBucket','Arn'), 'MeuBucket/*']\`.
**REGRA — s3:DeleteObject obrigatório quando o handler "move" arquivo:** se o handler faz CopyObject + DeleteObject (padrão "mover arquivo de um bucket para outro"), o \`Policy.IAM\` do bucket de ORIGEM deve incluir \`s3:DeleteObject\` além de \`s3:GetObject\`. Sem essa permissão o deploy sobe mas o Lambda recebe AccessDenied no delete e o arquivo fica no bucket de origem. Ex: \`actions: ['s3:GetObject', 's3:DeleteObject']\` no statement do bucket de origem.
**REGRA — CORS no Fn.ApiGateway com upload do browser:** se o projeto tem \`Storage.Bucket\` com \`cors\`, o \`Fn.ApiGateway\` TAMBÉM precisa de \`cors: true\` — senão o preflight OPTIONS do browser dá 404 no gateway. Para REST API (\`type: 'REST'\`) o \`cors: true\` só gera o OPTIONS+MOCK; os handlers reais (POST/GET/DELETE) DEVEM devolver o header: \`headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }\`. (HTTP API cobre tudo pelo CorsConfiguration — o handler não precisa do header.)
**REGRA — path param de key S3 com barra:** se a key do objeto pode conter \`/\` (ex: \`uploads/123.png\`), a rota \`DELETE /files/{key}\` NÃO captura a barra (404). Use greedy \`{key+}\`. No handler: \`const key = event.pathParameters?.key ?? '';\` — NUNCA \`event.pathParameters.key\` sem \`?.\` (se for null, explode com "Cannot read properties of null").
**REGRA — pipeline "S3 dispara Lambda" (ObjectCreated):** quando uma Lambda deve ser ACIONADA por upload de arquivo no S3, declare o trigger em \`Storage.Bucket.eventNotifications: [{ lambdaId: 'MinhaFn', events: ['s3:ObjectCreated:*'] }]\` — o synth gera a NotificationConfiguration e a Lambda::Permission. NUNCA exponha essa Lambda por \`Fn.ApiGateway\` (o pipeline dispara sozinho no upload, não por HTTP) e NÃO invente rotas HTTP. O handler recebe o evento S3; o NOME DO BUCKET vem de \`record.s3.bucket.name\` (não de env var) e a KEY vem de \`record.s3.object.key\`. Exemplo de handler:
\`\`\`typescript
import { blob } from '@iacmp/runtime';

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    // ORIGEM (bucket-trigger): SEMPRE do evento — NUNCA process.env.RAW_BUCKET_NAME (o synth omite essa env var pra evitar o ciclo CFN; em runtime ela seria undefined)
    const bucketName = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\\+/g, ' '));  // '+' vira espaço; key vem URL-encoded

    const obj = await blob(bucketName).get(key);
    const body = obj?.body.toString();
    // ... processa ...

    // DESTINO (bucket SEM trigger, outra stack): PODE vir de env var via ref('ProcessedBucket','Name')
    await blob(process.env.PROCESSED_BUCKET_NAME!).put(key, body ?? '');
  }
};
\`\`\`
**REGRA CRÍTICA — SÓ o bucket-trigger + a Lambda-alvo ficam juntos (NÃO é um monolito):** a restrição de "mesma stack" vale EXCLUSIVAMENTE para o PAR \`Storage.Bucket\` que tem \`eventNotifications\` + a \`Fn.Lambda\` acionada por ele (mais a \`Policy.IAM\` dessa Lambda). Motivo: o bucket precisa do ARN da Lambda (pra NotificationConfiguration) E a Lambda precisa do ARN/nome do bucket (pro handler ler/escrever e pra IAM) — se ficarem em stacks separadas isso vira uma DEPENDÊNCIA CIRCULAR cross-stack (bucket→lambda e lambda→bucket via Fn::ImportValue) que trava o deploy. **TODO O RESTO fica em stacks separadas** (uma camada por arquivo): VPC/subnets → \`stacks/network/\`; DynamoDB/RDS → \`stacks/database/\`; buckets SEM trigger (ex: bucket de saída/destino onde a Lambda só ESCREVE) → sua própria \`stacks/storage/\`. A Lambda referencia esses recursos cross-stack via env vars com \`ref('MinhaTabela','Name')\` / \`ref('ProcessedBucket','Name')\` — isso é OK e NÃO cria ciclo (a dependência é unidirecional: só a Lambda depende deles, eles não dependem da Lambda). **NUNCA junte VPC + buckets + DynamoDB + Lambda num único arquivo** — a validação semântica barra isso como monolito (mistura de camadas).

**REGRA — NUNCA coloque o bucket-trigger como env var da Lambda:** o bucket-trigger (mesmo stack) NÃO deve aparecer no \`environment\` da Lambda (ex: \`RAW_BUCKET_NAME: ref('RawDataBucket','Name')\`). Isso cria a dependência circular Lambda→Bucket que o CFN rejeita. O handler obtém o nome do bucket via evento S3: \`event.Records[0].s3.bucket.name\` — não precisa de env var. Buckets de SAÍDA (outra stack) SIM podem aparecer como env var: \`PROCESSED_BUCKET_NAME: ref('ProcessedBucket','Name')\`.

Exemplo de split correto para "S3 (raw) → Lambda → DynamoDB, gravando também em bucket processado":
- \`stacks/pipeline/pipeline-stack.ts\`: \`Storage.Bucket\` (RawDataBucket **com** eventNotifications) + \`Fn.Lambda\` (DataProcessorFn, environment **SEM** RAW_BUCKET_NAME) + \`Policy.IAM\` — o par acoplado.
- \`stacks/storage/storage-stack.ts\`: \`Storage.Bucket\` (ProcessedBucket, **sem** trigger) — a Lambda só escreve nele via \`ref('ProcessedBucket','Name')\`.
- \`stacks/database/database-stack.ts\`: \`Database.DynamoDB\` (ProcessedDataTable) — a Lambda escreve via \`ref('ProcessedDataTable','Name')\`.
- (se houver VPC) \`stacks/network/network-stack.ts\`: \`Network.Vpc\` + endpoints — em arquivo próprio.
`;
