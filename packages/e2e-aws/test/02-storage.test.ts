import { makeProject, rmrf, deployReal, destroyReal, describeStack, e2eStackName } from '../support/runner';

describe('Storage.Bucket (S3) e Storage.Archive — deploy/destroy real na AWS', () => {
  test('S3 Bucket simples — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('storage', 1);
    const stackJs = `
const { Stack, Storage } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('storage', 1)}');
new Storage.Bucket(stack, 'B', {});
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

  test('S3 Bucket com versioning — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('storage', 2);
    const stackJs = `
const { Stack, Storage } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('storage', 2)}');
new Storage.Bucket(stack, 'VB', { versioning: true });
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

  test('Storage.Archive — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('storage', 3);
    const stackJs = `
const { Stack, Storage } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('storage', 3)}');
new Storage.Archive(stack, 'Arch', { retentionDays: 365 });
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
