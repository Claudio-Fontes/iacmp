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
      const cacheName = expr(`'${construct.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || 'cache'}-\${uniqueString(resourceGroup().id)}'`);
      resources.push({ sym, type: 'Microsoft.Cache/redis', apiVersion: '2023-04-01', name: cacheName, location: 'location', tags: tag(construct.id), sku: { name: 'Standard', family: 'C', capacity: 1 }, properties: { enableNonSslPort: false, minimumTlsVersion: '1.2', redisConfiguration: {} } });
      outputs.push({ name: crossParamName(construct.id, 'Endpoint'), type: 'string', value: `${sym}.properties.hostName` });
      outputs.push({ name: crossParamName(construct.id, 'Port'), type: 'string', value: `'6380'` });
      outputs.push({ name: crossParamName(construct.id, 'Host'), type: 'string', value: `${sym}.properties.hostName` });
      outputs.push({ name: crossParamName(construct.id, 'ConnectionString'), type: 'string', value: `'rediss://:$\{${sym}.listKeys().primaryKey}@$\{${sym}.properties.hostName}:6380'` });
      break;
    }

    case 'Cache.Memcached': {
      resources.push({ sym, type: 'Microsoft.Cache/redis', apiVersion: '2023-04-01', name: `${construct.id}-cache`, location: 'location', tags: tag(construct.id), sku: { name: 'Standard', family: 'C', capacity: (props.numCacheNodes as number) ?? 2 }, properties: { enableNonSslPort: false, minimumTlsVersion: '1.2', redisConfiguration: {} } });
      break;
    }
  }
}
