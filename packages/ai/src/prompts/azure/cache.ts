export const CACHE_AZURE = `
## Regras Azure — Cache (Azure Cache for Redis Enterprise)

**Cache.Redis no Azure vira Redis Enterprise (Balanced_B0)**. Porta TLS = **10000** (NUNCA 6379 — essa porta não existe no Redis Enterprise).

### Env vars obrigatórias no Fn.Lambda que acessa Cache.Redis:
\`\`\`typescript
environment: {
  REDIS_HOST: ref('MyCache', 'Host'),
  REDIS_PORT: ref('MyCache', 'Port'),  // resolve para '10000' — NUNCA hardcode '6379'
  REDIS_CONNECTION_STRING: ref('MyCache', 'ConnectionString'),
}
\`\`\`

**REGRA ABSOLUTA:** NUNCA hardcode \`REDIS_PORT: '6379'\` — o Redis Enterprise usa TLS na porta 10000. Sempre use \`ref('MyCache', 'Port')\`.

### Handler com ioredis no Azure:
\`\`\`typescript
import Redis from 'ioredis';

const redis = new Redis({
  host: process.env.REDIS_HOST!,
  port: Number(process.env.REDIS_PORT ?? 10000),  // 10000 para Redis Enterprise (TLS)
  tls: {},  // OBRIGATÓRIO — Redis Enterprise exige TLS
  password: process.env.REDIS_CONNECTION_STRING?.split(',')
    .find(p => p.startsWith('password='))?.split('=')[1],
});
\`\`\`

- **npm install:** \`ioredis\` (NÃO \`@aws-sdk/client-elasticache\`)
- **Atributos válidos de ref() para Cache.Redis:** \`Host, Port, ConnectionString\`
- \`Port\` resolve para \`'10000'\` (TLS do Redis Enterprise) — use diretamente, sem hardcode
- \`tls: {}\` é OBRIGATÓRIO no ioredis — sem ele a conexão é recusada
`;
