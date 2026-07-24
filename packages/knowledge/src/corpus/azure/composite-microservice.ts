import type { Example } from '../index.js';

export const compositeMicroserviceAzure: Example = {
  id: 'azure-composite-microservice',
  title: 'Microsserviço composto Azure — APIM + Functions + Cosmos + Service Bus (4 domínios, 4 stacks)',
  tags: ['azure', 'microservice', 'composite', 'apim', 'function', 'cosmos', 'servicebus', 'queue'],
  validated: false,
  provider: 'azure',
  constructs: ['api-gateway', 'lambda', 'dynamodb', 'queue'],
  stacks: {
    // MESMO input agnóstico do exemplo AWS — o synth mapeia por cloud:
    // Database.DynamoDB→Cosmos (Mongo API), Messaging.Queue→Service Bus,
    // Fn.ApiGateway→APIM, Fn.Lambda→Azure Functions. Uma stack por domínio.
    'stacks/database/orders-db-stack.ts': `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('orders-db');
new Database.DynamoDB(stack, 'Orders', { partitionKey: 'id' });
export default stack;`,

    'stacks/messaging/order-queue-stack.ts': `import { Stack, Messaging } from '@iacmp/core';
const stack = new Stack('order-queue');
new Messaging.Queue(stack, 'OrderQueue', { visibilityTimeoutSeconds: 60 });
export default stack;`,

    'stacks/compute/handlers-stack.ts': `import { Stack, Fn, ref } from '@iacmp/core';
const stack = new Stack('order-handlers');
new Fn.Lambda(stack, 'CreateOrderFn', {
  runtime: 'nodejs20', handler: 'index.handler', code: 'dist/handlers/create-order',
  environment: { TABLE_NAME: ref('Orders', 'Name'), QUEUE_URL: ref('OrderQueue', 'QueueUrl') },
});
new Fn.Lambda(stack, 'GetOrderFn', {
  runtime: 'nodejs20', handler: 'index.handler', code: 'dist/handlers/get-order',
  environment: { TABLE_NAME: ref('Orders', 'Name') },
});
new Fn.Lambda(stack, 'ProcessOrderFn', {
  runtime: 'nodejs20', handler: 'index.handler', code: 'dist/handlers/process-order',
  environment: { TABLE_NAME: ref('Orders', 'Name') },
});
export default stack;`,

    'stacks/api/order-api-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('order-api');
new Fn.ApiGateway(stack, 'OrderApi', {
  name: 'order-api', type: 'REST', stageName: 'prod', cors: true, authType: 'NONE',
  routes: [
    { method: 'POST', path: '/orders', lambdaId: 'CreateOrderFn' },
    { method: 'GET', path: '/orders/{id}', lambdaId: 'GetOrderFn' },
  ],
});
export default stack;`,
  },
  handlers: {
    'src/handlers/create-order/index.ts': `import { table } from '@iacmp/runtime';
import { randomUUID } from 'crypto';
const orders = table(process.env.TABLE_NAME!);
export async function handler(event: any) {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});
  const id = randomUUID();
  await orders.put({ id, status: 'pending', ...body });
  return { statusCode: 201, body: JSON.stringify({ id }) };
}`,
    'src/handlers/get-order/index.ts': `import { table } from '@iacmp/runtime';
const orders = table(process.env.TABLE_NAME!);
export async function handler(event: any) {
  const item = await orders.get(event.pathParameters?.id);
  if (!item) return { statusCode: 404, body: JSON.stringify({ error: 'não encontrado' }) };
  return { statusCode: 200, body: JSON.stringify(item) };
}`,
    'src/handlers/process-order/index.ts': `import { table } from '@iacmp/runtime';
const orders = table(process.env.TABLE_NAME!);
export async function handler(event: { orderId: string }) {
  await orders.put({ id: event.orderId, status: 'processed' });
  return { ok: true };
}`,
  },
  notes: [
    'Microsserviço composto = uma stack por DOMÍNIO (database, messaging, compute, api), ligadas por ref() cross-stack. NUNCA junte os 4 num main-stack.ts (o synth rejeita ≥4 domínios numa stack).',
    'No Azure o mesmo input vira: Database.DynamoDB→Cosmos DB (Mongo API), Messaging.Queue→Service Bus, Fn.ApiGateway→API Management, Fn.Lambda→Azure Functions. O ref() cross-stack é resolvido por referência simbólica no _main.bicep (deployment único), não por Export/ImportValue.',
    'Handlers usam o facade @iacmp/runtime (table) — o MESMO código do exemplo AWS; o adaptador Azure (Cosmos/Mongo) é resolvido no deploy.',
    'MONGO_URI/DB_NAME são auto-injetados pelo synth Azure quando o Fn.Lambda referencia Database.DynamoDB — NÃO declare manualmente; só TABLE_NAME (via ref) no environment.',
  ],
};
