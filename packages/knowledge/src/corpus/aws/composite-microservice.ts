import type { Example } from '../index.js';

export const compositeMicroserviceAws: Example = {
  id: 'aws-composite-microservice',
  title: 'Microsserviço composto AWS — API + Lambda + DynamoDB + fila (4 domínios, 4 stacks)',
  tags: ['aws', 'microservice', 'composite', 'api-gateway', 'lambda', 'dynamodb', 'sqs', 'queue'],
  validated: false,
  provider: 'aws',
  constructs: ['api-gateway', 'lambda', 'dynamodb', 'sqs'],
  stacks: {
    // Uma stack por DOMÍNIO, ligadas por ref() cross-stack. É o padrão de um
    // microsserviço: dados, mensageria, compute e API separados.
    'stacks/database/orders-db-stack.ts': `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('orders-db');
new Database.DynamoDB(stack, 'Orders', { partitionKey: 'id' });
export default stack;`,

    'stacks/messaging/order-queue-stack.ts': `import { Stack, Messaging } from '@iacmp/core';
const stack = new Stack('order-queue');
// Fila para processamento assíncrono (o worker ProcessOrderFn consome).
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
    // Handlers usam o facade @iacmp/runtime (table) — agnóstico de cloud.
    'src/handlers/create-order/index.ts': `import { table } from '@iacmp/runtime';
import { randomUUID } from 'crypto';
const orders = table(process.env.TABLE_NAME!);
export async function handler(event: any) {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});
  const id = randomUUID();
  await orders.put({ id, status: 'pending', ...body });
  // processamento assíncrono seria enfileirado em process.env.QUEUE_URL
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
// Worker: consome a fila e marca o pedido como processado.
export async function handler(event: { orderId: string }) {
  await orders.put({ id: event.orderId, status: 'processed' });
  return { ok: true };
}`,
  },
  notes: [
    'Microsserviço composto = uma stack por DOMÍNIO (database, messaging, compute, api), ligadas por ref() cross-stack. NUNCA junte os 4 num main-stack.ts (o synth rejeita ≥4 domínios numa stack).',
    'ref() atravessa stacks: o Fn.Lambda em compute referencia Database.DynamoDB (Name) e Messaging.Queue (QueueUrl) de outras stacks — o synth resolve via Export/ImportValue (AWS).',
    'Handlers usam o facade @iacmp/runtime (table) — o MESMO código roda em AWS e Azure; o adaptador por cloud é resolvido no deploy.',
    'O guard de env vars exige que todo process.env.X lido no handler esteja declarado no environment do Fn.Lambda — aqui TABLE_NAME e QUEUE_URL.',
  ],
};
