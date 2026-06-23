import { makeProject, rmrf, deployReal, destroyReal, describeStack, e2eStackName } from '../support/runner';

describe('Cache.Redis (ElastiCache) — deploy/destroy real na AWS', () => {
  test('cluster Redis cache.t3.micro 1 nó — confirma CREATE_COMPLETE', () => {
    const stackName = e2eStackName('cache', 1);
    const stackJs = `
const { Stack, Cache } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('cache', 1)}');
new Cache.Redis(stack, 'e2e-redis', {
  numCacheNodes: 1,
  nodeType: 'small',
  atRestEncryptionEnabled: false,
  transitEncryptionEnabled: false,
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

describe('Cache.Memcached (ElastiCache) — deploy/destroy real na AWS', () => {
  test.skip('cluster Memcached cache.t3.micro 1 nó — SKIP: AWS::ElastiCache::CacheCluster exige VpcSecurityGroupIds mas { Ref } de SG retorna GroupName não GroupId nessa conta; requer SG ID hardcoded ou VPC+SubnetGroup dedicados', () => {
    const stackName = e2eStackName('cache', 2);
    const stackJs = `
const { Stack, Cache } = require('@iacmp/core');
const stack = new Stack('${e2eStackName('cache', 2)}');
new Cache.Memcached(stack, 'e2e-memcached', {
  numCacheNodes: 1,
  nodeType: 'small',
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
