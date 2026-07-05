export const CACHE_AWS = `
## Regras AWS — Cache (ElastiCache Redis / Memcached)

**REGRA Redis em VPC**: para Redis numa VPC, SEMPRE informe \`subnetIds\` (os IDs lógicos das subnets, ex: \`['PrivateSubnet1', 'PrivateSubnet2']\`) e \`securityGroupIds\` — NUNCA use \`subnetGroupName\` com um id de subnet cru (ElastiCache exige um SubnetGroup, não uma subnet; o synth cria o \`AWS::ElastiCache::SubnetGroup\` a partir de \`subnetIds\`). Nas env vars da Lambda que conecta ao cache, use os getters tipados same-stack (\`const cache = new Cache.Redis(...); ... REDIS_HOST: cache.endpoint, REDIS_PORT: cache.port\`) ou, cross-stack, \`ref('ProductsCache', 'Endpoint')\`/a string \`'ProductsCache.Endpoint'\`.

**REGRA TLS no cliente Redis (CRÍTICO):** o synth liga \`transitEncryptionEnabled\` por padrão (\`true\`) — o ElastiCache passa a EXIGIR TLS. Um cliente ioredis que conecta em texto puro (\`new Redis({ host, port })\`) fica pendurado no handshake e a Lambda dá TIMEOUT (não erro claro). SEMPRE conecte com TLS: \`new Redis({ host: process.env.CACHE_HOST, port: Number(process.env.CACHE_PORT), tls: {} })\`. (Só omita \`tls: {}\` se você tiver explicitamente setado \`transitEncryptionEnabled: false\` no construct.) Como \`AuthToken\` fica desabilitado por padrão, não é preciso \`password\`.

**REGRA — ioredis — import nomeado.** Use SEMPRE \`import { Redis } from 'ioredis';\` e \`new Redis({ host, port })\`. NUNCA \`import Redis from 'ioredis'\` (default) nem \`import * as Redis from 'ioredis'\` — com os tipos do ioredis v5 isso dá \`TS2351: This expression is not constructable\` e o build do deploy quebra.
`;
