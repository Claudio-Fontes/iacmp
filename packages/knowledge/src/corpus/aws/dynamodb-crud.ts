import type { Example } from '../index.js';

export const dynamodbCrud: Example = {
  id: 'aws-dynamodb-crud',
  title: 'DynamoDB CRUD com Lambda + API Gateway',
  tags: ['aws', 'dynamodb', 'lambda', 'crud', 'api-gateway', 'policy-iam'],
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

    'stacks/compute/api-stack.ts': `import { Stack, Fn, Policy, ref } from '@iacmp/core';
const stack = new Stack('items-api');
new Fn.Lambda(stack, 'CreateItemFn', {
  runtime: 'nodejs20',
  handler: 'dist/createItem.handler',
  code: '.',
  environment: { TABLE_NAME: ref('ItemsTable', 'Name') },
});
new Fn.Lambda(stack, 'GetItemFn', {
  runtime: 'nodejs20',
  handler: 'dist/getItem.handler',
  code: '.',
  environment: { TABLE_NAME: ref('ItemsTable', 'Name') },
});
new Fn.Lambda(stack, 'ListItemsFn', {
  runtime: 'nodejs20',
  handler: 'dist/listItems.handler',
  code: '.',
  environment: { TABLE_NAME: ref('ItemsTable', 'Name') },
});
new Fn.Lambda(stack, 'UpdateItemFn', {
  runtime: 'nodejs20',
  handler: 'dist/updateItem.handler',
  code: '.',
  environment: { TABLE_NAME: ref('ItemsTable', 'Name') },
});
new Fn.Lambda(stack, 'DeleteItemFn', {
  runtime: 'nodejs20',
  handler: 'dist/deleteItem.handler',
  code: '.',
  environment: { TABLE_NAME: ref('ItemsTable', 'Name') },
});
new Policy.IAM(stack, 'CreateItemFnPolicy', {
  attachTo: 'CreateItemFn', attachType: 'lambda',
  statements: [{ effect: 'Allow', actions: ['dynamodb:PutItem'], resources: [ref('ItemsTable', 'Arn')] }],
});
new Policy.IAM(stack, 'GetItemFnPolicy', {
  attachTo: 'GetItemFn', attachType: 'lambda',
  statements: [{ effect: 'Allow', actions: ['dynamodb:GetItem'], resources: [ref('ItemsTable', 'Arn')] }],
});
new Policy.IAM(stack, 'ListItemsFnPolicy', {
  attachTo: 'ListItemsFn', attachType: 'lambda',
  statements: [{ effect: 'Allow', actions: ['dynamodb:Scan'], resources: [ref('ItemsTable', 'Arn')] }],
});
new Policy.IAM(stack, 'UpdateItemFnPolicy', {
  attachTo: 'UpdateItemFn', attachType: 'lambda',
  statements: [{ effect: 'Allow', actions: ['dynamodb:UpdateItem'], resources: [ref('ItemsTable', 'Arn')] }],
});
new Policy.IAM(stack, 'DeleteItemFnPolicy', {
  attachTo: 'DeleteItemFn', attachType: 'lambda',
  statements: [{ effect: 'Allow', actions: ['dynamodb:DeleteItem'], resources: [ref('ItemsTable', 'Arn')] }],
});
export default stack;`,

    'stacks/network/api-gateway-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('items-gw');
new Fn.ApiGateway(stack, 'ItemsApi', {
  name: 'items-api', type: 'HTTP', cors: true,
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
const t = table(process.env.TABLE_NAME!);
export const handler = async (event: any) => {
  const body = JSON.parse(event.body ?? '{}');
  const id = body.id ?? crypto.randomUUID();
  await t.put({ id, ...body });
  return { statusCode: 201, body: JSON.stringify({ id, ...body }), headers: { 'Access-Control-Allow-Origin': '*' } };
};`,
    'src/getItem.ts': `import { table } from '@iacmp/runtime';
const t = table(process.env.TABLE_NAME!);
export const handler = async (event: any) => {
  const id = event.pathParameters?.id ?? '';
  const item = await t.get(id);
  if (!item) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
  return { statusCode: 200, body: JSON.stringify(item), headers: { 'Access-Control-Allow-Origin': '*' } };
};`,
    'src/listItems.ts': `import { table } from '@iacmp/runtime';
const t = table(process.env.TABLE_NAME!);
export const handler = async () => {
  const items = await t.list();
  return { statusCode: 200, body: JSON.stringify(items), headers: { 'Access-Control-Allow-Origin': '*' } };
};`,
    'src/updateItem.ts': `import { table } from '@iacmp/runtime';
const t = table(process.env.TABLE_NAME!);
export const handler = async (event: any) => {
  const id = event.pathParameters?.id ?? '';
  const body = JSON.parse(event.body ?? '{}');
  await t.put({ id, ...body });
  return { statusCode: 200, body: JSON.stringify({ id, ...body }), headers: { 'Access-Control-Allow-Origin': '*' } };
};`,
    'src/deleteItem.ts': `import { table } from '@iacmp/runtime';
const t = table(process.env.TABLE_NAME!);
export const handler = async (event: any) => {
  const id = event.pathParameters?.id ?? '';
  await t.delete(id);
  return { statusCode: 200, body: JSON.stringify({ deleted: id }), headers: { 'Access-Control-Allow-Origin': '*' } };
};`,
  },
  notes: [
    'Policy.IAM usa ref(TableId, "Arn") — NUNCA string "NomeTabela" nem "NomeTabela/*"',
    'Policy separada por Lambda — nunca uma única policy compartilhada',
    'Handler usa o facade @iacmp/runtime (table()) — NUNCA @aws-sdk/client-dynamodb nem @aws-sdk/lib-dynamodb diretamente',
    'table().put faz upsert por "id" — só serve para tabelas com partitionKey: "id" e SEM sortKey',
    'crypto.randomUUID() para id — não uuid de lib externa',
  ],
};
