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
`;
