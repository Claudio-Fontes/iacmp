import { makeProject, rmrf, deployReal, destroyReal, describeStack, e2eStackName } from '../support/runner';

describe('Compute.Instance (EC2) — deploy/destroy real na AWS', () => {
  test('t3.small (small) com Amazon Linux 2 — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('compute', 1);
    // instanceType 'small' → t3.small via INSTANCE_TYPE_MAP
    // image 'amazon-linux-2' → resolve:ssm AMI via AMI_MAP
    const stackJs = `
const { Stack, Compute } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('compute', 1)}');
new Compute.Instance(stack, 'EC2Instance', {
  instanceType: 'small',
  image: 'amazon-linux-2',
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

describe('Compute.AutoScaling — deploy/destroy real na AWS', () => {
  test('ASG mínimo 1/1 com Amazon Linux 2 — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('compute', 2);
    const stackJs = `
const { Stack, Compute } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('compute', 2)}');
new Compute.AutoScaling(stack, 'ASGMin', {
  instanceType: 'small',
  image: 'amazon-linux-2',
  minCapacity: 1,
  maxCapacity: 1,
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

describe('Compute.Container (ECS Fargate) — deploy/destroy real na AWS', () => {
  test('task nginx com cpu 256 memory 512 — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('compute', 3);
    const stackJs = `
const { Stack, Compute, Network } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('compute', 3)}');
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });
new Compute.Container(stack, 'NginxTask', {
  image: 'nginx:alpine',
  cpu: 256,
  memory: 512,
  publicIp: true,
  desiredCount: 0,
  subnetIds: [{ Ref: 'VpcPublicSubnetA' }, { Ref: 'VpcPublicSubnetB' }],
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
