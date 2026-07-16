export const STORAGE_AZURE = `
## Regras Azure — Storage (Blob Storage)

**REGRA ABSOLUTA AZURE — Storage.Bucket usa @azure/storage-blob (NUNCA @azure/data-tables)**

**Storage.Bucket ≠ Database.DynamoDB.** São constructs DISTINTOS com SDKs DISTINTOS:
- \`Storage.Bucket\` → Azure Blob Storage → handler usa \`@azure/storage-blob\` + \`BlobServiceClient.fromConnectionString\` + env \`BLOB_CONNECTION: ref('MeuBucket','ConnectionString')\`
- \`Database.DynamoDB\` → Cosmos DB Table API → handler usa \`@azure/data-tables\` + env \`TABLE_CONNECTION: ref('MinhaTabela','ConnectionString')\`

**NUNCA use \`@azure/data-tables\` para \`Storage.Bucket\`.** Gerar \`COSMOS_CONNECTION\` ou \`TABLE_NAME\` para um \`Storage.Bucket\` é ERRO — o synth não consegue gerar upload/SAS para Cosmos. O container \`uploads\` NÃO existe por padrão — sempre chame \`createIfNotExists\` no handler.

Padrão obrigatório para upload de arquivo com \`Storage.Bucket\` no Azure:
\`\`\`typescript
import { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } from '@azure/storage-blob';
const svc = BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION!);
const container = svc.getContainerClient('uploads');
await container.createIfNotExists();                 // o container NÃO existe por padrão — criar sempre
// SAS: const cred = svc.credential as StorageSharedKeyCredential;
// generateBlobSASQueryParameters({ containerName:'uploads', blobName:key, permissions:BlobSASPermissions.parse('cw'), expiresOn:new Date(Date.now()+3e5) }, cred).toString()
\`\`\`

- Env var ÚNICA para Blob: \`BLOB_CONNECTION: ref('MeuBucket','ConnectionString')\`. NÃO gere COSMOS_CONNECTION/TABLE_NAME para bucket.
- Getter do bucket é \`bucket.name\` — \`bucket.bucketName\` NÃO existe.
- **Atributos válidos de \`ref()\` para \`Storage.Bucket\`:** \`Arn, Name, ConnectionString\` (\`ConnectionString\` = Blob Storage connection string, NÃO Cosmos).
- Frontend estático no Azure = \`Storage.Bucket\` (privado) + \`Network.CDN\` com \`bucketRef\`, MESMA stack — igual à AWS. CDN NUNCA é um \`Storage.Bucket\`; cada construct id aparece UMA vez por stack.

**REGRA CRÍTICA AZURE — pipeline "Blob dispara Lambda" (BlobCreated via Event Grid):** quando um \`Storage.Bucket\` tem \`eventNotifications\` apontando para uma \`Fn.Lambda\` (Container App), ambos DEVEM ficar na MESMA stack. Motivo: o Event Grid subscription precisa do FQDN da Lambda (bucket→lambda) E a Lambda precisa das credenciais do bucket via env vars (lambda→bucket) — se ficarem em stacks separadas cria DEPENDÊNCIA CIRCULAR cross-stack que o deploy bloqueia. Apenas o PAR acoplado fica junto; todo o resto fica em stacks separadas:
- \`stacks/pipeline/pipeline-stack.ts\`: \`Storage.Bucket\` (RawDataBucket **com** eventNotifications) + \`Fn.Lambda\` (DataProcessorFn) + \`Policy.IAM\` — o par acoplado.
- \`stacks/storage/storage-stack.ts\`: \`Storage.Bucket\` (ProcessedBucket, **sem** trigger) — a Lambda só escreve nele via \`ref('ProcessedBucket','ConnectionString')\`.
- \`stacks/database/database-stack.ts\`: \`Database.DynamoDB\` (CosmosDB) — a Lambda acessa via \`ref('MinhaTabela','ConnectionString')\`.
**NUNCA coloque o bucket-trigger como env var separada da Lambda (ex: \`RAW_BUCKET_NAME: ref('RawDataBucket','Name')\`) quando ambos estão na mesma stack** — é redundante e o synth pode resolver via evento. Buckets de SAÍDA (outra stack) SIM podem aparecer como env var.

**FORMATO DO EVENTO — handler do blob trigger:** o runtime Azure converte o evento Event Grid para o MESMO formato S3 da AWS. O handler DEVE usar \`record.s3.object.key\` (nome do blob) e \`record.s3.bucket.name\` (nome do container). NÃO use \`record.blob.name\`, \`record.data\` ou qualquer outro formato — SOMENTE o formato S3:

\`\`\`typescript
// src/dataProcessor.ts — handler do blob trigger (BlobCreated via Event Grid)
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient } from '@azure/data-tables';

export async function handler(event: any) {
  const records = event.Records || [];
  const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION!);
  const processedBlobServiceClient = BlobServiceClient.fromConnectionString(process.env.PROCESSED_BLOB_CONNECTION!);

  for (const record of records) {
    // OBRIGATÓRIO: usar record.s3.object.key (não record.blob.name!)
    const blobName = record.s3.object.key;
    const containerName = record.s3.bucket.name;

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const response = await blockBlobClient.downloadToBuffer();
    const data = JSON.parse(response.toString());

    // Gravar no Cosmos DB Table API
    // ATENÇÃO: 'id' é propriedade RESERVADA na Table API — excluir do spread antes de createEntity
    const { id: dataId, ...dataRest } = data;
    const tableClient = TableClient.fromConnectionString(process.env.COSMOS_CONNECTION!, process.env.TABLE_NAME!);
    await tableClient.createEntity({ partitionKey: 'items', rowKey: dataId || Date.now().toString(), ...dataRest });

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
