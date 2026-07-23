import type { Example } from '../index.js';

export const stepFunctionsApproval: Example = {
  id: 'aws-step-functions-approval',
  title: 'Step Functions com aprovação humana (waitForTaskToken)',
  tags: ['aws', 'step-functions', 'workflow', 'lambda', 'approval', 'api-gateway'],
  // validado em deploy real (ciclo 14 da bateria): start-execution pausa no token,
  // SendTaskSuccess retoma, execução termina SUCCEEDED
  validated: true,
  stacks: {
    'stacks/workflow/approval-workflow-stack.ts': `import { Stack, Workflow } from '@iacmp/core';
const stack = new Stack('approval-workflow');
new Workflow.StepFunctions(stack, 'ApprovalWorkflow', {
  description: 'Fluxo de aprovação com pausa até decisão humana',
  steps: [
    { name: 'SubmitRequest', type: 'Task', resource: 'SubmitRequestFn' },
    { name: 'WaitForApproval', type: 'Task', resource: 'NotifyApproverFn', waitForToken: true },
    { name: 'FinalizeRequest', type: 'Task', resource: 'FinalizeRequestFn' },
  ],
});
export default stack;`,

    'stacks/compute/workflow-tasks-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('approval-tasks');
new Fn.Lambda(stack, 'SubmitRequestFn', { runtime: 'nodejs20', handler: 'dist/submitRequest.handler', code: '.' });
new Fn.Lambda(stack, 'NotifyApproverFn', { runtime: 'nodejs20', handler: 'dist/notifyApprover.handler', code: '.' });
new Fn.Lambda(stack, 'FinalizeRequestFn', { runtime: 'nodejs20', handler: 'dist/finalizeRequest.handler', code: '.' });
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Fn, Policy, ref } from '@iacmp/core';
const stack = new Stack('approval-api');
new Fn.Lambda(stack, 'StartApprovalFn', {
  runtime: 'nodejs20',
  handler: 'dist/startApproval.handler',
  code: '.',
  environment: { STATE_MACHINE_ARN: ref('ApprovalWorkflow', 'Arn') },
});
new Fn.Lambda(stack, 'CompleteApprovalFn', {
  runtime: 'nodejs20',
  handler: 'dist/completeApproval.handler',
  code: '.',
});
new Policy.IAM(stack, 'CompleteApprovalFnPolicy', {
  attachTo: 'CompleteApprovalFn', attachType: 'lambda',
  statements: [{ effect: 'Allow', actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'], resources: ['*'] }],
});
export default stack;`,

    'stacks/network/api-gateway-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('approval-gw');
new Fn.ApiGateway(stack, 'ApprovalApi', {
  name: 'approval-api', type: 'HTTP', cors: true,
  routes: [
    { method: 'POST', path: '/requests', lambdaId: 'StartApprovalFn' },
    { method: 'POST', path: '/approve',  lambdaId: 'CompleteApprovalFn' },
  ],
});
export default stack;`,
  },
  handlers: {
    'src/startApproval.ts': `import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
const sfn = new SFNClient({});
export const handler = async (event: any) => {
  const body = JSON.parse(event.body ?? '{}');
  const res = await sfn.send(new StartExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN,
    input: JSON.stringify(body),
  }));
  return { statusCode: 202, body: JSON.stringify({ executionArn: res.executionArn }), headers: { 'Access-Control-Allow-Origin': '*' } };
};`,
    'src/submitRequest.ts': `export const handler = async (event: any) => {
  const request = JSON.parse(event.body);
  console.log('Requisição registrada:', request);
  // ResultPath: null no step — o retorno aqui é descartado, o estado original segue pro próximo passo
};`,
    'src/notifyApprover.ts': `export const handler = async (event: any) => {
  const request = JSON.parse(event.body);
  // event.taskToken pausa a execução até POST /approve chamar SendTaskSuccess com ele.
  // Em produção: enviar taskToken por email/SNS pro aprovador (nunca devolver ao cliente da API original).
  console.log('Aguardando aprovação. taskToken:', event.taskToken, 'request:', request);
};`,
    'src/finalizeRequest.ts': `export const handler = async (event: any) => {
  const request = JSON.parse(event.body);
  console.log('Requisição finalizada:', request);
};`,
    'src/completeApproval.ts': `import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
const sfn = new SFNClient({});
export const handler = async (event: any) => {
  const { taskToken } = JSON.parse(event.body ?? '{}');
  await sfn.send(new SendTaskSuccessCommand({
    taskToken,
    output: JSON.stringify({ approved: true }),
  }));
  return { statusCode: 200, body: JSON.stringify({ resumed: true }), headers: { 'Access-Control-Allow-Origin': '*' } };
};`,
  },
  notes: [
    'StartApprovalFn NÃO precisa de Policy.IAM explícita: environment com ref(StepFunctions,"Arn") faz o synth detectar "Lambda iniciadora de Step Functions" e auto-conceder states:StartExecution na role default',
    'Se der Policy.IAM explícita à StartApprovalFn, o auto-grant NÃO acontece (a role deixa de ser a "default" — vira a role da Policy.IAM, sem os auto-statements) — nunca misture os dois',
    'CompleteApprovalFn PRECISA de Policy.IAM com states:SendTaskSuccess/SendTaskFailure, Resource:"*" — não há auto-grant pra essa ação (o taskToken em si já é a autorização de negócio, o IAM só libera a API)',
    'step type:"Task" com resource: ID LÓGICO de uma Fn.Lambda (nunca ARN cru) — o synth resolve e valida que o id aponta pra uma Fn.Lambda de verdade',
    'waitForToken: true → integração lambda:invoke.waitForTaskToken — a execução PAUSA até alguém (fora do Step Functions) chamar SendTaskSuccess/SendTaskFailure com event.taskToken',
    'Todos os Tasks recebem o estado em event.body (string JSON via States.JsonToString) — SEMPRE JSON.parse(event.body), nunca usar o event bruto como payload',
    'ResultPath: null em todos os Tasks (automático) — o retorno do handler é descartado, o próximo step recebe o MESMO input do anterior (não voce encadeia resultado por retorno)',
    'A Lambda de "aprovar" (NotifyApproverFn) e a de "completar" (CompleteApprovalFn) são LAMBDAS DIFERENTES — a primeira roda DENTRO do Step Functions (recebe o token), a segunda roda FORA (invocada pela API quando o humano aprova, usa o token pra retomar)',
  ],
};
