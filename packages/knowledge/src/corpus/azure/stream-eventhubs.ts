import type { Example } from '../index.js';

export const streamEventHubs: Example = {
  id: 'azure-stream-eventhubs',
  title: 'Azure Event Hubs — Messaging.Stream + Function consumidora via ConnectionString',
  tags: ['azure', 'stream', 'eventhubs', 'messaging', 'lambda', 'function', 'cross-stack'],
  // synth-validado (az bicep build OK, ConnectionString resolve para listKeys(...) real);
  // deploy real pendente de bateria Azure.
  validated: false,
  provider: 'azure',
  constructs: ['stream', 'lambda'],
  stacks: {
    'stacks/messaging/events-stack.ts': `import { Stack, Messaging } from '@iacmp/core';

const stack = new Stack('order-events');

// Messaging.Stream no Azure vira Microsoft.EventHub/namespaces +
// Microsoft.EventHub/namespaces/eventhubs (equivalente ao Kinesis Data Stream
// da AWS). shards ~ partitionCount; retentionHours ~ messageRetentionInDays.
new Messaging.Stream(stack, 'OrderEventsStream', {
  shards: 2,
  retentionHours: 24,
});

export default stack;`,

    'stacks/compute/consumer-stack.ts': `import { Stack, Fn, ref } from '@iacmp/core';

const stack = new Stack('order-events-consumer');

// Cross-stack: ref('OrderEventsStream', 'ConnectionString') resolve para
// listKeys(resourceId('Microsoft.EventHub/namespaces/authorizationRules', ...,
// 'RootManageSharedAccessKey'), ...).primaryConnectionString do namespace
// (mesma amarração param↔output já usada por Messaging.Queue/Topic — a stack
// do Stream exporta o output, esta stack declara o param cross-stack).
//
// Essa connection string é do NAMESPACE (sem ";EntityPath=<hub>") — por isso
// o nome do Event Hub vai numa env var separada (EVENTHUB_NAME) e é passado
// como 3º argumento do client no handler, não embutido na connection string.
new Fn.Lambda(stack, 'OrderEventsConsumerFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/handlers/order-events-consumer',
  environment: {
    EVENTHUB_CONNECTION_STRING: ref('OrderEventsStream', 'ConnectionString'),
    EVENTHUB_NAME: ref('OrderEventsStream', 'Name'),
  },
});

export default stack;`,
  },
  handlers: {
    'src/handlers/order-events-consumer/index.ts': `import { EventHubConsumerClient } from '@azure/event-hubs';

// A connection string do namespace NÃO tem ";EntityPath=" — o nome do Event Hub
// entra como 3º argumento do client, nunca concatenado à connection string à mão.
export async function handler(): Promise<{ statusCode: number; body: string }> {
  const client = new EventHubConsumerClient(
    '$Default',
    process.env.EVENTHUB_CONNECTION_STRING as string,
    process.env.EVENTHUB_NAME as string,
  );

  const received: unknown[] = [];
  const subscription = client.subscribe({
    processEvents: async (events) => {
      for (const e of events) received.push(e.body);
    },
    processError: async (err) => {
      console.error('[order-events-consumer] erro no consumo:', err);
    },
  });

  // Janela curta só para ilustrar o ciclo de vida do client num handler request/response
  // (invocação HTTP-triggered) — um worker de streaming de verdade manteria o subscribe
  // vivo entre invocações (ex: Container App sempre-on), não abriria/fecharia a cada call.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  await subscription.close();
  await client.close();

  return { statusCode: 200, body: JSON.stringify({ received: received.length }) };
}`,
  },
  notes: [
    'Messaging.Stream no Azure vira Microsoft.EventHub/namespaces + Microsoft.EventHub/namespaces/eventhubs (equivalente ao Kinesis Data Stream da AWS).',
    'ConnectionString vem de listKeys(...) sobre a authorizationRule default RootManageSharedAccessKey do NAMESPACE — o mesmo mecanismo já usado por Messaging.Queue/Topic (Service Bus). Sem esse output, um consumer cross-stack com ref(id,"ConnectionString") caía no fallback genérico e gerava um param Bicep de tipo string com default vazio — az bicep build passava, mas o consumer nunca conectava em runtime (bug corrigido nesta versão).',
    'A connection string é do namespace, não da entidade — não tem ";EntityPath=<hub>". O nome do Event Hub precisa ir numa env var separada (ref(id,"Name")) e ser passado como argumento próprio do client (ex: 3º argumento do EventHubConsumerClient), nunca concatenado à mão na connection string.',
    'Consumer usa o SDK @azure/event-hubs diretamente (EventHubConsumerClient) — ainda não há facade @iacmp/runtime para Messaging.Stream/Event Hubs (ao contrário de Storage.Bucket/Database.DocumentDB, que já usam o facade).',
    'Stream (Messaging.Stream) e Function consumidora ficam em stacks de domínio separadas (messaging vs compute) — convenção do projeto de uma stack por domínio; o wiring cross-stack (output produtor + param consumidor) é automático no synth.',
  ],
};
