import { BaseConstruct } from '@iacmp/core';
import { expr, tag, toSym, crossParamName, SynthContext } from './shared';

// Azure Cache for Redis (Basic/Standard/Premium, Microsoft.Cache/redis) foi
// RETIRADO — novas contas recebem InvalidRequestBody ao tentar criar (mensagem
// de negócio do ARM aponta pra Azure Managed Redis, https://aka.ms/AzureCacheForRedisRetirement).
// O substituto é Microsoft.Cache/redisEnterprise (Azure Managed Redis): cluster
// + um recurso filho `databases` obrigatório. Balanced_B0 é o menor SKU (mesmo
// tier pra free/standard); a diferença de custo/SLA entre tiers vira
// highAvailability (Disabled = sem réplica ~free, Enabled = zone-redundant).
// clusteringPolicy: NoCluster mantém o protocolo Redis clássico (sem MOVED/
// redirect de cluster) — compatível com `new Redis(connectionString)` do
// ioredis sem exigir cliente cluster-aware; é o modo recomendado pra migração
// de instâncias não-clusterizadas (GA agosto/2025, disponível pra instâncias
// ≤25GB — Balanced_B0 está bem dentro do limite).
const REDIS_ENTERPRISE_API_VERSION = '2025-07-01';
const REDIS_ENTERPRISE_PORT = 10000;

export function synthesizeCache(construct: BaseConstruct, ctx: SynthContext): void {
  const { resources, outputs } = ctx;
  const sym = toSym(construct.id);

  switch (construct.type) {
    case 'Cache.Redis': {
      const cacheName = expr(`'${construct.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || 'cache'}-\${uniqueString(resourceGroup().id)}'`);
      const dbSym = `${sym}Db`;
      resources.push({
        sym,
        type: 'Microsoft.Cache/redisEnterprise',
        apiVersion: REDIS_ENTERPRISE_API_VERSION,
        name: cacheName,
        location: 'location',
        tags: tag(construct.id),
        sku: { name: 'Balanced_B0' },
        properties: {
          minimumTlsVersion: '1.2',
          publicNetworkAccess: 'Enabled',
          highAvailability: ctx.accountTier === 'free' ? 'Disabled' : 'Enabled',
        },
      });
      resources.push({
        sym: dbSym,
        type: 'Microsoft.Cache/redisEnterprise/databases',
        apiVersion: REDIS_ENTERPRISE_API_VERSION,
        parent: sym,
        name: 'default',
        properties: {
          clientProtocol: 'Encrypted',
          clusteringPolicy: 'NoCluster',
          evictionPolicy: 'VolatileLRU',
          port: REDIS_ENTERPRISE_PORT,
        },
      });
      outputs.push({ name: crossParamName(construct.id, 'Endpoint'), type: 'string', value: `${sym}.properties.hostName` });
      outputs.push({ name: crossParamName(construct.id, 'Port'), type: 'string', value: `'${REDIS_ENTERPRISE_PORT}'` });
      outputs.push({ name: crossParamName(construct.id, 'Host'), type: 'string', value: `${sym}.properties.hostName` });
      outputs.push({ name: crossParamName(construct.id, 'ConnectionString'), type: 'string', value: `'rediss://:$\{${dbSym}.listKeys().primaryKey}@$\{${sym}.properties.hostName}:${REDIS_ENTERPRISE_PORT}'` });
      break;
    }

    case 'Cache.Memcached': {
      // Azure não tem serviço de Memcached gerenciado — aproximação histórica
      // do provider usa o mesmo motor Redis Enterprise (protocolo diferente do
      // Memcached real; ver AZURE_ATTR_MAP/prompt pra quem consome).
      const dbSym = `${sym}Db`;
      const cacheName = expr(`'${construct.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || 'cache'}-\${uniqueString(resourceGroup().id)}'`);
      resources.push({
        sym,
        type: 'Microsoft.Cache/redisEnterprise',
        apiVersion: REDIS_ENTERPRISE_API_VERSION,
        name: cacheName,
        location: 'location',
        tags: tag(construct.id),
        sku: { name: 'Balanced_B0' },
        properties: {
          minimumTlsVersion: '1.2',
          publicNetworkAccess: 'Enabled',
          highAvailability: ctx.accountTier === 'free' ? 'Disabled' : 'Enabled',
        },
      });
      resources.push({
        sym: dbSym,
        type: 'Microsoft.Cache/redisEnterprise/databases',
        apiVersion: REDIS_ENTERPRISE_API_VERSION,
        parent: sym,
        name: 'default',
        properties: {
          clientProtocol: 'Encrypted',
          clusteringPolicy: 'NoCluster',
          evictionPolicy: 'VolatileLRU',
          port: REDIS_ENTERPRISE_PORT,
        },
      });
      break;
    }
  }
}
