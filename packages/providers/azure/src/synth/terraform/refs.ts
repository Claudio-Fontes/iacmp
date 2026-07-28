import { Stack, isRef } from '@iacmp/core';
import type { Ref } from '@iacmp/core';
import { toTFId } from './common';

// Construct type → primary TF resource type (for ref resolution)
const CONSTRUCT_TO_TF: Record<string, string> = {
  'Function.Lambda':       'azurerm_linux_function_app',
  'Function.ApiGateway':   'azurerm_api_management',
  'Storage.Bucket':        'azurerm_storage_account',
  'Database.Table':        'azurerm_cosmosdb_account',
  'Database.DynamoDB':     'azurerm_cosmosdb_account',
  'Database.DocumentDB':   'azurerm_cosmosdb_account',
  'Database.SQL':          'azurerm_postgresql_flexible_server',
  'Database.Redis':        'azurerm_redis_cache',
  'Cache.Redis':           'azurerm_redis_cache',
  'Messaging.Queue':       'azurerm_servicebus_queue',
  'Messaging.Topic':       'azurerm_servicebus_topic',
  'Messaging.Stream':      'azurerm_eventhub',
  'Network.VPC':           'azurerm_virtual_network',
  'Network.Subnet':        'azurerm_subnet',
  'Network.SecurityGroup': 'azurerm_network_security_group',
  'Secret.Vault':          'azurerm_key_vault',
  'Compute.Container':     'azurerm_container_app',
};

// Attribute map: construct type → { iacmp attr → tf attribute }
const ATTR_MAP: Record<string, Record<string, string>> = {
  'Function.Lambda':       { Arn: 'id', Fqdn: 'default_hostname' },
  'Function.ApiGateway':   { Arn: 'id' },
  'Storage.Bucket':        { Arn: 'id', Name: 'name', ConnectionString: 'primary_connection_string', SecondaryEndpoint: 'secondary_blob_endpoint' },
  'Database.Table':        { Arn: 'id', Name: 'name', Endpoint: 'endpoint' },
  'Database.DynamoDB':     { Arn: 'id', Name: 'name', Endpoint: 'endpoint' },
  'Database.DocumentDB':   { Arn: 'id', Endpoint: 'endpoint', ConnectionString: 'connection_strings[0]' },
  'Database.SQL':          { Endpoint: 'fqdn', SecretArn: 'id', Password: 'administrator_password', Username: 'administrator_login' },
  'Database.Redis':        { Endpoint: 'hostname', Port: 'ssl_port', Host: 'hostname', ConnectionString: 'primary_connection_string' },
  'Cache.Redis':           { Endpoint: 'hostname', Port: 'ssl_port', Host: 'hostname', ConnectionString: 'primary_connection_string' },
  'Messaging.Queue':       { Arn: 'id', Name: 'name', ConnectionString: 'primary_connection_string' },
  'Messaging.Topic':       { Arn: 'id', TopicArn: 'id', Name: 'name', ConnectionString: 'primary_connection_string' },
  'Messaging.Stream':      { Arn: 'id', Name: 'name', ConnectionString: 'default_primary_connection_string' },
  'Network.VPC':           { VpcId: 'id' },
  'Network.Subnet':        { SubnetId: 'id' },
  'Network.SecurityGroup': { GroupId: 'id' },
  'Secret.Vault':          { Arn: 'id', SecretArn: 'vault_uri' },
  'Compute.Container':     { Arn: 'id', Fqdn: 'ingress[0].fqdn' },
};

export type TFRegistry = Map<string, { tfType: string; tfId: string; constructType: string }>;

export function buildRegistry(allStacks: Stack[]): TFRegistry {
  const reg: TFRegistry = new Map();
  for (const s of allStacks) {
    for (const c of s.constructs) {
      const tfType = CONSTRUCT_TO_TF[c.type];
      if (tfType) reg.set(c.id, { tfType, tfId: toTFId(c.id), constructType: c.type });
    }
  }
  return reg;
}

export function resolveRefStr(constructId: string, attr: string, reg: TFRegistry): string {
  const entry = reg.get(constructId);
  if (!entry) return `REF_UNRESOLVED_${constructId}_${attr}`;
  const tfAttr = (ATTR_MAP[entry.constructType] ?? {})[attr] ?? attr.toLowerCase();
  return `\${${entry.tfType}.${entry.tfId}.${tfAttr}}`;
}

export function resolveDeep(v: unknown, reg: TFRegistry): unknown {
  if (isRef(v)) {
    const r = v as Ref;
    return resolveRefStr(r.constructId, r.attribute, reg);
  }
  if (Array.isArray(v)) return v.map(i => resolveDeep(i, reg));
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, resolveDeep(val, reg)]),
    );
  }
  return v;
}
