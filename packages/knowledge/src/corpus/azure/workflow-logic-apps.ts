import type { Example } from '../index.js';

export const workflowLogicApps: Example = {
  id: 'azure-workflow-logic-apps',
  title: 'Azure Logic Apps — Workflow.StepFunctions vira Microsoft.Logic/workflows',
  tags: ['azure', 'workflow', 'logic-apps', 'orchestration', 'lambda', 'function', 'step-functions'],
  // synth-validado (az bicep build OK); deploy real pendente de bateria Azure
  validated: false,
  provider: 'azure',
  constructs: ['workflow', 'lambda'],
  stacks: {
    'stacks/workflow/order-workflow-stack.ts': `import { Stack, Workflow } from '@iacmp/core';

const stack = new Stack('order-workflow');

// No Azure, Workflow.StepFunctions vira Microsoft.Logic/workflows (Logic Apps) —
// NÃO Durable Functions. Cada step type:'Task' com resource:'<FnId>' vira uma
// action que invoca a Function; os steps rodam na ordem do array.
new Workflow.StepFunctions(stack, 'OrderWorkflow', {
  description: 'Processa um pedido: valida, cobra e envia',
  steps: [
    { name: 'ValidateOrder', type: 'Task', resource: 'ValidateOrderFn' },
    { name: 'ChargePayment', type: 'Task', resource: 'ChargePaymentFn' },
    { name: 'ShipOrder', type: 'Task', resource: 'ShipOrderFn' },
  ],
});

export default stack;`,

    'stacks/compute/order-tasks-stack.ts': `import { Stack, Fn } from '@iacmp/core';

const stack = new Stack('order-tasks');

// As tasks do workflow ficam em stack separada (domínio compute) — o workflow as
// referencia por id. Cada handler aninhado em src/handlers/<op>/index.ts.
new Fn.Lambda(stack, 'ValidateOrderFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/handlers/validate-order' });
new Fn.Lambda(stack, 'ChargePaymentFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/handlers/charge-payment' });
new Fn.Lambda(stack, 'ShipOrderFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/handlers/ship-order' });

export default stack;`,
  },
  handlers: {
    'src/handlers/validate-order/index.ts': `export async function handler(input: { orderId: string }) {
  // valida o pedido; a saída vira input da próxima action do Logic App
  return { orderId: input.orderId, valid: true };
}`,
    'src/handlers/charge-payment/index.ts': `export async function handler(input: { orderId: string }) {
  return { orderId: input.orderId, charged: true, amount: 100 };
}`,
    'src/handlers/ship-order/index.ts': `export async function handler(input: { orderId: string }) {
  return { orderId: input.orderId, shipped: true };
}`,
  },
  notes: [
    'Workflow.StepFunctions no Azure vira Microsoft.Logic/workflows (Logic Apps), não Durable Functions — o synth gera a definition com actions sequenciais.',
    'Cada step { type: "Task", resource: "<FnId>" } chama a Function correspondente; os steps executam na ordem do array steps[].',
    'waitForToken (equivalente ao waitForTaskToken do Step Functions AWS) NÃO tem mapeamento direto em Logic Apps — evite em cenários Azure; use um passo de aprovação HTTP se precisar de pausa.',
    'As Functions (tasks) ficam em stack de domínio compute, separadas do Workflow (domínio workflow) — a convenção é uma stack por domínio.',
  ],
};
