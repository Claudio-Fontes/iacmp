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
  'Storage.Bucket':        { Arn: 'id', Name: 'name', ConnectionString: '__blob_connection_string__', SecondaryEndpoint: 'properties.secondaryEndpoints.blob' },
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

// ── VNet integration (subnetIds) ─────────────────────────────────────────────
// Resolve um subnetId (string de props.subnetIds — nunca um Ref) para os dados
// necessários a delegatedSubnetResourceId/infrastructureSubnetId (Database.SQL,
// Compute.Container) e ao id da VNet (virtualNetworkLinks do private DNS).
//
// Same-stack (subnet e consumidor na MESMA stack): referência SIMBÓLICA aos
// recursos declarados no mesmo arquivo (${vnetSym}.name / ${vnetSym}.id) — o
// nome do VNet é literal (name: construct.id — ver Network.VPC), mas usar o
// símbolo em vez da string crua dá um dependsOn implícito real dentro do
// arquivo (Bicep detecta a referência ao resource).
//
// Cross-stack (subnet declarada em OUTRA stack — ex: rede separada de banco):
// NUNCA embuta o resourceId literal aqui. Bug real de bateria (p09): isso
// "resolve" o endereçamento mas apaga a ORDENAÇÃO — generateAzureMainBicep
// (packages/cli/src/synth-out.ts) só cria dependsOn entre módulos quando um
// param HARD de uma stack casa com um output de outra (parseBicepModule);
// sem esse casamento de nomes, o módulo do banco/container pode deployar
// ANTES do módulo da VNet terminar → corrida não-determinística no ARM.
// Por isso aqui só declaramos um param HARD (crossParams) cujo nome bate com
// o output que Network.VPC exporta para cada VNet/subnet — mesmíssimo
// mecanismo já usado para Fqdn/ConnectionString, nenhum special-case novo.
export interface ResolvedSubnet {
  vpcId: string;
  cidr?: string;
  /** Expressão Bicep pronta para delegatedSubnetResourceId / infrastructureSubnetId. */
  subnetResourceIdExpr: BicepExpr;
  /** Expressão Bicep pronta para o id da própria VNet (ex: virtualNetworkLinks.properties.virtualNetwork.id). */
  vpcResourceIdExpr: BicepExpr;
}

export function resolveSubnetForVnetIntegration(
  subnetId: string,
  ctx: { idx: Map<string, BaseConstruct>; globalIdx: Map<string, BaseConstruct>; crossParams: Map<string, string> },
): ResolvedSubnet {
  const isLocal = ctx.idx.has(subnetId);
  const c = ctx.idx.get(subnetId) ?? ctx.globalIdx.get(subnetId);
  if (!c || c.type !== 'Network.Subnet') {
    throw new Error(
      `[azure] subnetIds referencia "${subnetId}", mas não há Network.Subnet com esse id em nenhuma stack. ` +
      `Declare o Network.Subnet antes de referenciá-lo.`,
    );
  }
  const p = c.props as Record<string, unknown>;
  const vpcIdRaw = p.vpcId;
  const vpcId = isRef(vpcIdRaw) ? (vpcIdRaw as Ref).constructId : vpcIdRaw as string;
  const cidr = p.cidr as string | undefined;

  if (isLocal) {
    const vnetSym = toSym(vpcId);
    return {
      vpcId,
      cidr,
      subnetResourceIdExpr: expr(`resourceId('Microsoft.Network/virtualNetworks/subnets', ${vnetSym}.name, '${subnetId}')`),
      vpcResourceIdExpr: expr(`${vnetSym}.id`),
    };
  }

  const subnetParam = crossParamName(subnetId, 'SubnetId');
  const vpcParam = crossParamName(vpcId, 'VpcId');
  ctx.crossParams.set(subnetParam, 'string');
  ctx.crossParams.set(vpcParam, 'string');
  return {
    vpcId,
    cidr,
    subnetResourceIdExpr: expr(subnetParam),
    vpcResourceIdExpr: expr(vpcParam),
  };
}

export function cidrPrefixLength(cidr: string | undefined): number | undefined {
  if (!cidr) return undefined;
  const m = /\/(\d{1,2})$/.exec(cidr);
  return m ? Number(m[1]) : undefined;
}

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
    return expr(`${sym}.listConnectionStrings().connectionStrings[0].connectionString`);
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
    // ConnectionString usa o database filho (${sym}Db) — listKeys() do cluster
    // redisEnterprise não expõe chaves; quem tem accessKeys é o `databases/default`.
    return expr(`'rediss://:$\{${sym}Db.listKeys().primaryKey}@$\{${sym}.properties.hostName}:10000'`);
  }
  if (c.type === 'Cache.Redis' && r.attribute === 'Port') {
    return '10000';
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
  /** Marca o recurso como `existing` (referência a um recurso já provisionado
   * fora deste template — ex: APIM compartilhado). Recursos `existing` só
   * aceitam name/scope/parent no Bicep; location/kind/sku/tags/identity/
   * dependsOn/properties são ignorados na emissão (ver renderBicep). */
  existing?: boolean;
  /** Quando setado, este item NÃO é um `resource` — é um `module` Bicep apontando
   * para um arquivo-irmão (ex: filhos do APIM compartilhado quando o RG do APIM
   * difere do RG do projeto — ver Function.ApiGateway/emitBicep). `type`/`apiVersion`
   * são ignorados na emissão; `properties` vira o bloco `params:` do module;
   * `name` vira o nome da implantação (`Microsoft.Resources/deployments`). */
  moduleFile?: string;
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
  cdnBucketRefs: Set<string>;
  subnetsByVpc: Map<string, Array<{ id: string; cidr: string; public: boolean; delegationService?: string }>>;
  accountTier: 'free' | 'standard';
  /** subnetId → sym do Microsoft.App/managedEnvironments dedicado criado para essa subnet.
   * Vários Compute.Container que apontam para a MESMA subnet compartilham UM env
   * (uma subnet só pode ter uma infrastructureSubnetId associada por vez). */
  dedicatedContainerEnvs: Map<string, string>;
  /** subnetIds/vpcIds que precisam do output cross-stack VpcId/SubnetId (ver
   * network.ts, case Network.VPC) — só os efetivamente consumidos por um
   * Database.SQL/Compute.Container em OUTRA stack (evita poluir stacks de rede
   * sem consumidor com outputs não usados). */
  crossStackSubnetIds: Set<string>;
  crossStackVpcIds: Set<string>;
  /** APIM compartilhado (iacmp.json → azure.sharedApim). Quando presente,
   * Function.ApiGateway referencia o serviço como `existing` em vez de criá-lo,
   * e prefixa os nomes dos filhos (api/backends/namedValues) com `projectSlug`
   * para não colidir com outros projetos no mesmo APIM. */
  sharedApim?: {
    name: string;
    resourceGroup: string;
    /** true quando resourceGroup do APIM difere do RG de deploy do projeto — exige `scope: resourceGroup('...')` no existing. */
    crossRg: boolean;
    projectSlug: string;
    /** Symbol fixo do `module` que agrega os filhos do APIM quando crossRg=true
     * (reaproveitado por todos os Function.ApiGateway da stack — um só module
     * por stack, mesmo com múltiplos API Gateways). Irrelevante quando crossRg=false. */
    crossRgModuleSym: string;
  };
  /** Acumulador dos filhos do APIM compartilhado quando sharedApim.crossRg é true
   * (ver Function.ApiGateway). Bicep proíbe que um recurso filho (`parent:`) de um
   * `existing` cross-resource-group herde escopo diferente do arquivo (BCP165) —
   * a única saída é um module aninhado com `scope: resourceGroup(...)` próprio.
   * emitBicep renderiza isto como um arquivo .bicep-irmão ao final do synth. */
  apimCrossRgChild?: {
    resources: BicepResource[];
    outputs: BicepOutput[];
    /** nome do param do módulo-filho → expressão Bicep (calculada no escopo do
     * template pai) que vira o VALOR desse param na invocação do `module`. */
    params: Map<string, string>;
    existingDeclared: boolean;
  };
}
