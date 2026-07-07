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

// Redis Enterprise ConnectionString é uma URL rediss:// — ioredis aceita DIRETAMENTE.
// NÃO use split(',').find('password=') — esse é o formato do Azure Cache for Redis Standard,
// NÃO do Redis Enterprise. A URL rediss:// já inclui TLS e autenticação.
const redis = new Redis(process.env.REDIS_CONNECTION_STRING!);
\`\`\`

- **npm install:** \`ioredis\` (NÃO \`@aws-sdk/client-elasticache\`)
- **Atributos válidos de ref() para Cache.Redis:** \`Host, Port, ConnectionString\`
- \`ConnectionString\` retorna URL no formato \`rediss://:PASSWORD@host:10000\` — passe DIRETO ao new Redis()
- NUNCA faça \`split(',').find(p => p.startsWith('password='))\` — isso é para Azure Cache Standard, NÃO Redis Enterprise
- \`tls: {}\` NÃO é necessário quando se usa a URL \`rediss://\` (TLS já está incluso no scheme)
`;
