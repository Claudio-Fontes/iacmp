import type { Example } from '../index.js';

export const cosmosTableCrud: Example = {
  id: 'azure-cosmos-table-crud',
  title: 'Azure Cosmos DB MongoDB API (DynamoDB equivalente) com Lambda + APIM',
  tags: ['azure', 'cosmos', 'dynamodb', 'mongodb', 'lambda', 'crud', 'apim'],
  validated: true,
  stacks: {
    'stacks/database/items-stack.ts': `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('items-db');
new Database.DynamoDB(stack, 'ItemsTable', {
  partitionKey: 'id',
  partitionKeyType: 'S',
  billingMode: 'PAY_PER_REQUEST',
});
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Fn, ref } from '@iacmp/core';
const stack = new Stack('items-api');
const env = {
  TABLE_NAME: ref('ItemsTable', 'Name'),
};
new Fn.Lambda(stack, 'CreateItemFn', { runtime: 'nodejs20', handler: 'dist/createItem.handler', code: '.', environment: env });
new Fn.Lambda(stack, 'GetItemFn',    { runtime: 'nodejs20', handler: 'dist/getItem.handler',    code: '.', environment: env });
new Fn.Lambda(stack, 'ListItemsFn',  { runtime: 'nodejs20', handler: 'dist/listItems.handler',  code: '.', environment: env });
new Fn.Lambda(stack, 'UpdateItemFn', { runtime: 'nodejs20', handler: 'dist/updateItem.handler', code: '.', environment: env });
new Fn.Lambda(stack, 'DeleteItemFn', { runtime: 'nodejs20', handler: 'dist/deleteItem.handler', code: '.', environment: env });
export default stack;`,

    'stacks/network/apim-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('items-gw');
new Fn.ApiGateway(stack, 'ItemsApi', {
  name: 'items-api', type: 'HTTP', cors: true,
  stageName: 'api',
  routes: [
    { method: 'POST',   path: '/items',      lambdaId: 'CreateItemFn' },
    { method: 'GET',    path: '/items',      lambdaId: 'ListItemsFn' },
    { method: 'GET',    path: '/items/{id}', lambdaId: 'GetItemFn' },
    { method: 'PUT',    path: '/items/{id}', lambdaId: 'UpdateItemFn' },
    { method: 'DELETE', path: '/items/{id}', lambdaId: 'DeleteItemFn' },
  ],
});
export default stack;`,
  },
  handlers: {
    'src/createItem.ts': `import { table } from '@iacmp/runtime';
import { randomUUID } from 'crypto';
const t = table(process.env.TABLE_NAME!);
export const handler = async (event: any) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});
  const id = randomUUID();
  await t.put({ id, ...body });
  return { statusCode: 201, body: JSON.stringify({ id, ...body }) };
};`,
    'src/listItems.ts': `import { table } from '@iacmp/runtime';
const t = table(process.env.TABLE_NAME!);
export const handler = async () => {
  const items = await t.list();
  return { statusCode: 200, body: JSON.stringify(items) };
};`,
    'src/getItem.ts': `import { table } from '@iacmp/runtime';
const t = table(process.env.TABLE_NAME!);
export const handler = async (event: any) => {
  const id = event.pathParameters?.id ?? event.path?.split('/').pop();
  const item = await t.get(id);
  if (!item) return { statusCode: 404, body: JSON.stringify({ error: 'não encontrado' }) };
  return { statusCode: 200, body: JSON.stringify(item) };
};`,
    'src/updateItem.ts': `import { table } from '@iacmp/runtime';
const t = table(process.env.TABLE_NAME!);
export const handler = async (event: any) => {
  const id = event.pathParameters?.id ?? event.path?.split('/').pop();
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});
  const { id: _id, ...rest } = body;
  await t.put({ id, ...rest });
  return { statusCode: 200, body: JSON.stringify({ id, ...rest }) };
};`,
    'src/deleteItem.ts': `import { table } from '@iacmp/runtime';
const t = table(process.env.TABLE_NAME!);
export const handler = async (event: any) => {
  const id = event.pathParameters?.id ?? event.path?.split('/').pop();
  await t.delete(id);
  return { statusCode: 204, body: '' };
};`,
  },
  notes: [
    'Azure: Database.DynamoDB vira Cosmos DB MongoDB API (kind: MongoDB) — NÃO Table API. env var ÚNICA: TABLE_NAME: ref("ItemsTable","Name") — o synth injeta MONGO_URI e DB_NAME automaticamente no Function App (o facade lê essas envs sozinho).',
    'Handler usa o facade @iacmp/runtime (table()) — NUNCA mongodb/MongoClient nem @azure/data-tables diretamente',
    'stageName: "api" no ApiGateway — NUNCA "" (string vazia causa 404)',
    'Chave de negócio é o campo "id" (string, gerado com randomUUID) — o facade já remove o _id interno do driver mongodb do retorno.',
    'table().get/delete NUNCA lançam quando o documento não existe (get retorna null) — não precisa tratar erro de driver.',
    'Policy.IAM NÃO é necessária no Azure para Cosmos — a connection string (MONGO_URI) já autentica',
    'NUNCA @aws-sdk/* nem @azure/data-tables/TableClient em projeto Azure',
  ],
};
