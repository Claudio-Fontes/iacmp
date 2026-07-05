export const WORKFLOW_AWS = `
## Regras AWS — Workflow (Step Functions)

**REGRA — Task invoca Lambda por ID:** o \`resource\` de um step \`Task\` é o ID do construct da \`Fn.Lambda\` (ex: \`resource: 'ValidateRequestFn'\`) — o synth resolve pro ARN. NUNCA escreva um ARN cru nem o nome como se fosse ARN.

**REGRA — aprovação humana (esperar decisão externa):** para "aguardar aprovação" NÃO use um estado \`Wait\` (isso é só um delay fixo). Use um step \`Task\` com \`waitForToken: true\` apontando para a Lambda que notifica o aprovador (ex: \`{ name: 'WaitForApproval', type: 'Task', resource: 'NotifyApproverFn', waitForToken: true }\`): o synth gera a integração \`lambda:invoke.waitForTaskToken\` que PAUSA a execução e injeta o token no payload (\`event.taskToken\`). A Lambda notifica o aprovador (ex: manda o token pra uma fila SQS). Depois, os handlers das rotas \`/approve\` e \`/reject\` chamam \`SendTaskSuccess\`/\`SendTaskFailure\` (\`@aws-sdk/client-sfn\`) com esse token para retomar/encerrar o workflow — e precisam da permission \`states:SendTaskSuccess\`/\`states:SendTaskFailure\` no Policy.IAM.

**REGRA — IAM para iniciar execução:** a Lambda que chama \`sfnClient.send(new StartExecutionCommand(...))\` PRECISA de um \`Policy.IAM\` com \`actions: ['states:StartExecution']\` e \`resources: [ref('NomeDaStateMachine', 'Arn')]\`. Sem isso: \`AccessDeniedException\` em runtime.

**REGRA — leitura do body HTTP:** SEMPRE leia dados do body assim: \`const body = JSON.parse(event.body || '{}');\`. NUNCA acesse campos no top-level do event (ex: \`event.requestId\` é inválido — o body chega como string em \`event.body\`). Path params vêm em \`event.pathParameters?.id\`.
`;
