import { BaseConstruct, isRef } from '@iacmp/core';
import type { Ref } from '@iacmp/core';

// ── Expr marker ──────────────────────────────────────────────────────────────
export const EXPR = '\x00EXPR\x00';
export function expr(e: string): string { return EXPR + e; }
export function isExpr(v: string): boolean { return v.startsWith(EXPR); }
export function rawExpr(v: string): string { return v.slice(EXPR.length); }

// ── Helpers ──────────────────────────────────────────────────────────────────
export function toSym(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9]/g, '_');
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function safeStorageName(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'storage';
}

export function bv(v: unknown, depth = 0): string {
  const pad = '  '.repeat(depth);
  const inner = '  '.repeat(depth + 1);
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (isExpr(v)) return rawExpr(v);
    return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map(i => `${inner}${bv(i, depth + 1)}`);
    return `[\n${items.join('\n')}\n${pad}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined && val !== null)
    .map(([k, val]) => `${inner}${/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? k : `'${k}'`}: ${bv(val, depth + 1)}`);
  if (entries.length === 0) return '{}';
  return `{\n${entries.join('\n')}\n${pad}}`;
}

export function tag(name: string): Record<string, string> {
  return { Name: name };
}

// ── Ref resolution ───────────────────────────────────────────────────────────
export const AZURE_ATTR_MAP: Record<string, Record<string, string>> = {
  'Network.VPC':           { VpcId: 'id' },
  'Network.Subnet':        { SubnetId: 'id' },
  'Network.SecurityGroup': { GroupId: 'id' },
  'Storage.Bucket':        { Arn: 'id', Name: 'name', ConnectionString: '__blob_connection_string__' },
  'Function.Lambda':       { Arn: 'id', Fqdn: 'properties.defaultHostName' },
  'Database.SQL':          { Endpoint: 'properties.fullyQualifiedDomainName', SecretArn: 'id', Password: 'id', Username: 'id' },
  'Database.DocumentDB':   { Endpoint: 'properties.documentEndpoint', SecretArn: 'id', ConnectionString: '__mongo_connection_string__' },
  'Database.DynamoDB':     { Arn: 'id', Name: 'name', ConnectionString: '__connection_string__' },
  'Messaging.Stream':      { Arn: 'id', Name: 'name' },
  'Messaging.Topic':       { Arn: 'id', TopicArn: 'id' },
  'Messaging.Queue':       { Arn: 'id', QueueUrl: 'id', QueueArn: 'id', ConnectionString: '__sb_connection_string__' },
  'Cache.Redis':           { Endpoint: 'properties.hostName', Host: 'properties.hostName', Port: 'properties.sslPort', ConnectionString: '__redis_cs__' },
  'Secret.Vault':          { SecretArn: 'id', Arn: 'id', VaultUri: 'properties.vaultUri', Name: 'name' },
  'Network.LoadBalancer':  { TargetGroupArn: 'id', DnsName: 'properties.dnsName' },
  'Compute.Container':     { Arn: 'id', Fqdn: 'properties.configuration.ingress.fqdn', DnsName: 'properties.configuration.ingress.fqdn' },
};

export function crossParamName(constructId: string, attribute: string): string {
  return `${constructId.replace(/[^a-zA-Z0-9]/g, '')}${attribute}`;
}

export function resolveRef(r: Ref, idx: Map<string, BaseConstruct>, crossParams: Map<string, string>): string {
  const c = idx.get(r.constructId);
  if (!c) {
    if (/^(password|secretvalue)$/i.test(r.attribute)) {
      crossParams.set('adminPassword', 'secureString');
      return expr('adminPassword');
    }
    const pName = crossParamName(r.constructId, r.attribute);
    if (!crossParams.has(pName)) crossParams.set(pName, 'string:optional');
    return expr(pName);
  }
  const sym = toSym(r.constructId);
  if (c.type === 'Database.DynamoDB' && r.attribute === 'ConnectionString') {
    return expr(`'DefaultEndpointsProtocol=https;AccountName=\${${sym}.name};AccountKey=\${${sym}.listKeys().primaryMasterKey};TableEndpoint=https://\${${sym}.name}.table.cosmos.azure.com:443/;'`);
  }
  if (c.type === 'Database.DynamoDB' && r.attribute === 'Name') {
    return r.constructId;
  }
  if (c.type === 'Database.DocumentDB' && r.attribute === 'ConnectionString') {
    return expr(`${sym}.listConnectionStrings().connectionStrings[0].connectionString`);
  }
  if ((c.type === 'Messaging.Queue' || c.type === 'Messaging.Topic') && r.attribute === 'ConnectionString') {
    const nsSym = `${sym}Ns`;
    return expr(`listKeys(resourceId('Microsoft.ServiceBus/namespaces/authorizationRules', ${nsSym}.name, 'RootManageSharedAccessKey'), '2022-10-01-preview').primaryConnectionString`);
  }
  if (c.type === 'Cache.Redis' && r.attribute === 'ConnectionString') {
    const dbSym = `${sym}Db`;
    return expr(`'rediss://:$\{${dbSym}.listKeys().primaryKey}@$\{${sym}.properties.hostName}:10000'`);
  }
  if (c.type === 'Cache.Redis' && r.attribute === 'Port') {
    return '10000';
  }
  if (c.type === 'Storage.Bucket' && r.attribute === 'ConnectionString') {
    return expr(`'DefaultEndpointsProtocol=https;AccountName=\${${sym}.name};AccountKey=\${${sym}.listKeys().keys[0].value};EndpointSuffix=core.windows.net'`);
  }
  if (c.type === 'Secret.Vault' && r.attribute === 'SecretValue') {
    crossParams.set('adminPassword', 'secureString');
    return expr('adminPassword');
  }
  if (c.type === 'Database.SQL') {
    const engine = ((c.props as Record<string, unknown>).engine as string) ?? 'postgres';
    if (r.attribute === 'Password') {
      crossParams.set('adminPassword', 'secureString');
      return expr('adminPassword');
    }
    if (r.attribute === 'Username') {
      return ({ postgres: 'dbadmin', mysql: 'dbadmin', sqlserver: 'sqladmin', mariadb: 'mariadbadmin' } as Record<string, string>)[engine] ?? 'dbadmin';
    }
    if (r.attribute === 'Port') {
      return ({ postgres: '5432', mysql: '3306', sqlserver: '1433', mariadb: '3306' } as Record<string, string>)[engine] ?? '5432';
    }
  }
  if (c.type === 'Network.Subnet' && r.attribute === 'SubnetId') {
    const subnetProps = c.props as Record<string, unknown>;
    const vpcId = subnetProps.vpcId;
    const vnetConstructId = isRef(vpcId) ? (vpcId as Ref).constructId : vpcId as string;
    const vnetSym = toSym(vnetConstructId);
    return expr(`resourceId('Microsoft.Network/virtualNetworks/subnets', ${vnetSym}.name, '${c.id}')`);
  }
  const attr = AZURE_ATTR_MAP[c.type]?.[r.attribute] ?? 'id';
  return expr(`${sym}.${attr}`);
}

export function resolveValue(v: unknown, idx: Map<string, BaseConstruct>, crossParams: Map<string, string>): unknown {
  if (isRef(v)) return resolveRef(v as Ref, idx, crossParams);
  if (Array.isArray(v)) return v.map(i => resolveValue(i, idx, crossParams));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, resolveValue(val, idx, crossParams)]),
    );
  }
  return v;
}

// ── Internal types ───────────────────────────────────────────────────────────
export interface BicepResource {
  sym: string;
  type: string;
  apiVersion: string;
  name?: unknown;
  location?: string;
  kind?: string;
  sku?: Record<string, unknown>;
  tags?: Record<string, string>;
  parent?: string;
  identity?: Record<string, unknown>;
  properties: Record<string, unknown>;
  dependsOn?: string[];
  condition?: string;
}

export interface BicepOutput {
  name: string;
  type: string;
  value: string;
}

// ── Synth context ─────────────────────────────────────────────────────────────
export interface SynthContext {
  idx: Map<string, BaseConstruct>;
  resources: BicepResource[];
  outputs: BicepOutput[];
  needsAdminPassword: { value: boolean };
  crossParams: Map<string, string>;
  functionImageParams: Set<string>;
  sharedContainerEnvSym: string | null;
  cdnBucketRefs: Set<string>;
  subnetsByVpc: Map<string, Array<{ id: string; cidr: string; public: boolean }>>;
  accountTier: 'free' | 'standard';
}
