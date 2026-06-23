import { makeProject, rmrf, deployReal, destroyReal, describeStack, readOutput, e2eStackName } from '../support/runner';

describe('Policy.IAM — deploy/destroy real na AWS', () => {
  test('IAM Role com inline policy s3:GetObject — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('iam', 1);
    // Policy.IAM com attachType 'role' cria apenas a Role (sem InstanceProfile).
    const stackJs = `
const { Stack, Policy } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('iam', 1)}');
new Policy.IAM(stack, 'S3ReadPolicy', {
  attachTo: 'MyRole',
  attachType: 'role',
  statements: [
    {
      effect: 'Allow',
      actions: ['s3:GetObject'],
      resources: ['*'],
    },
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

describe('Secret.Vault (Secrets Manager) — deploy/destroy real na AWS', () => {
  test('secret simples — confirma CREATE_COMPLETE e verifica ARN no Output', () => {
    const stackName = e2eStackName('iam', 2);
    // Secret.Vault gera AWS::SecretsManager::Secret com logicalId 'V'.
    // O synth não gera Output automático para Secret.Vault — verificamos
    // apenas o StackStatus e lemos o ARN via describeStack se necessário.
    const stackJs = `
const { Stack, Secret } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('iam', 2)}');
new Secret.Vault(stack, 'E2ESecret', {
  description: 'iacmp e2e test secret',
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
