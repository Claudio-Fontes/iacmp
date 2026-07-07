import { BaseConstruct } from '@iacmp/core';
import { expr, tag, toSym, crossParamName, SynthContext } from './shared';

// Kept for reference (Standard Redis); not used by Cache.Redis (Enterprise).
export const CACHE_SKU_MAP: Record<string, { name: string; family: string; capacity: number }> = {
  small:  { name: 'Standard', family: 'C', capacity: 1 },
  medium: { name: 'Standard', family: 'C', capacity: 2 },
  large:  { name: 'Premium',  family: 'P', capacity: 1 },
};

export function synthesizeCache(construct: BaseConstruct, ctx: SynthContext): void {
  const { resources, outputs } = ctx;
  const props = (construct.props ?? {}) as Record<string, unknown>;
  const sym = toSym(construct.id);

  switch (construct.type) {
    case 'Cache.Redis': {
      const dbSym = `${sym}Db`;
      const reName = expr(`'${construct.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || 're'}-\${uniqueString(resourceGroup().id)}'`);
      resources.push({ sym, type: 'Microsoft.Cache/redisEnterprise', apiVersion: '2024-10-01', name: reName, location: 'location', tags: tag(construct.id), sku: { name: 'Balanced_B0' }, properties: {} });
      resources.push({ sym: dbSym, type: 'Microsoft.Cache/redisEnterprise/databases', apiVersion: '2024-10-01', parent: sym, name: 'default', properties: { clientProtocol: 'Encrypted', port: 10000, clusteringPolicy: 'EnterpriseCluster', evictionPolicy: 'VolatileLRU', modules: [], persistence: { aofEnabled: false } } });
      outputs.push({ name: crossParamName(construct.id, 'Endpoint'), type: 'string', value: `${sym}.properties.hostName` });
      outputs.push({ name: crossParamName(construct.id, 'Port'), type: 'string', value: `'10000'` });
      outputs.push({ name: crossParamName(construct.id, 'Host'), type: 'string', value: `${sym}.properties.hostName` });
      outputs.push({ name: crossParamName(construct.id, 'ConnectionString'), type: 'string', value: `'rediss://:$\{${dbSym}.listKeys().primaryKey}@$\{${sym}.properties.hostName}:10000'` });
      break;
    }

    case 'Cache.Memcached': {
      resources.push({ sym, type: 'Microsoft.Cache/redis', apiVersion: '2023-08-01', name: `${construct.id}-cache`, location: 'location', tags: tag(construct.id), sku: { name: 'Standard', family: 'C', capacity: (props.numCacheNodes as number) ?? 2 }, properties: { enableNonSslPort: false, minimumTlsVersion: '1.2', redisConfiguration: {} } });
      break;
    }
  }
}
