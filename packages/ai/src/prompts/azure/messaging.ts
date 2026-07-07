export const MESSAGING_AZURE = `
## Regras Azure — Messaging (Service Bus)

**REGRA ABSOLUTA AZURE — Messaging.Queue usa @azure/service-bus (NUNCA @azure/data-tables/@azure/cosmos/@aws-sdk/*)**

\`Messaging.Queue\` no Azure vira um \`Microsoft.ServiceBus/namespaces\` + \`.../queues\` (o nome da fila = o construct.id). O SDK do PRODUTOR é SEMPRE \`@azure/service-bus\`. Gerar \`@azure/data-tables\` (Cosmos Table API), \`@azure/cosmos\` ou \`@aws-sdk/client-sqs\` para uma fila é ERRO — data-tables é para \`Database.DynamoDB\`, NÃO para fila.

- **Atributo válido de \`ref()\` para \`Messaging.Queue\`:** \`ConnectionString\` (NÃO invente \`QueueUrl\`/\`Arn\`/\`Endpoint\`). É a connection string do namespace Service Bus (RootManageSharedAccessKey), obtida via \`listKeys()\` — serve tanto para enviar quanto para receber.
- **Env var do produtor:** passe a connection string DIRETA como env var no \`Fn.Lambda\` produtor: \`TASKQUEUE_CONNECTION_STRING: ref('TaskQueue', 'ConnectionString')\` (para a fila \`TaskQueue\`). Passe também o nome da fila: \`QUEUE_NAME: 'TaskQueue'\` (= o construct.id da fila). NUNCA concatene \`ref()\` com string.
- **Policy.IAM para \`Messaging.Queue\` no Azure: NÃO gere** — a connection string já autentica (não existe IAM de data-plane como no SQS da AWS).

### Padrão worker (producer → fila → consumer), os DOIS lados são obrigatórios

1. O \`Fn.Lambda\` CONSUMIDOR precisa de \`eventSources: [{ queueId: 'TaskQueue' }]\` — sem isso a fila nunca é drenada e o worker nunca roda. \`queueId\` é SÓ para \`Messaging.Queue\`.
2. O \`Fn.Lambda\` PRODUTOR precisa de \`environment: { TASKQUEUE_CONNECTION_STRING: ref('TaskQueue', 'ConnectionString'), QUEUE_NAME: 'TaskQueue' }\`.

### EXEMPLO OBRIGATÓRIO — worker Service Bus no Azure

\`\`\`typescript
// stacks/messaging/queue-stack.ts
import { Stack, Messaging } from '@iacmp/core';
const stack = new Stack('queue-stack');
new Messaging.Queue(stack, 'TaskQueue', {});
export default stack;

// stacks/compute/api-stack.ts — PRODUTOR: envia mensagem para a fila
import { Stack, Fn, ref } from '@iacmp/core';
const stack = new Stack('api-stack');
new Fn.Lambda(stack, 'EnqueueFn', {
  runtime: 'nodejs20', handler: 'dist/enqueue.handler', code: '.',
  environment: {
    TASKQUEUE_CONNECTION_STRING: ref('TaskQueue', 'ConnectionString'),
    QUEUE_NAME: 'TaskQueue',
  },
});
// CONSUMIDOR: acionado pela fila via eventSources (NÃO precisa de connection string)
new Fn.Lambda(stack, 'WorkerFn', {
  runtime: 'nodejs20', handler: 'dist/worker.handler', code: '.',
  eventSources: [{ queueId: 'TaskQueue' }],
});
export default stack;
\`\`\`

\`\`\`typescript
// src/enqueue.ts — PRODUTOR usa @azure/service-bus (NUNCA @azure/data-tables)
import { ServiceBusClient } from '@azure/service-bus';

export async function handler(event: any) {
  const payload = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});
  const client = new ServiceBusClient(process.env.TASKQUEUE_CONNECTION_STRING!);
  const sender = client.createSender(process.env.QUEUE_NAME!);
  try {
    await sender.sendMessages({ body: JSON.stringify(payload) });
  } finally {
    await sender.close();
    await client.close();
  }
  return { statusCode: 202, body: JSON.stringify({ enqueued: true }) };
}
\`\`\`

\`\`\`typescript
// src/worker.ts — CONSUMIDOR lê event.Records[].body (o server.js do iacmp entrega
// as mensagens da fila no MESMO formato do SQS: cada Record tem body = string JSON).
// NÃO abra um ServiceBusReceiver no consumidor — o runtime já faz o poll e entrega.
export async function handler(event: any) {
  for (const record of event.Records ?? []) {
    const msg = JSON.parse(record.body);   // body é sempre string JSON
    // ... processa a tarefa
  }
  return { statusCode: 200, body: '' };
}
\`\`\`

### nextSteps obrigatório: inclua "npm install @azure/service-bus" (só no produtor) e NÃO mencione @azure/data-tables nem @aws-sdk/*.

---

**REGRA ABSOLUTA AZURE — Messaging.Topic usa @azure/service-bus (NUNCA @azure/data-tables/@azure/cosmos/@aws-sdk/*)**

\`Messaging.Topic\` no Azure vira um \`Microsoft.ServiceBus/namespaces\` + \`.../topics\` + \`.../subscriptions\` (fan-out SNS). O SDK do PRODUTOR é SEMPRE \`@azure/service-bus\`. Gerar \`@azure/data-tables\` para um tópico é ERRO — data-tables é para \`Database.DynamoDB\`, NUNCA para tópico/fila.

- **Atributo válido de \`ref()\` para \`Messaging.Topic\`:** \`ConnectionString\` (= connection string do namespace Service Bus, RootManageSharedAccessKey). Passe também o nome do tópico como string literal: \`TOPIC_NAME: 'NotificationsTopic'\` (= o construct.id do tópico).
- **Produtor usa \`createSender(topicName)\`** para publicar no tópico.
- **Consumidor de tópico**: cada subscriber recebe via \`ServiceBusReceiver\` (NÃO via eventSources — eventSources só funciona para Messaging.Queue).

### EXEMPLO OBRIGATÓRIO — fan-out Messaging.Topic no Azure

\`\`\`typescript
// stacks/messaging/topic-stack.ts — OBRIGATÓRIO: declarar subscriptions no Topic
import { Stack, Messaging } from '@iacmp/core';
const stack = new Stack('notification-topic-stack');
new Messaging.Topic(stack, 'NotificationsTopic', {
  subscriptions: [
    { name: 'email-sub', filterPolicy: { type: ['email'] } },
    { name: 'push-sub', filterPolicy: { type: ['push'] } },
    { name: 'audit-sub' },  // sem filtro — recebe todos os tipos
  ],
});
export default stack;

// stacks/compute/publisher-stack.ts — PRODUTOR: ref() é FUNÇÃO, NÃO string template
import { Stack, Fn, ref } from '@iacmp/core';
const stack = new Stack('publisher-stack');
new Fn.Lambda(stack, 'PublishNotificationFn', {
  runtime: 'nodejs20', handler: 'dist/publish.handler', code: '.',
  environment: {
    // ref() é FUNÇÃO — NÃO coloque backtick ou aspas ao redor da chamada inteira
    NOTIFICATIONS_TOPIC_CONNECTION_STRING: ref('NotificationsTopic', 'ConnectionString'),
    TOPIC_NAME: 'NotificationsTopic',
  },
});
export default stack;
\`\`\`

\`\`\`typescript
// src/publish.ts — PRODUTOR usa @azure/service-bus (NUNCA @azure/data-tables)
import { ServiceBusClient } from '@azure/service-bus';

export async function handler(event: any) {
  const payload = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});
  const client = new ServiceBusClient(process.env.NOTIFICATIONS_TOPIC_CONNECTION_STRING!);
  const sender = client.createSender(process.env.TOPIC_NAME!);
  try {
    await sender.sendMessages({ body: JSON.stringify(payload) });
  } finally {
    await sender.close();
    await client.close();
  }
  return { statusCode: 200, body: JSON.stringify({ published: true }) };
}
\`\`\`

\`\`\`typescript
// src/subscriber.ts — CONSUMIDOR de tópico usa ServiceBusReceiver
import { ServiceBusClient } from '@azure/service-bus';

export async function handler(event: any) {
  // event.Records pode estar vazio num Container App sem eventSources de tópico.
  // Consumidores de Messaging.Topic geralmente PUXAM mensagens via receiveMessages().
  const client = new ServiceBusClient(process.env.NOTIFICATIONS_TOPIC_CONNECTION_STRING!);
  const receiver = client.createReceiver(process.env.TOPIC_NAME!, process.env.SUBSCRIPTION_NAME!);
  try {
    const messages = await receiver.receiveMessages(10, { maxWaitTimeInMs: 5000 });
    for (const msg of messages) {
      const body = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
      // ... processa notificação
      await receiver.completeMessage(msg);
    }
  } finally {
    await receiver.close();
    await client.close();
  }
  return { statusCode: 200, body: '' };
}
\`\`\`
`;
