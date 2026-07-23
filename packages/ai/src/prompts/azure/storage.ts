export const STORAGE_AZURE = `
## Regras Azure — Storage (Blob Storage)

**REGRA ABSOLUTA AZURE — Storage.Bucket usa o facade \`@iacmp/runtime\` (NUNCA @azure/storage-blob nem @azure/data-tables direto)**

**Storage.Bucket ≠ Database.DynamoDB.** São constructs DISTINTOS, ambos acessados pelo MESMO facade neutro (\`@iacmp/runtime\`), cada um com sua função:
- \`Storage.Bucket\` → Azure Blob Storage → handler usa \`blob(process.env.BUCKET_NAME!)\` + env \`BUCKET_NAME: ref('MeuBucket','Name')\`
- \`Database.DynamoDB\` → Cosmos DB MongoDB API → handler usa \`table(process.env.TABLE_NAME!)\` + env \`TABLE_NAME: ref('MinhaTabela','Name')\` (o synth injeta \`MONGO_URI\`/\`DB_NAME\` automaticamente)

**NUNCA use \`@azure/data-tables\` para \`Storage.Bucket\`.** Gerar \`COSMOS_CONNECTION\` ou \`TABLE_NAME\` para um \`Storage.Bucket\` é ERRO.

Padrão obrigatório para upload/download de arquivo com \`Storage.Bucket\` no Azure:
\`\`\`typescript
import { blob } from '@iacmp/runtime';
const b = blob(process.env.BUCKET_NAME!);
await b.put(key, body, { contentType });          // upload
const obj = await b.get(key);                     // → { body: Buffer, contentType? } | null
await b.delete(key);
const keys = await b.list(prefix);
const putUrl = await b.presignPut(key);           // SAS de upload
const getUrl = await b.presignGet(key);           // SAS de download
\`\`\`

- Env var ÚNICA para Blob: \`BUCKET_NAME: ref('MeuBucket','Name')\`. NÃO declare \`BLOB_CONNECTION\`/\`COSMOS_CONNECTION\`/\`TABLE_NAME\` manualmente — o synth Azure detecta o \`ref()\` e injeta a \`{CHAVE}_CONNECTION_STRING\` que o facade lê sozinho.
- **Atributos válidos de \`ref()\` para \`Storage.Bucket\`:** \`Arn, Name, ConnectionString\` (\`ConnectionString\` só é necessária no fallback de driver bruto, ver abaixo).
- Frontend estático no Azure = \`Storage.Bucket\` (privado) + \`Network.CDN\` com \`bucketRef\`, MESMA stack — igual à AWS. CDN NUNCA é um \`Storage.Bucket\`; cada construct id aparece UMA vez por stack.
- **Fallback para \`@azure/storage-blob\` direto — SOMENTE quando o cenário exigir container NOMEADO distinto do padrão do facade (ex: pipeline com múltiplos containers/storage accounts) ou geração manual de SAS com permissões customizadas.** Nesses casos use \`BlobServiceClient.fromConnectionString\` + env \`BLOB_CONNECTION: ref('MeuBucket','ConnectionString')\`, sempre chamando \`createIfNotExists\` no container (não existe por padrão). Getter do bucket é \`bucket.name\` — \`bucket.bucketName\` NÃO existe.

**REGRA CRÍTICA AZURE — pipeline "Blob dispara Lambda" (BlobCreated via Event Grid):** quando um \`Storage.Bucket\` tem \`eventNotifications\` apontando para uma \`Fn.Lambda\` (Container App), ambos DEVEM ficar na MESMA stack. Motivo: o Event Grid subscription precisa do FQDN da Lambda (bucket→lambda) E a Lambda precisa das credenciais do bucket via env vars (lambda→bucket) — se ficarem em stacks separadas cria DEPENDÊNCIA CIRCULAR cross-stack que o deploy bloqueia. Apenas o PAR acoplado fica junto; todo o resto fica em stacks separadas:
- \`stacks/pipeline/pipeline-stack.ts\`: \`Storage.Bucket\` (RawDataBucket **com** eventNotifications) + \`Fn.Lambda\` (DataProcessorFn) + \`Policy.IAM\` — o par acoplado.
- \`stacks/storage/storage-stack.ts\`: \`Storage.Bucket\` (ProcessedBucket, **sem** trigger) — a Lambda só escreve nele via \`ref('ProcessedBucket','Name')\` (facade) ou \`ref('ProcessedBucket','ConnectionString')\` (fallback de driver bruto).
- \`stacks/database/database-stack.ts\`: \`Database.DynamoDB\` (Cosmos MongoDB API) — a Lambda acessa via \`ref('MinhaTabela','Name')\` (auto-injeta \`MONGO_URI\`/\`DB_NAME\`).
**NUNCA coloque o bucket-trigger como env var separada da Lambda (ex: \`RAW_BUCKET_NAME: ref('RawDataBucket','Name')\`) quando ambos estão na mesma stack** — é redundante e o synth pode resolver via evento. Buckets de SAÍDA (outra stack) SIM podem aparecer como env var.

**FORMATO DO EVENTO — handler do blob trigger:** o runtime Azure converte o evento Event Grid para o MESMO formato S3 da AWS. O handler DEVE usar \`record.s3.object.key\` (nome do blob) e \`record.s3.bucket.name\` (nome do container). NÃO use \`record.blob.name\`, \`record.data\` ou qualquer outro formato — SOMENTE o formato S3.

**Este cenário (múltiplos containers/storage accounts no mesmo handler) é o fallback de driver bruto** — o facade \`@iacmp/runtime\` usa um container fixo por bucket e não cobre pipelines com container de origem dinâmico (\`record.s3.bucket.name\`) + container \`'processed'\` num segundo storage account. Use \`@azure/storage-blob\`/\`mongodb\` diretamente como abaixo:

\`\`\`typescript
// src/dataProcessor.ts — handler do blob trigger (BlobCreated via Event Grid)
import { BlobServiceClient } from '@azure/storage-blob';
import { MongoClient } from 'mongodb';

let mongo: MongoClient | null = null;
async function getCollection() {
  if (!mongo) { mongo = new MongoClient(process.env.MONGO_URI!); await mongo.connect(); }
  return mongo.db(process.env.DB_NAME).collection(process.env.TABLE_NAME!);
}

export async function handler(event: any) {
  const records = event.Records || [];
  const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION!);
  const processedBlobServiceClient = BlobServiceClient.fromConnectionString(process.env.PROCESSED_BLOB_CONNECTION!);
  const col = await getCollection();

  for (const record of records) {
    // OBRIGATÓRIO: usar record.s3.object.key (não record.blob.name!)
    const blobName = record.s3.object.key;
    const containerName = record.s3.bucket.name;

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const response = await blockBlobClient.downloadToBuffer();
    const data = JSON.parse(response.toString());

    // Gravar no Cosmos DB MongoDB API (Database.DynamoDB no Azure)
    const id = data.id || Date.now().toString();
    await col.replaceOne({ id }, { id, ...data }, { upsert: true });

    // Mover para bucket processado
    const processedContainerClient = processedBlobServiceClient.getContainerClient('processed');
    await processedContainerClient.createIfNotExists();
    const destBlobClient = processedContainerClient.getBlockBlobClient(blobName);
    await destBlobClient.uploadData(response);
    await blockBlobClient.delete();
  }
  return { statusCode: 200, body: '' };
}
\`\`\`

**REGRA — DR (disaster recovery) de Storage no Azure:** quando o usuário pedir bucket de DR/failover regional, use \`replication: 'geo'\` no Storage.Bucket — vira RA-GRS: a PLATAFORMA replica para a região pareada (par fixo do Azure, não configurável) e expõe um endpoint secundário somente-leitura (output \`ref('MeuBucket','SecondaryEndpoint')\`). NÃO crie um segundo Storage.Bucket manual para DR — na Azure a replicação geo é nativa da conta. Adicione em warnings que o failover de leitura usa o endpoint \`-secondary\` e que a região do par é definida pelo Azure (não pelo azureDrRegion).
`;
