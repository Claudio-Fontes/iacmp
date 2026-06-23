import { makeProject, rmrf, deployReal, destroyReal, describeStack, readOutput, e2eStackName } from '../support/runner';

describe('Function.Lambda e Events.EventBridge — deploy/destroy real na AWS', () => {
  test('Lambda simples — confirma CREATE_COMPLETE e FunctionArn no Output', () => {
    const stackName = e2eStackName('serverless', 1);
    const stackJs = `
const fs = require('fs');
const path = require('path');
const lambdaDir = path.join(__dirname, '..', 'lambda-fn1');
fs.mkdirSync(lambdaDir, { recursive: true });
fs.writeFileSync(path.join(lambdaDir, 'index.js'), 'exports.handler = async () => ({ statusCode: 200, body: "ok" });\\n');

const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('${stackName}');
new Fn.Lambda(stack, 'HelloFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './lambda-fn1',
  memory: 128,
  timeout: 10,
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
      const fnArn = readOutput(stackName, 'HelloFnArn');
      expect(fnArn).toMatch(/^arn:aws:lambda:/);
    } finally {
      destroyReal(dir);
      rmrf(dir);
    }
  });

  test('Lambda + ApiGateway HTTP — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('serverless', 2);
    const stackJs = `
const fs = require('fs');
const path = require('path');
const lambdaDir = path.join(__dirname, '..', 'lambda-fn2');
fs.mkdirSync(lambdaDir, { recursive: true });
fs.writeFileSync(path.join(lambdaDir, 'index.js'), 'exports.handler = async (ev) => ({ statusCode: 200, body: JSON.stringify({ path: ev.rawPath }) });\\n');

const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('${stackName}');
new Fn.Lambda(stack, 'ApiFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './lambda-fn2',
  memory: 128,
  timeout: 10,
});
new Fn.ApiGateway(stack, 'Api', {
  name: '${stackName}-api',
  type: 'HTTP',
  cors: true,
  routes: [
    { method: 'GET', path: '/', lambdaId: 'ApiFn' },
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
      const fnArn = readOutput(stackName, 'ApiFnArn');
      expect(fnArn).toMatch(/^arn:aws:lambda:/);
    } finally {
      destroyReal(dir);
      rmrf(dir);
    }
  });

  test('EventBridge rule simples — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('serverless', 3);
    const stackJs = `
const { Stack, Events } = require('@iacmp/core');
const stack = new Stack('${stackName}');
new Events.EventBridge(stack, 'Bus', {
  busName: '${stackName}-bus',
  rules: [
    {
      name: '${stackName}-rule',
      source: ['iacmp.e2e'],
      detailTypes: ['TestEvent'],
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
