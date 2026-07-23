import type { Example } from '../index.js';

export const snsFanout: Example = {
  id: 'aws-sns-fanout',
  title: 'Fan-out: SNS Topic → 2 filas SQS → 2 Lambdas consumer',
  tags: ['aws', 'sns', 'sqs', 'fanout', 'topic', 'lambda', 'api-gateway'],
  // validado em deploy real (p07aws): 3x POST 200, filterPolicy roteando (email/push) +
  // 1 fila sem filtro recebendo tudo, ESM drenando; destroy limpo. Este fixture usa 2
  // filas fan-out-a-todas (sem filterPolicy) — mesmo mecanismo (Topic->subscriptions
  // sqs->QueuePolicy->ESM), variante mais simples da mesma feature já provada
  validated: true,
  stacks: {
    'stacks/messaging/queue-topic-stack.ts': `import { Stack, Messaging } from '@iacmp/core';
const stack = new Stack('order-events');
// Queues e Topic NA MESMA STACK: a subscription protocol:'sqs' cria uma
// AWS::SQS::QueuePolicy que referencia a fila por Ref same-stack — cross-stack
// (Topic numa stack, Queue noutra) não é suportado hoje (o Queues[] da policy
// não passa pelo resolvedor cross-stack, só o Endpoint da subscription passa).
new Messaging.Queue(stack, 'ShippingQueue', { visibilityTimeoutSeconds: 60 });
new Messaging.Queue(stack, 'BillingQueue',  { visibilityTimeoutSeconds: 60 });
new Messaging.Topic(stack, 'OrderEventsTopic', {
  displayName: 'order-events',
  subscriptions: [
    { protocol: 'sqs', endpoint: 'ShippingQueue' },
    { protocol: 'sqs', endpoint: 'BillingQueue' },
  ],
});
export default stack;`,

    'stacks/compute/publish-stack.ts': `import { Stack, Fn, Policy, ref } from '@iacmp/core';
const stack = new Stack('order-api');
new Fn.Lambda(stack, 'PublishOrderFn', {
  runtime: 'nodejs20',
  handler: 'dist/publishOrder.handler',
  code: '.',
  environment: { TOPIC_ARN: ref('OrderEventsTopic', 'Arn') },
});
new Policy.IAM(stack, 'PublishOrderFnPolicy', {
  attachTo: 'PublishOrderFn', attachType: 'lambda',
  statements: [{ effect: 'Allow', actions: ['sns:Publish'], resources: [ref('OrderEventsTopic', 'Arn')] }],
});
export default stack;`,

    'stacks/compute/consumers-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('order-workers');
new Fn.Lambda(stack, 'ShippingWorkerFn', {
  runtime: 'nodejs20',
  handler: 'dist/shippingWorker.handler',
  code: '.',
  eventSources: [{ queueId: 'ShippingQueue' }],
});
new Fn.Lambda(stack, 'BillingWorkerFn', {
  runtime: 'nodejs20',
  handler: 'dist/billingWorker.handler',
  code: '.',
  eventSources: [{ queueId: 'BillingQueue' }],
});
export default stack;`,

    'stacks/network/api-gateway-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('order-gw');
new Fn.ApiGateway(stack, 'OrdersApi', {
  name: 'orders-api', type: 'HTTP', cors: true,
  routes: [
    { method: 'POST', path: '/orders', lambdaId: 'PublishOrderFn' },
  ],
});
export default stack;`,
  },
  handlers: {
    'src/publishOrder.ts': `import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
const sns = new SNSClient({});
export const handler = async (event: any) => {
  const order = JSON.parse(event.body ?? '{}');
  await sns.send(new PublishCommand({
    TopicArn: process.env.TOPIC_ARN,
    Message: JSON.stringify(order),
  }));
  return { statusCode: 202, body: JSON.stringify({ published: true }), headers: { 'Access-Control-Allow-Origin': '*' } };
};`,
    'src/shippingWorker.ts': `export const handler = async (event: any) => {
  for (const record of event.Records) {
    const order = JSON.parse(record.body);
    console.log('Preparando envio do pedido:', order);
  }
};`,
    'src/billingWorker.ts': `export const handler = async (event: any) => {
  for (const record of event.Records) {
    const order = JSON.parse(record.body);
    console.log('Faturando pedido:', order);
  }
};`,
  },
  notes: [
    'PublishOrderFn PRECISA de Policy.IAM explícita com sns:Publish — diferente do produtor SQS, não há auto-grant para SNS Publish (o auto-grant do synth só cobre sqs:SendMessage via ref de Messaging.Queue)',
    'resources: [ref("OrderEventsTopic","Arn")] na policy — NUNCA ARN literal',
    'ShippingWorkerFn/BillingWorkerFn NÃO precisam de Policy.IAM: eventSources[].queueId auto-anexa AWSLambdaSQSQueueExecutionRole, igual ao worker-de-fila simples',
    'subscriptions[].endpoint usa o ID LÓGICO do Messaging.Queue (string) — o synth resolve pro ARN e cria a SQS::QueuePolicy que autoriza o SNS a publicar em cada fila (fan-out)',
    'Messaging.Queue e Messaging.Topic (com as subscriptions que as ligam) ficam NA MESMA STACK — LACUNA de ferramenta encontrada nesta sessão: a AWS::SQS::QueuePolicy gerada pela subscription protocol:"sqs" referencia a fila com Ref same-stack (não passa pelo resolvedor cross-stack), então Topic e Queue em stacks diferentes falha no synth com "Ref para recurso inexistente". As Lambdas consumer (eventSources[].queueId) SÃO cross-stack normalmente — só a dupla Queue+Topic-com-subscription precisa ficar junta.',
    'RawMessageDelivery: true é automático para subscriptions protocol:"sqs" — o consumer recebe o JSON puro do Publish em record.body, sem envelope SNS (Message/MessageId/TopicArn)',
    'Cada fila tem seu PRÓPRIO worker — fan-out real (shipping e billing processam o MESMO evento independentemente, não é round-robin)',
  ],
};
