import type { Example } from '../index.js';

export const eventbridgeCron: Example = {
  id: 'aws-eventbridge-cron',
  title: 'Agendamento cron com EventBridge acionando Lambda',
  tags: ['aws', 'eventbridge', 'schedule', 'cron', 'lambda'],
  validated: true,
  stacks: {
    'stacks/compute/report-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('report-job');
new Fn.Lambda(stack, 'GenerateReportFn', {
  runtime: 'nodejs20',
  handler: 'dist/generateReport.handler',
  code: '.',
  timeout: 60,
});
export default stack;`,

    'stacks/events/schedule-stack.ts': `import { Stack, Events } from '@iacmp/core';
const stack = new Stack('report-schedule');
new Events.EventBridge(stack, 'DailyReportSchedule', {
  rules: [
    {
      name: 'daily-report',
      description: 'Gera o relatório diário às 08:00 UTC',
      cron: '0 8 * * ? *',
      targetLambdaId: 'GenerateReportFn',
    },
  ],
});
export default stack;`,
  },
  handlers: {
    'src/generateReport.ts': `export const handler = async () => {
  console.log('Gerando relatório diário em', new Date().toISOString());
  // ... lógica do relatório
};`,
  },
  notes: [
    'cron: "0 8 * * ? *" — SEM o wrapper cron(...); o synth adiciona automaticamente (ScheduleExpression: cron(0 8 * * ? *))',
    'Formato cron do EventBridge usa 6 campos com "?" — igual ao Unix cron NÃO É o mesmo formato (dia-da-semana precisa de "?" quando dia-do-mês é "*")',
    'Alternativa a cron: rate: "5 minutes" ou rate: "1 hour" — mutuamente exclusivo com cron',
    'targetLambdaId usa o ID LÓGICO da Fn.Lambda (não ARN) — o synth resolve o ARN e cria a AWS::Lambda::Permission que autoriza o EventBridge a invocar (SEM isso a rule dispara mas a invocação falha silenciosamente)',
    'Nenhuma Policy.IAM necessária — a permissão de invocação é da rule para a Lambda, não o inverso; a Lambda usa a role default (CloudWatch Logs) se não precisar de mais nada',
    'Events.EventBridge e Fn.Lambda em stacks separadas (events/schedule, compute/report) — evita monolito',
  ],
};
