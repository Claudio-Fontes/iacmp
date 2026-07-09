export const CACHE_AZURE = `
## Regras Azure — Cache (Azure Cache for Redis Enterprise)

**Cache.Redis no Azure vira Redis Enterprise (Balanced_B0)**. Porta TLS = **10000** (NUNCA 6379).

### ÚNICA env var necessária no Fn.Lambda que acessa Cache.Redis:
\`\`\`typescript
environment: {
  REDIS_CONNECTION_STRING: ref('MyCache', 'ConnectionString'),
  // NÃO adicione REDIS_HOST nem REDIS_PORT — a ConnectionString já inclui host, porta e senha
}
\`\`\`

### Handler com ioredis no Azure:
\`\`\`typescript
import Redis from 'ioredis';

// ConnectionString já é rediss://:PASSWORD@host:10000 — passe direto ao construtor
const redis = new Redis(process.env.REDIS_CONNECTION_STRING!);
// NÃO use new Redis({ host, port }) — falta TLS e autenticação
// NÃO use tls: {} — já está incluso no scheme rediss://
\`\`\`

- **npm install:** \`ioredis\`
- **Atributos válidos de ref() para Cache.Redis:** \`Host, Port, ConnectionString\`
- \`ConnectionString\` = \`rediss://:PASSWORD@host:10000\` — TLS + auth embutidos
- NUNCA \`new Redis({ host: process.env.REDIS_HOST, port: ... })\` — sem senha, sem TLS, vai rejeitar
`;
