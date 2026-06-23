import { makeProject, rmrf, deployReal, destroyReal, describeStack, e2eStackName } from '../support/runner';

describe('Messaging.Queue (SQS) — deploy/destroy real na AWS', () => {
  test('SQS Queue simples — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('messaging', 1);
    const stackJs = `
const { Stack, Messaging } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('messaging', 1)}');
new Messaging.Queue(stack, 'Q', { visibilityTimeoutSeconds: 60 });
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

  test('SQS Queue com DLQ — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('messaging', 2);
    const stackJs = `
const { Stack, Messaging } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('messaging', 2)}');
new Messaging.Queue(stack, 'DLQ', { visibilityTimeoutSeconds: 30 });
new Messaging.Queue(stack, 'MainQ', {
  visibilityTimeoutSeconds: 30,
  maxReceiveCount: 3,
  dlqArn: { 'Fn::GetAtt': ['DLQ', 'Arn'] },
});
module.exports = stack;
`;
    const dir = makeProject({
      provider: 'aws',
      stacks: { [`${stackName}.js`]: stackJs },
    });
    try {
      deployReal(dir);
      const { StackStatus, Outputs } = describeStack(stackName);
      expect(StackStatus).toBe('CREATE_COMPLETE');
      // DLQ + MainQ = 2 recursos SQS; sem Outputs automáticos, verificamos só o status
      void Outputs;
    } finally {
      destroyReal(dir);
      rmrf(dir);
    }
  });

  test('SNS Topic simples — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('messaging', 3);
    const stackJs = `
const { Stack, Messaging } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('messaging', 3)}');
new Messaging.Topic(stack, 'T', { displayName: 'iacmp e2e test topic' });
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

  test('SNS Topic + SQS Queue com subscription SQS — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('messaging', 4);
    const stackJs = `
const { Stack, Messaging } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('messaging', 4)}');
new Messaging.Queue(stack, 'SubQ', { visibilityTimeoutSeconds: 30 });
new Messaging.Topic(stack, 'PubT', {
  displayName: 'iacmp e2e pub topic',
  subscriptions: [
    { protocol: 'sqs', endpoint: { 'Fn::GetAtt': ['SubQ', 'Arn'] } },
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
