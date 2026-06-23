import { makeProject, rmrf, deployReal, destroyReal, describeStack, e2eStackName } from '../support/runner';

describe('Network.LoadBalancer (ALB) — deploy/destroy real na AWS', () => {
  test('ALB internet-facing com VPC e 2 subnets — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('network', 1);
    // Network.VPC com maxAzs: 2 gera subnets públicas com IDs VpcPublicSubnetA/B.
    // O LoadBalancer referencia essas subnets via { Ref: '...' }.
    const stackJs = `
const { Stack, Network } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('network', 1)}');
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });
new Network.LoadBalancer(stack, 'ALB', {
  type: 'application',
  scheme: 'internet-facing',
  vpcId: { Ref: 'Vpc' },
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

describe('Network.WAF — deploy/destroy real na AWS', () => {
  test('WebACL REGIONAL sem regras customizadas — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('network', 2);
    const stackJs = `
const { Stack, Network } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('network', 2)}');
new Network.WAF(stack, 'SimpleWAF', {
  scope: 'REGIONAL',
  defaultAction: 'allow',
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

describe('Network.CDN (CloudFront) — deploy/destroy real na AWS', () => {
  test('distribuição com origin S3 — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('network', 3);
    // Storage.Bucket gera um S3 com logicalId 'B'.
    // Fn::GetAtt ['B', 'DomainName'] resolve o endpoint S3 como origin.
    const stackJs = `
const { Stack, Network, Storage } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('network', 3)}');
new Storage.Bucket(stack, 'B', {});
new Network.CDN(stack, 'CDN', {
  origins: [{
    id: 'S3Origin',
    domainName: { 'Fn::GetAtt': ['B', 'DomainName'] },
    protocol: 'https-only',
  }],
  defaultRootObject: 'index.html',
  priceClass: 'PriceClass_100',
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
