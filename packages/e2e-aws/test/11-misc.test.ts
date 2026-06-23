import { makeProject, rmrf, deployReal, destroyReal, describeStack, e2eStackName } from '../support/runner';

describe('Custom.Resource (escape hatch CFN) — deploy/destroy real na AWS', () => {
  test('SSM Parameter via Custom.Resource cloudformation — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('misc', 1);
    const stackJs = `
const { Stack, Custom } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('misc', 1)}');
new Custom.Resource(stack, 'SsmParam', {
  cloudformation: {
    type: 'AWS::SSM::Parameter',
    properties: {
      Name: '/iacmp/e2e/custom-resource-test',
      Type: 'String',
      Value: 'iacmp-e2e-ok',
    },
  },
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

describe('Compute.Kubernetes (EKS) — deploy/destroy real na AWS', () => {
  test.skip('cluster EKS — SKIP: EKS tem custo fixo de $0.10/hr independente do free tier', () => {
    // EKS cobra $0.10/hr pelo control plane + custo dos worker nodes.
    // Não é viável em conta free tier de e2e. Cobertura garantida pelos testes
    // de synth unitários em packages/providers/aws/test/cloudformation.test.ts.
    const stackName = e2eStackName('misc', 2);
    const stackJs = `
const { Stack, Compute, Network } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('misc', 2)}');
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });
new Compute.Kubernetes(stack, 'EksCluster', {
  version: '1.30',
  subnetIds: [{ Ref: 'VpcPrivateSubnetA' }, { Ref: 'VpcPrivateSubnetB' }],
});
module.exports = stack;
`;
    void stackJs;
  });
});

describe('Network.Dns (Route53) — deploy/destroy real na AWS', () => {
  test('hosted zone pública — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('misc', 3);
    // Route53 HostedZone não exige domínio registrado para criação.
    // O custo é $0.50/hosted zone/mês pro-rated — destroy remove imediatamente.
    const stackJs = `
const { Stack, Network } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('misc', 3)}');
new Network.Dns(stack, 'E2EZone', {
  zoneName: 'iacmp-e2e-test.example',
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

describe('Certificate.TLS (ACM) — deploy/destroy real na AWS', () => {
  test.skip('certificado ACM — SKIP: validação DNS demora minutos; sem domínio real registrado não completa', () => {
    // ACM emite certificados gratuitos mas exige validação DNS ou email.
    // Sem um domínio registrado na conta, CREATE_IN_PROGRESS não avança.
    // Cobertura pelo synth unitário em cloudformation.test.ts.
    void 0;
  });
});
