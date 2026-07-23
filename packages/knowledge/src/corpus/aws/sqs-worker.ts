import type { Example } from '../index.js';

export const sqsWorker: Example = {
  id: 'aws-sqs-worker',
  title: 'Worker assíncrono: API → SQS → Lambda consumer',
  tags: ['aws', 'sqs', 'queue', 'worker', 'lambda', 'api-gateway'],
  validated: true,
  stacks: {
    'stacks/messaging/queue-stack.ts': `import { Stack, Messaging } from '@iacmp/core';
const stack = new Stack('jobs-queue');
new Messaging.Queue(stack, 'JobsQueue', {
  visibilityTimeoutSeconds: 60,
  messageRetentionSeconds: 86400,
});
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Fn, ref } from '@iacmp/core';
const stack = new Stack('jobs-api');
new Fn.Lambda(stack, 'EnqueueJobFn', {
  runtime: 'nodejs20',
  handler: 'dist/enqueueJob.handler',
  code: '.',
  environment: { QUEUE_URL: ref('JobsQueue', 'QueueUrl') },
});
export default stack;`,

    'stacks/compute/worker-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('jobs-worker');
new Fn.Lambda(stack, 'ProcessJobFn', {
  runtime: 'nodejs20',
  handler: 'dist/processJob.handler',
  code: '.',
  timeout: 30,
  eventSources: [{ queueId: 'JobsQueue', batchSize: 10 }],
});
export default stack;`,

    'stacks/network/api-gateway-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('jobs-gw');
new Fn.ApiGateway(stack, 'JobsApi', {
  name: 'jobs-api', type: 'HTTP', cors: true,
  routes: [
    { method: 'POST', path: '/jobs', lambdaId: 'EnqueueJobFn' },
  ],
});
export default stack;`,
  },
  handlers: {
    'src/enqueueJob.ts': `import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
const sqs = new SQSClient({});
export const handler = async (event: any) => {
  const body = JSON.parse(event.body ?? '{}');
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.QUEUE_URL,
    MessageBody: JSON.stringify(body),
  }));
  return { statusCode: 202, body: JSON.stringify({ enqueued: true }), headers: { 'Access-Control-Allow-Origin': '*' } };
};`,
    'src/processJob.ts': `export const handler = async (event: any) => {
  for (const record of event.Records) {
    const job = JSON.parse(record.body);
    console.log('Processando job:', job);
  }
};`,
  },
  notes: [
    'ProcessJobFn NÃO precisa de Policy.IAM explícita: eventSources[].queueId no Function.Lambda faz o synth auto-anexar AWSLambdaSQSQueueExecutionRole (ReceiveMessage/DeleteMessage/GetQueueAttributes) na role default',
    'EnqueueJobFn NÃO precisa de Policy.IAM explícita: environment com ref(Queue,"QueueUrl") faz o synth detectar "Lambda produtora de SQS" e auto-conceder sqs:SendMessage/GetQueueAttributes/GetQueueUrl na role default',
    'Se quiser restringir o alcance (least privilege além do auto-grant), aí sim declare Policy.IAM explícita com resources: [ref("JobsQueue","Arn")] — o auto-grant usa Resource:"*" para evitar dependência cross-stack de ARN',
    'QUEUE_URL: ref("JobsQueue","QueueUrl") — NUNCA o ID lógico ou URL literal',
    'Messaging.Queue e as duas Lambdas em stacks SEPARADAS (mensageria, api, worker) — evita monolito',
    'batchSize: 10 é o default do EventSourceMapping para SQS (não precisa declarar, mas fica explícito aqui)',
    'timeout: 30 no consumer deve ser ≤ visibilityTimeoutSeconds da fila (60) — nunca configure timeout da Lambda maior que o visibility timeout',
  ],
};
