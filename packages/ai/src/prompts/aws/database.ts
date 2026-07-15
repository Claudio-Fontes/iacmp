export const DATABASE_AWS = `
## Regras AWS — Database (DynamoDB, RDS, Aurora)

SEMPRE defina \`partitionKeyType\`/\`sortKeyType\` (e o equivalente nos GSIs) de acordo com o tipo real do dado — ex: \`id: number\` no payload da aplicação → \`partitionKeyType: 'N'\`. Na AWS, DynamoDB rejeita em runtime (\`ValidationException: Type mismatch\`) qualquer escrita/leitura cujo tipo do valor não bata com o tipo declarado na tabela — não dá pra simplesmente enviar um número numa chave declarada como string. Ao alterar o tipo de uma chave existente que já tenha dados, avise no \`warnings\` que a tabela precisa ser recriada (chave primária não é alterável em uma tabela existente).

**REGRA — GSI: só consulte índice que a tabela declara.** Se um handler faz \`QueryCommand({ IndexName: 'X', ... })\`, a \`Database.DynamoDB\` TEM que declarar esse índice em \`globalSecondaryIndexes\` E a Policy.IAM deve liberar \`<TableArn>/index/*\`. Para limpeza por TTL use \`ScanCommand + FilterExpression\` (sem GSI). **PALAVRAS RESERVADAS** (\`name\`, \`status\`, \`date\`, \`timestamp\`, \`ttl\`, etc.) precisam de alias: \`FilterExpression: '#name = :n', ExpressionAttributeNames: { '#name': 'name' }\` — na dúvida, sempre aliase.

**REGRA — DynamoDB UpdateExpression: SEMPRE use \`ExpressionAttributeNames\`.**
\`name\`, \`item\`, \`value\`, \`status\`, \`size\`, \`type\` são palavras reservadas. Um \`SET name = :name\` quebra em runtime com \`ValidationException\`.
Padrão obrigatório no handler de update:
\`\`\`typescript
const fields = Object.entries(body).filter(([k]) => k !== 'id');
const expr = 'SET ' + fields.map(([k], i) => \`#f\${i} = :v\${i}\`).join(', ');
const names: Record<string,string> = {}; const vals: Record<string,unknown> = {};
fields.forEach(([k, v], i) => { names[\`#f\${i}\`] = k; vals[\`:v\${i}\`] = v; });
await doc.send(new UpdateCommand({ TableName: process.env.TABLE_NAME, Key: { id },
  UpdateExpression: expr, ExpressionAttributeNames: names, ExpressionAttributeValues: vals }));
\`\`\`
NUNCA escreva \`SET fieldName = :fieldName\` direto sem \`ExpressionAttributeNames\`.

**REGRA — DynamoDB para CRUD simples por ID: NUNCA gere \`sortKey\`.**
Um CRUD que acessa itens por ID usa APENAS \`partitionKey: 'id'\`. \`sortKey\` só existe quando o prompt pede explicitamente acesso por chave composta (ex: "listar por usuário e data"). Se a tabela tem \`sortKey: 'createdAt'\`, os handlers DEVEM incluir \`Key: { id, createdAt }\` — se você não puder garantir o \`createdAt\` nos handlers, NÃO coloque \`sortKey\` na tabela.

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

**REGRA — Policy.IAM cobre TODOS os SDK commands do handler.** Ações frequentemente esquecidas: \`PutCommand→dynamodb:PutItem\`, \`UpdateCommand→dynamodb:UpdateItem\`, \`DeleteCommand→dynamodb:DeleteItem\`. Handler com seed + leitura precisa de ambas as actions. Falta de action causa \`AccessDeniedException\` silencioso em runtime.
`;
