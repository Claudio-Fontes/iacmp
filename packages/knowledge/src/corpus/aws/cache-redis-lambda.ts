import type { Example } from '../index.js';

export const cacheRedisLambda: Example = {
  id: 'aws-cache-redis-lambda-vpc',
  title: 'Lambda + Cache.Redis (ElastiCache) em VPC',
  tags: ['aws', 'redis', 'ioredis', 'lambda', 'vpc', 'cache', 'elasticache'],
  validated: true,
  stacks: {
    'stacks/network/vpc-stack.ts': `import { Stack, Network } from '@iacmp/core';
const stack = new Stack('app-vpc');
new Network.VPC(stack, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
new Network.Subnet(stack, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', public: false });
new Network.Subnet(stack, 'PrivateSubnet2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', public: false });
new Network.SecurityGroup(stack, 'LambdaSG', { vpcId: 'AppVpc', description: 'Lambda' });
new Network.SecurityGroup(stack, 'RedisSG',  { vpcId: 'AppVpc', description: 'Redis' });
export default stack;`,

    'stacks/database/cache-stack.ts': `import { Stack, Cache } from '@iacmp/core';
const stack = new Stack('app-cache');
new Cache.Redis(stack, 'AppCache', {
  nodeType: 'cache.t3.micro',
  numCacheNodes: 1,
  vpcId: 'AppVpc',
  subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],
  securityGroupIds: ['RedisSG'],
});
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Fn, ref } from '@iacmp/core';
const stack = new Stack('app-api');
new Fn.Lambda(stack, 'CacheFn', {
  runtime: 'nodejs20',
  handler: 'dist/cache.handler',
  code: '.',
  environment: {
    REDIS_HOST: ref('AppCache', 'Endpoint'),
    REDIS_PORT: ref('AppCache', 'Port'),
  },
  vpcId: 'AppVpc',
  subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],
  securityGroupIds: ['LambdaSG'],
});
export default stack;`,
  },
  handlers: {
    'src/cache.ts': `import { Redis } from 'ioredis'; // NUNCA: import Redis from 'ioredis'
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT ?? 6379),
  tls: {}, // ElastiCache exige TLS — usa rediss:// internamente
});
export async function handler(event: any) {
  const key = event.pathParameters?.key ?? 'default';
  const cached = await redis.get(key);
  if (cached) return { statusCode: 200, body: JSON.stringify({ cached: true, value: JSON.parse(cached) }) };
  const value = { computed: Date.now() };
  await redis.setex(key, 300, JSON.stringify(value));
  return { statusCode: 200, body: JSON.stringify({ cached: false, value }) };
}`,
  },
  notes: [
    'import { Redis } from "ioredis" — NUNCA import Redis from "ioredis" (causa TS2351 no build do deploy)',
    'REDIS_HOST: ref("AppCache","Endpoint"), REDIS_PORT: ref("AppCache","Port") — NUNCA hardcode porta',
    'ElastiCache exige TLS — use tls: {} nas opções do Redis para forçar rediss://',
    'Redis fica dentro da VPC — não precisa de VpcEndpoint',
    'Lambda precisa de vpcId + subnetIds + securityGroupIds para alcançar o Redis',
    'Policy.IAM não necessária para Redis — sem IAM de data-plane no ElastiCache',
  ],
};
