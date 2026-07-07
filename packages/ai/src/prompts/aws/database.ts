export const DATABASE_AWS = `
## Regras AWS — Database (DynamoDB, RDS, Aurora)

SEMPRE defina \`partitionKeyType\`/\`sortKeyType\` (e o equivalente nos GSIs) de acordo com o tipo real do dado — ex: \`id: number\` no payload da aplicação → \`partitionKeyType: 'N'\`. Na AWS, DynamoDB rejeita em runtime (\`ValidationException: Type mismatch\`) qualquer escrita/leitura cujo tipo do valor não bata com o tipo declarado na tabela — não dá pra simplesmente enviar um número numa chave declarada como string. Ao alterar o tipo de uma chave existente que já tenha dados, avise no \`warnings\` que a tabela precisa ser recriada (chave primária não é alterável em uma tabela existente).

**REGRA — GSI: só consulte índice que a tabela declara.** Se um handler faz \`QueryCommand({ IndexName: 'X', ... })\`, a \`Database.DynamoDB\` correspondente TEM que declarar esse índice em \`globalSecondaryIndexes\` (com o mesmo \`name: 'X'\`) E a Policy.IAM da Lambda tem que liberar \`<TableArn>/index/*\` além do ARN da tabela — senão o deploy sobe mas a query estoura \`ValidationException: The table does not have the specified index\` em runtime. Para **limpeza por TTL / itens expirados NÃO crie um GSI**: use \`ScanCommand\` + \`FilterExpression\` — e o writer que grava os itens precisa gravar o atributo \`ttl\` (epoch em segundos) para que algo de fato expire. **CUIDADO — \`ttl\` é PALAVRA RESERVADA no DynamoDB** (assim como \`name\`, \`status\`, \`date\`, \`timestamp\`, \`type\`, \`data\`, \`value\`, \`count\`, \`size\`, \`user\`, \`source\`, \`region\`, \`year\`, \`month\`, \`day\`, \`state\`, \`group\`, \`role\`, \`order\`, \`key\`, \`range\`, \`hour\`, \`minute\`, \`second\`, \`time\`, \`token\` e centenas de outras): usar o nome cru numa \`FilterExpression\`/\`KeyConditionExpression\`/\`ConditionExpression\` estoura \`ValidationException: Attribute name is a reserved keyword\` em runtime. SEMPRE aliase com \`ExpressionAttributeNames\` e use o \`#alias\` na expressão:
\`\`\`ts
await doc.send(new ScanCommand({
  TableName: 'ReportsTable',
  FilterExpression: '#ttl < :now',
  ExpressionAttributeNames: { '#ttl': 'ttl' },
  ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000) },
}));
\`\`\`
Na dúvida sobre um nome de atributo, aliase — atributos comuns como \`date\` (que pode ser sua sortKey!), \`name\`, \`status\` são todos reservados e exigem \`#\`.

**REGRA Aurora**: sempre informe subnetIds (2 subnets em AZs diferentes) e securityGroupIds. Aurora sem subnets só funciona em contas com VPC default — nunca adequado para produção. A senha é gerada automaticamente no Secrets Manager e injetada no cluster via resolve:secretsmanager.

**REGRA ABSOLUTA — secret do banco é automático**: \`Database.SQL\` e \`Database.DocumentDB\` JÁ criam o secret da senha no Secrets Manager sozinhos. NUNCA crie um \`Secret.Vault\` nem \`Custom.Resource\` do tipo \`AWS::SecretsManager::Secret\` para a senha do banco — é redundante e fica desconectado do banco. As Lambdas acessam o secret automático via as env vars \`<DbId>.Password\`/\`<DbId>.SecretArn\` (ver regra de env vars de banco).

**REGRA ABSOLUTA — dados iniciais vão no handler, NUNCA no CloudFormation**: CloudFormation não tem recurso nativo para inserir itens no DynamoDB. NUNCA use \`Custom.Resource\` com \`type: 'AWS::DynamoDB::Table'\` nem qualquer propriedade \`Item\` nesse tipo — isso é inválido e o deploy falha com \`AWS::EarlyValidation::PropertyValidation\`. Para dados de seed (ex: inserir item com id=1 na primeira chamada), faça no handler com \`PutCommand\` + \`ConditionExpression: 'attribute_not_exists(id)'\` (idempotente — não sobrescreve se já existir):
\`\`\`typescript
await docClient.send(new PutCommand({
  TableName: process.env.TABLE_NAME,
  Item: { id: 1, message: 'Hello World' },
  ConditionExpression: 'attribute_not_exists(id)',
})).catch(() => {}); // ignora ConditionalCheckFailedException se já existir
\`\`\`

**REGRA — handler que conecta no DocumentDB (driver \`mongodb\`):** o handler NÃO pode ter connection string hardcoded nem placeholder — monte a URI a partir das env vars. Passe nas env vars da Lambda: \`DB_HOST: '<DbId>.Endpoint'\`, \`DB_PORT: '<DbId>.Port'\`, \`DB_PASSWORD: '<DbId>.Password'\` (dynamic-ref resolvido no deploy — NÃO buscar do Secrets Manager em runtime, que uma Lambda em subnet privada sem NAT não alcança), \`DB_USER: 'docdbadmin'\`, \`DB_NAME: 'documents'\`. DocumentDB EXIGE TLS e NÃO suporta retryable writes. Padrão (o cliente fora do handler, reusa conexão):
\`\`\`typescript
import { MongoClient } from 'mongodb';
import * as fs from 'fs';
// DocumentDB exige o CA bundle da Amazon RDS — baixe global-bundle.pem e inclua no deploy (ver nextSteps).
const uri = \`mongodb://\${process.env.DB_USER}:\${encodeURIComponent(process.env.DB_PASSWORD!)}@\${process.env.DB_HOST}:\${process.env.DB_PORT}/?tls=true&tlsCAFile=global-bundle.pem&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false\`;
let client: MongoClient;
async function db() { if (!client) client = await MongoClient.connect(uri); return client.db(process.env.DB_NAME); }
\`\`\`
Em \`nextSteps\`: avisar que o \`global-bundle.pem\` (CA da RDS) precisa ser baixado (\`curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem\`) e empacotado junto ao handler. (DocumentDB fica DENTRO da VPC — não precisa de VpcEndpoint; a Lambda alcança pela subnet privada + SG na porta 27017.)

**REGRA — handler que conecta no PostgreSQL (driver \`pg\`) DEVE inicializar o schema:** inclua um bloco de \`CREATE TABLE IF NOT EXISTS\` no cold start (fora do handler, executado uma vez por container), garantindo que a tabela existe antes da primeira query. Sem isso, a Lambda vai com erro \`relation "X" does not exist\` no primeiro acesso pós-deploy. Padrão:
\`\`\`typescript
import { Pool } from 'pg';
const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, ssl: { rejectUnauthorized: false } });
let initialized = false;
async function ensureSchema() {
  if (initialized) return;
  await pool.query(\`CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, ...)\`);
  initialized = true;
}
export async function handler(event: any) {
  await ensureSchema();
  // ... lógica do handler
}
\`\`\`
Use \`Pool\` (não \`Client\`) para reutilizar conexões entre invocações no mesmo container — evita overhead de conexão a cada invocação.
`;
