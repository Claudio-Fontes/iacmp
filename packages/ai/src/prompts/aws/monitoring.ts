export const MONITORING_AWS = `
## Regras AWS — Monitoring (CloudWatch Alarm, Dashboard, Log Group)

**REGRA — como referenciar outro construct.** Same-stack: PREFIRA os getters tipados — \`const t = new Messaging.Topic(stack, 'AlertsTopic', {}); ... alarmActions: [t.arn]\`. Getters disponíveis: \`db.endpoint/.port/.password/.secretArn\`, \`vault.secretArn\`, \`topic.arn\`, \`queue.arn/.queueUrl\`, \`stream.arn/.name\`, \`fn.arn\`, \`bucket.arn/.name\`, \`cache.endpoint/.port\`, \`lb.targetGroupArn/.dnsName\`, \`waf.arn\`. Cross-stack (construct declarado em OUTRO arquivo de stack): use \`ref('AlertsTopic', 'Arn')\` (import \`ref\` de \`@iacmp/core\`) ou a string \`'AlertsTopic'\`/\`'AppDB.Endpoint'\`. NUNCA invente propriedades que não existem (\`.url\`, \`.address\`) — só os getters listados.

**REGRA — Lambda subscrita a um SNS topic (monitoramento):** um cenário de monitoramento (alarmes/dashboard/SNS/Lambda-de-alerta) NÃO tem HTTP — NÃO gere \`Fn.ApiGateway\`. Para "Lambda X subscrita ao Topic Y", declare a subscription NO PRÓPRIO \`Messaging.Topic\`: \`subscriptions: [{ protocol: 'lambda', endpoint: 'AlertHandlerFn' }]\` (\`endpoint\` = id da Fn.Lambda) — o synth cria a Subscription + a Lambda::Permission que autoriza o SNS.
`;
