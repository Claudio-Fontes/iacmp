import { makeProject, rmrf, deployReal, destroyReal, describeStack, e2eStackName } from '../support/runner';

describe('Monitoring.Alarm (CloudWatch) — deploy/destroy real na AWS', () => {
  test('alarm de CPU EC2 threshold 90 — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('monitoring', 1);
    const stackJs = `
const { Stack, Monitoring } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('monitoring', 1)}');
new Monitoring.Alarm(stack, 'CpuAlarm', {
  metricName: 'CPUUtilization',
  namespace: 'AWS/EC2',
  threshold: 90,
  evaluationPeriods: 1,
});
module.exports = stack;
`;
    const dir = makeProject({
      provider: 'aws',
      stacks: { [`${stackName}.js`]: stackJs },
    });
    try {
      deployReal(dir);
      const { StackStatus } = describeStack(stackName);
      expect(StackStatus).toBe('CREATE_COMPLETE');
    } finally {
      destroyReal(dir);
      rmrf(dir);
    }
  });
});

describe('Monitoring.Dashboard (CloudWatch) — deploy/destroy real na AWS', () => {
  test('dashboard com 1 widget de texto — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('monitoring', 2);
    // Monitoring.Dashboard exige widgets não vazio — usa widget tipo text.
    const stackJs = `
const { Stack, Monitoring } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('monitoring', 2)}');
new Monitoring.Dashboard(stack, 'E2EDash', {
  widgets: [
    { type: 'text', title: 'e2e', markdown: '# iacmp e2e dashboard' },
  ],
});
module.exports = stack;
`;
    const dir = makeProject({
      provider: 'aws',
      stacks: { [`${stackName}.js`]: stackJs },
    });
    try {
      deployReal(dir);
      const { StackStatus } = describeStack(stackName);
      expect(StackStatus).toBe('CREATE_COMPLETE');
    } finally {
      destroyReal(dir);
      rmrf(dir);
    }
  });
});

describe('Logging.Stream (CloudWatch Logs) — deploy/destroy real na AWS', () => {
  test('log group com retenção de 1 dia — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('monitoring', 3);
    // O synth usa o construct.id para montar o LogGroupName (/iacmp/<id>).
    // O prop logGroupName não existe no construct — só retentionDays.
    const stackJs = `
const { Stack, Logging } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('monitoring', 3)}');
new Logging.Stream(stack, 'E2ELogGroup', {
  retentionDays: 1,
});
module.exports = stack;
`;
    const dir = makeProject({
      provider: 'aws',
      stacks: { [`${stackName}.js`]: stackJs },
    });
    try {
      deployReal(dir);
      const { StackStatus } = describeStack(stackName);
      expect(StackStatus).toBe('CREATE_COMPLETE');
    } finally {
      destroyReal(dir);
      rmrf(dir);
    }
  });
});
