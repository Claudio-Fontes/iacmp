import { BaseConstruct, isRef } from '@iacmp/core';
import type { Ref } from '@iacmp/core';

// ── Expr marker ──────────────────────────────────────────────────────────────
// BicepExpr = string marcada como EXPRESSÃO Bicep crua (emitida sem aspas), em
// oposição a um literal (que bv() quota). O branded type documenta a intenção no
// compilador; a proteção de fato contra o bug de aspas duplas é o guard em bv().
export type BicepExpr = string & { readonly __bicepExpr: unique symbol };
export const EXPR = '\x00EXPR\x00';
export function expr(e: string): BicepExpr { return (EXPR + e) as BicepExpr; }
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
    // Guard contra o bug recorrente (fa435fe): uma string que JÁ vem entre aspas
    // simples é quase sempre uma expressão Bicep pré-quotada à mão sem passar por
    // expr() — bv() a quotaria de novo, gerando ''valor'' (nome ARM inválido).
    // Literais legítimos raramente começam e terminam com aspas; se precisar de um
    // valor entre aspas, use expr("'...'"). Falhar em synth-time é melhor que no deploy.
    if (/^'[^'\n]*'$/.test(v)) {
      throw new Error(
        `[bicep] o valor ${v} já vem entre aspas simples. ` +
        `Se é uma expressão Bicep, use expr(${v}); se é um literal, remova as aspas. ` +
        `bv() não re-quota strings já quotadas (evita o bug ''valor'' de nome ARM inválido).`,
      );
    }
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
// DECLARAÇÃO do que o Azure resolve por (tipo, atributo) — o teste de
// consistência garante que é subconjunto do canônico (CONSTRUCT_TYPES).
// Valores `__xxx__` são MARCADORES: esses pares são resolvidos pelos `if`s
// especiais do resolveRef (expressões compostas — listKeys etc.), não pelo
// fallback `sym.<valor>` deste mapa. O fallback só é consultado quando nenhum
// `if` bate. Ao adicionar um atributo novo: entrada aqui + case no resolveRef
// (se composto) + atributo no CONSTRUCT_TYPES do core.
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

// Nome de um output de stack. Identificadores Bicep NÃO aceitam hífen — um
// construct.id como "app-db" geraria `output app-dbEndpoint` (inválido) e não
// bateria com o param `appdbEndpoint` que o consumidor cross-stack pede via
// crossParamName. PRODUTOR (emissão de output) e CONSUMIDOR (resolveRef) TÊM
// que usar a mesma sanitização — por isso outputName é crossParamName.
export const outputName = crossParamName;

export function resolveRef(r: Ref, idx: Map<string, BaseConstruct>, crossParams: Map<string, string>): string {
  const c = idx.get(r.constructId);
  if (!c) {
    if (/^(password|secretvalue|secretarn|secretstring)$/i.test(r.attribute)) {
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
  if ((c.type === 'Messaging.Queue' || c.type === 'Messaging.Topic') && /^(Arn|id|QueueArn|TopicArn|QueueUrl)$/i.test(r.attribute)) {
    return expr(`${sym}Ns.id`);
  }
  if (c.type === 'Cache.Redis' && r.attribute === 'ConnectionString') {
    return expr(`'rediss://:$\{${sym}.listKeys().primaryKey}@$\{${sym}.properties.hostName}:6380'`);
  }
  if (c.type === 'Cache.Redis' && r.attribute === 'Port') {
    return '6380';
  }
  if (c.type === 'Storage.Bucket' && r.attribute === 'ConnectionString') {
    return expr(`'DefaultEndpointsProtocol=https;AccountName=\${${sym}.name};AccountKey=\${${sym}.listKeys().keys[0].value};EndpointSuffix=core.windows.net'`);
  }
  if (c.type === 'Secret.Vault' && /^(SecretValue|SecretArn|SecretString|Arn)$/i.test(r.attribute)) {
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
  scope?: string;
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
  globalIdx: Map<string, BaseConstruct>; // todos os constructs de todas as stacks (lookup de tipo apenas)
  resources: BicepResource[];
  outputs: BicepOutput[];
  needsAdminPassword: { value: boolean };
  crossParams: Map<string, string>;
  functionImageParams: Map<string, string>;
  sharedContainerEnvSym: string | null;
  sharedFunctionStorageSym: string | null;
  sharedFnBlobServiceSym: string | null;
  cdnBucketRefs: Set<string>;
  subnetsByVpc: Map<string, Array<{ id: string; cidr: string; public: boolean }>>;
  accountTier: 'free' | 'standard';
}
