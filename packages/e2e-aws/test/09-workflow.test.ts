import { makeProject, rmrf, deployReal, destroyReal, describeStack, e2eStackName } from '../support/runner';

describe('Workflow.StepFunctions — deploy/destroy real na AWS', () => {
  test('state machine STANDARD com um step Pass — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('workflow', 1);
    // steps[0].type 'Pass' gera um estado Pass sem Resource obrigatório.
    // O synth gera AWS::StepFunctions::StateMachine com DefinitionString via Fn::Sub.
    const stackJs = `
const { Stack, Workflow } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('workflow', 1)}');
new Workflow.StepFunctions(stack, 'E2EStateMachine', {
  type: 'STANDARD',
  description: 'iacmp e2e test state machine',
  steps: [
    { name: 'PassStep', type: 'Pass' },
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
