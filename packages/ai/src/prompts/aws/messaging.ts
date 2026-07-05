export const MESSAGING_AWS = `
## Regras AWS — Messaging (SQS, Kinesis, SNS, EventBridge)

**REGRA — padrão worker SQS (producer → fila → consumer), os DOIS lados são obrigatórios:**
1. A Lambda CONSUMIDORA precisa de \`eventSources: [{ queueId: 'TaskQueue' }]\` — sem isso NÃO existe EventSourceMapping, a fila nunca drena e o worker nunca roda. \`queueId\` é SÓ para Messaging.Queue; \`streamId\` é SÓ para Messaging.Stream (Kinesis) — nunca troque.
2. A Lambda PRODUTORA precisa de \`environment: { QUEUE_URL: ref('TaskQueue', 'QueueUrl') }\` — o SendMessageCommand exige a URL da fila. É \`'QueueUrl'\`, NUNCA \`'Arn'\` (ARN no lugar da URL dá QueueDoesNotExist em runtime).

**REGRA — pipeline de eventos em tempo real / "stream":** para ingestão de logs/eventos em tempo real com shards, use \`Messaging.Stream\` (Kinesis), NÃO \`Messaging.Queue\` (SQS não é stream, não tem shards e o batchSize máx é 10). O produtor (ingestor) escreve com \`@aws-sdk/client-kinesis\` (\`PutRecordCommand\`: \`{ StreamName: process.env.STREAM_NAME, Data: Buffer.from(JSON.stringify(evt)), PartitionKey: evt.eventType }\`) e precisa de \`kinesis:PutRecord\` no IAM (\`resources: ['<StreamId>']\`). O consumidor é acionado pelo stream via \`eventSources: [{ streamId: '<StreamId>', batchSize: 100, startingPosition: 'LATEST' }]\` no \`Fn.Lambda\` (o synth cria o EventSourceMapping + a role de leitura Kinesis) — o handler recebe \`event.Records[].kinesis.data\` (base64: \`Buffer.from(r.kinesis.data,'base64').toString()\`). Passe o nome do stream como env var (\`STREAM_NAME: '<StreamId>'\`).

**REGRA — Lambda subscrita a um SNS topic:** para "Lambda X subscrita ao Topic Y", declare a subscription NO PRÓPRIO \`Messaging.Topic\`: \`subscriptions: [{ protocol: 'lambda', endpoint: 'AlertHandlerFn' }]\` (\`endpoint\` = id da Fn.Lambda, ou \`fn.arn\` se a Lambda está na mesma stack) — o synth cria a Subscription + a Lambda::Permission que autoriza o SNS. Não é preciso (nem existe) API Gateway para isso: um cenário de monitoramento (alarmes/dashboard/SNS/Lambda-de-alerta) NÃO tem HTTP — NÃO gere \`Fn.ApiGateway\`.

**REGRA — rule agendada no EventBridge:** para "rodar a cada X / todo dia às Y", use \`cron\` (cru, ex: \`cron: '0 8 * * ? *'\`) OU \`rate\` (ex: \`rate: '1 hour'\`) — NUNCA um campo \`scheduleExpression\` com \`'cron(...)'\` já embrulhado (o synth adiciona o wrapper). O alvo é \`targetLambdaId\` (id da Fn.Lambda), não \`targetArn\` inventado. Rule agendada NÃO tem source/detailTypes.
`;
