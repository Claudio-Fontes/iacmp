export const DATABASE_AZURE = `
## Regras Azure — Database (Cosmos DB Table API / Azure SQL)

### Escolha de construct no Azure (NUNCA troque)
- Cenário pede **documentos / MongoDB / blog posts / articles / posts / conteúdo não-estruturado / coleções de objetos JSON** → \`Database.DocumentDB\` (Cosmos MongoDB API). Handler usa driver \`mongodb\` com \`MongoClient\`. NUNCA \`@aws-sdk/*\` nem \`@azure/data-tables\` para MongoDB.
- Cenário pede **chave-valor simples / sessões / cache persistido / "DynamoDB"** → \`Database.DynamoDB\` (Cosmos Table API). Handler usa \`@azure/data-tables\`. NUNCA \`Database.DocumentDB\` para isso.
- Cenário pede PostgreSQL/MySQL → \`Database.SQL\` (vira Azure Database flexible server). O handler usa o driver \`pg\`/\`mysql2\` NORMAL (o protocolo é o mesmo do RDS) com \`ref('AppDB','Endpoint'/'Port'/'Password'/'Username')\` — NUNCA \`@azure/data-tables\` para SQL.
- **Atributos válidos de \`ref()\` por tipo (NÃO invente outros):** \`Database.SQL\` → \`Endpoint, Port, SecretArn, Password, Username\` (NÃO existe \`ConnectionString\`); \`Database.DynamoDB\` → \`Arn, Name, ConnectionString\` (Name = nome da TABELA); \`Database.DocumentDB\` → \`Endpoint, ConnectionString, SecretArn\` (use \`ConnectionString\` para a URI completa do MongoDB).
- **NUNCA concatene \`ref()\` com strings, NUNCA chame \`.toString()\` em \`ref()\`** — \`ref()\` retorna um objeto Ref, NÃO uma string. Tanto a concatenação com \`+\` quanto \`.toString()\` produzem \`[object Object]\` e quebram o deploy silenciosamente. Use \`ref()\` DIRETAMENTE como valor da env var: \`MONGO_URI: ref('MyDocDB', 'ConnectionString')\`.
- **Policy.IAM para \`Database.SQL\`: NÃO gere.** O acesso ao Postgres/MySQL é por usuário/senha via env vars — não existe IAM de data-plane. Só gere Policy.IAM quando o handler usa um serviço com IAM real (fila, storage, tabela NoSQL).
- **Policy.IAM para Cosmos DB no Azure: NÃO gere** — a connection string já autentica.

**REGRA ABSOLUTA — dados de seed vão no handler, NUNCA no Bicep/ARM**: Não existe recurso ARM nativo para inserir itens no Cosmos DB ou no PostgreSQL. NUNCA use \`Custom.Resource\` nem qualquer construct para isso. Para seed inicial: use \`createEntity\` (Cosmos Table) / \`upsert\` (MongoDB) / \`INSERT ... ON CONFLICT DO NOTHING\` (PostgreSQL) no próprio handler, com lógica idempotente na primeira chamada.

**REGRA CRÍTICA AZURE — DB_NAME:** O PostgreSQL Flexible Server cria apenas o banco \`postgres\` por padrão. NUNCA use o nome da aplicação como banco (ex: \`DB_NAME: 'products'\`, \`DB_NAME: 'myapp'\` → "database does not exist"). SEMPRE use \`DB_NAME: 'postgres'\` (o banco padrão) ou crie o banco no handler de inicialização com \`CREATE DATABASE IF NOT EXISTS\`.

**REGRA CRÍTICA AZURE — Database.SQL com Key Vault:** O handler usa \`process.env.DB_PASSWORD\` DIRETAMENTE — a plataforma Azure Container Apps resolve o Key Vault e injeta a senha como env var. NUNCA use \`DB_PASSWORD_SECRET_NAME\` nem chame o SDK do Key Vault em runtime para pegar a senha — isso é padrão AWS (Secrets Manager), NÃO Azure. O handler recebe \`DB_PASSWORD\` pronto para usar no \`new Client({ password: process.env.DB_PASSWORD })\`.

### EXEMPLO OBRIGATÓRIO — cenário SQL/PostgreSQL no Azure
\`\`\`typescript
// stacks/database/db-stack.ts
import { Stack, Database } from '@iacmp/core';
const stack = new Stack('db-stack');
new Database.SQL(stack, 'AppDB', { engine: 'postgres', size: 'small' });
export default stack;

// stacks/compute/api-stack.ts — env com refs VÁLIDOS de Database.SQL
import { Stack, Fn, ref } from '@iacmp/core';
const stack = new Stack('api-stack');
new Fn.Lambda(stack, 'ListItemsFn', {
  runtime: 'nodejs20', handler: 'dist/listItems.handler', code: '.',
  environment: {
    DB_HOST: ref('AppDB', 'Endpoint'),
    DB_PORT: ref('AppDB', 'Port'),
    DB_USER: ref('AppDB', 'Username'),
    DB_PASSWORD: ref('AppDB', 'Password'),
    DB_NAME: 'postgres',
  },
});
export default stack;
\`\`\`
\`\`\`typescript
// src/listItems.ts — handler SQL no Azure usa pg, NUNCA @azure/data-tables
import { Client } from 'pg';
export async function handler() {
  const db = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'postgres',
    ssl: { rejectUnauthorized: false },   // OBRIGATÓRIO — o servidor exige TLS
  });
  await db.connect();
  // REGRA: todos os handlers SQL criam a tabela no cold start (CREATE TABLE IF NOT EXISTS)
  // NUNCA omita isso em nenhum handler — POST antes de GET retorna 500 "relation does not exist"
  await db.query('CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, price NUMERIC(10,2))');
  const r = await db.query('SELECT * FROM items');
  await db.end();
  return { statusCode: 200, body: JSON.stringify(r.rows) };
}
\`\`\`

**REGRA CRÍTICA — CREATE TABLE em todos os handlers:** O PostgreSQL Flexible Server não cria tabelas automaticamente. Todo handler que acessa uma tabela DEVE executar \`CREATE TABLE IF NOT EXISTS\` antes de qualquer SELECT/INSERT/UPDATE/DELETE. Isso vale para TODOS os handlers (list, create, get, update, delete) — não só o de listagem.

### OBRIGATÓRIO — handlers com Database.DynamoDB usam o helper \`./tables\`, NUNCA @azure/data-tables cru
Todo projeto Azure com Database.DynamoDB recebe automaticamente um arquivo \`src/tables.ts\` (o iacmp injeta — você NÃO precisa criá-lo nem editá-lo). Ele expõe uma API simples por cima do Cosmos DB Table API, resolvendo as armadilhas do SDK (getEntity flat, 404 que lança, campos OData). **Gere TODOS os handlers de Database.DynamoDB importando esse helper** — NUNCA use \`TableClient\`/\`getEntity\`/\`createEntity\`/\`updateEntity\` diretamente.

API do helper (o único import de dados que os handlers precisam):
\`\`\`typescript
import { table } from './tables';   // caminho relativo à raiz de src/ (ajuste ../ se o handler estiver em subpasta)
const items = table('items');       // 'items' = partição fixa desta "tabela lógica"

await items.get(id)                          // → objeto com .id, ou null se não existe (nunca lança 404)
await items.put(id, { name, price })         // cria/sobrescreve
await items.put(id, { ... }, { ifNotExists: true })  // → false se já existe (não sobrescreve) — use p/ slug único, etc.
await items.update(id, { price: 9 })         // mescla campos (Merge)
await items.increment(id, 'clicks')          // contador atômico (+1); increment(id,'x',5,{seed}) cria se não existe
await items.del(id)                          // apaga (idempotente)
await items.list()                           // todos os itens da partição
await items.listByPrefix('dev#')             // itens cujo id começa com o prefixo (chaves compostas env#nome)
\`\`\`

Exemplo completo (CRUD + create com id gerado):
\`\`\`typescript
import { table } from './tables';
import { randomUUID } from 'crypto';
const items = table('items');

// CREATE
export async function handler(event: any) {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});
  const id = randomUUID();
  await items.put(id, body);
  return { statusCode: 201, body: JSON.stringify({ id, ...body }) };
}
// GET por id
export async function handler(event: any) {
  const item = await items.get(event.pathParameters?.id);
  if (!item) return { statusCode: 404, body: JSON.stringify({ error: 'não encontrado' }) };
  return { statusCode: 200, body: JSON.stringify(item) };
}
// LIST
export async function handler() {
  return { statusCode: 200, body: JSON.stringify(await items.list()) };
}
// UPDATE (merge) / DELETE
// await items.update(id, patch);  /  await items.del(id);
\`\`\`

O helper cuida de: id ↔ rowKey, remoção de campos OData, 404→null, contador atômico. Não replique essa lógica no handler.

### Env vars obrigatórias no Fn.Lambda que acessa Database.DynamoDB:
\`\`\`typescript
environment: {
  COSMOS_CONNECTION: ref('ItemsTable', 'ConnectionString'),
  TABLE_NAME: ref('ItemsTable', 'Name'),
}
\`\`\`

### Regras de partitionKey/rowKey:
- partitionKey: categoria fixa (ex: 'items') — NUNCA o id
- rowKey: id único do item (randomUUID() no create)
- listEntities() é AsyncIterable — use for await
- getEntity(partitionKey, rowKey) lança se não existir
- deleteEntity(partitionKey, rowKey)

### nextSteps obrigatório: inclua "npm install @azure/data-tables" e NÃO mencione @aws-sdk/*.

### Padrão obrigatório para Database.DocumentDB (Cosmos DB MongoDB API) no Azure

\`Database.DocumentDB\` no Azure vira \`Microsoft.DocumentDB/databaseAccounts\` com kind=MongoDB (o synth cria a database e a collection \`documents\` automaticamente).

**REGRA CRÍTICA:** A connection string é computada via \`listConnectionStrings()\` — NÃO é um endpoint simples. Passe \`ref('MyDocDB', 'ConnectionString')\` DIRETAMENTE como env var. NUNCA concatene com \`+\`.

\`\`\`typescript
// stacks/database/documentdb-stack.ts
import { Stack, Database } from '@iacmp/core';
const stack = new Stack('documentdb-stack');
new Database.DocumentDB(stack, 'MyDocDB', { instances: 1, deletionProtection: false });
export default stack;

// stacks/compute/lambda-stack.ts — env com ref DIRETA (NÃO concatene)
import { Stack, Fn, ref } from '@iacmp/core';
const stack = new Stack('lambda-stack');
new Fn.Lambda(stack, 'ListDocsFn', {
  runtime: 'nodejs20', handler: 'listDocs.handler', code: '.',
  environment: {
    MONGO_URI: ref('MyDocDB', 'ConnectionString'),  // URI completa com auth
    DB_NAME: 'mydocdb-db',                           // nome do banco no Cosmos
  },
});
export default stack;
\`\`\`

\`\`\`typescript
// src/listDocs.ts — handler MongoDB no Azure
import { MongoClient } from 'mongodb';

let client: MongoClient | null = null;

async function getClient() {
  if (!client) {
    client = new MongoClient(process.env.MONGO_URI!);
    await client.connect();
  }
  return client;
}

export async function handler() {
  const mongo = await getClient();
  const col = mongo.db(process.env.DB_NAME).collection('documents');
  const docs = await col.find({}).toArray();
  return { statusCode: 200, body: JSON.stringify(docs) };
}
\`\`\`

### Regras para Database.DocumentDB no Azure:
- A URI do MongoDB já contém credenciais — NÃO crie Secret.Vault para a senha
- Policy.IAM para DocumentDB: NÃO gere (connection string autentica)
- O nome do banco segue padrão \`<constructId.toLowerCase()>-db\` (ex: id=\`MyDocDB\` → banco \`mydocdb-db\`)
- A collection gerada automaticamente é \`documents\` — adapte ao cenário
- NUNCA use \`@azure/cosmos\` ou \`@azure/data-tables\` para MongoDB — use o driver \`mongodb\` nativo
`;

