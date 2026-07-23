import type { Example } from '../index.js';

export const cacheRedis: Example = {
  id: 'azure-cache-redis',
  title: 'Azure Managed Redis (redisEnterprise) + Function com cache',
  tags: ['azure', 'redis', 'ioredis', 'cache', 'redisenterprise', 'managed-redis', 'function'],
  // synth-validado; deploy pendente de subscription paga (Managed Redis não tem tier grátis)
  validated: false,
  stacks: {
    'stacks/database/cache-stack.ts': `import { Stack, Cache } from '@iacmp/core';
const stack = new Stack('app-cache');
new Cache.Redis(stack, 'AppCache', { nodeType: 'small' });
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Fn, ref } from '@iacmp/core';
const stack = new Stack('app-api');
new Fn.Lambda(stack, 'CacheFn', {
  runtime: 'nodejs20',
  handler: 'dist/cache.handler',
  code: '.',
  environment: {
    REDIS_URL: ref('AppCache', 'ConnectionString'),
  },
});
export default stack;`,
  },
  handlers: {
    'src/cache.ts': `import { Redis } from 'ioredis'; // NUNCA: import Redis from 'ioredis'
// A URL rediss://:<key>@<host>:10000 já traz TLS e porta — não setar host/port/tls separados.
const redis = new Redis(process.env.REDIS_URL as string);
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
    'Cache.Redis no Azure → Microsoft.Cache/redisEnterprise (Azure Managed Redis), SKU Balanced_B0 — o clássico Microsoft.Cache/redis foi RETIRADO pela plataforma (recusa criação)',
    'Conexão via ref("AppCache","ConnectionString") → rediss://:<key>@<host>:10000 — TLS na porta 10000, NUNCA 6379',
    'import { Redis } from "ioredis" — NUNCA import Redis from "ioredis" (TS2351 no build)',
    'new Redis(process.env.REDIS_URL) — a URL rediss:// já traz TLS e porta; não setar host/port/tls à parte',
    'Managed Redis NÃO tem tier grátis: validated:false = synth-validado, deploy pendente de subscription paga',
  ],
};
