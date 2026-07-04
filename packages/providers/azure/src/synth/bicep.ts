import { Stack, BaseConstruct, isRef } from '@iacmp/core';
import type { Ref } from '@iacmp/core';

// ── Expr marker ──────────────────────────────────────────────────────────────
const EXPR = '\x00EXPR\x00';
function expr(e: string): string { return EXPR + e; }
function isExpr(v: string): boolean { return v.startsWith(EXPR); }
function rawExpr(v: string): string { return v.slice(EXPR.length); }

// ── Helpers ──────────────────────────────────────────────────────────────────
function toSym(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9]/g, '_');
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function safeStorageName(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'storage';
}

function bv(v: unknown, depth = 0): string {
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
    // Chaves com caracteres especiais (ponto, hífen, espaço) precisam de aspas em Bicep
    .map(([k, val]) => `${inner}${/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? k : `'${k}'`}: ${bv(val, depth + 1)}`);
  if (entries.length === 0) return '{}';
  return `{\n${entries.join('\n')}\n${pad}}`;
}

// ── Ref resolution ───────────────────────────────────────────────────────────
const AZURE_ATTR_MAP: Record<string, Record<string, string>> = {
  'Network.VPC':           { VpcId: 'id' },
  'Network.Subnet':        { SubnetId: 'id' },
  'Network.SecurityGroup': { GroupId: 'id' },
  'Storage.Bucket':        { Arn: 'id', Name: 'name' },
  'Function.Lambda':       { Arn: 'id' },
  'Database.SQL':          { Endpoint: 'properties.fullyQualifiedDomainName', SecretArn: 'id', Password: 'id', Username: 'id' },
  'Database.DocumentDB':   { Endpoint: 'properties.documentEndpoint', SecretArn: 'id' },
  'Database.DynamoDB':     { Arn: 'id', Name: 'name', ConnectionString: '__connection_string__' },
  'Messaging.Topic':       { Arn: 'id', TopicArn: 'id' },
  'Messaging.Queue':       { Arn: 'id', QueueUrl: 'id', QueueArn: 'id' },
  'Cache.Redis':           { Endpoint: 'properties.hostName', Port: 'properties.sslPort' },
  'Secret.Vault':          { SecretArn: 'id', Arn: 'id' },
  'Network.LoadBalancer':  { TargetGroupArn: 'id', DnsName: 'properties.dnsName' },
};

function crossParamName(constructId: string, attribute: string): string {
  return `${constructId.replace(/[^a-zA-Z0-9]/g, '')}${attribute}`;
}

function resolveRef(r: Ref, idx: Map<string, BaseConstruct>, crossParams: Map<string, string>): string {
  const c = idx.get(r.constructId);
  if (!c) {
    // Referência cross-stack — vira parâmetro no template
    const pName = crossParamName(r.constructId, r.attribute);
    crossParams.set(pName, 'string');
    return expr(pName);
  }
  const sym = toSym(r.constructId);
  // ConnectionString do Cosmos DB (Table API) é computada com listKeys() — não é property simples.
  if (c.type === 'Database.DynamoDB' && r.attribute === 'ConnectionString') {
    return expr(`'DefaultEndpointsProtocol=https;AccountName=\${${sym}.name};AccountKey=\${${sym}.listKeys().primaryMasterKey};TableEndpoint=https://\${${sym}.name}.table.cosmos.azure.com:443/;'`);
  }
  // Name do Cosmos = nome da TABELA (child resource, = construct.id), não o da conta.
  if (c.type === 'Database.DynamoDB' && r.attribute === 'Name') {
    return r.constructId;
  }
  // Database.SQL: Password/Username/Port viram valores REAIS (o attr map genérico
  // caía em `.id` — resource ID do ARM ia parar na env do handler; ciclo p01az6).
  if (c.type === 'Database.SQL') {
    const engine = ((c.props as Record<string, unknown>).engine as string) ?? 'postgres';
    if (r.attribute === 'Password') {
      // A senha é o param @secure() adminPassword — o deploy gera e injeta o
      // MESMO valor em todas as stacks que declaram o param.
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
  const attr = AZURE_ATTR_MAP[c.type]?.[r.attribute] ?? 'id';
  return expr(`${sym}.${attr}`);
}

function resolveValue(v: unknown, idx: Map<string, BaseConstruct>, crossParams: Map<string, string>): unknown {
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
interface BicepResource {
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
}

interface BicepOutput {
  name: string;
  type: string;
  value: string;
}

// ── Renderer ─────────────────────────────────────────────────────────────────
function renderBicep(
  params: Array<{ name: string; type: string; default?: unknown; secure?: boolean }>,
  resources: BicepResource[],
  outputs: BicepOutput[],
): string {
  const lines: string[] = [];

  for (const p of params) {
    if (p.secure) lines.push('@secure()');
    const def = p.default !== undefined ? ` = ${bv(p.default)}` : '';
    lines.push(`param ${p.name} ${p.type}${def}`);
  }
  if (params.length > 0) lines.push('');

  for (const r of resources) {
    const fields: Array<[string, unknown]> = [];
    if (r.parent) fields.push(['parent', expr(r.parent)]);
    if (r.name !== undefined) fields.push(['name', r.name]);
    if (r.location) fields.push(['location', expr(r.location)]);
    if (r.kind) fields.push(['kind', r.kind]);
    if (r.sku) fields.push(['sku', r.sku]);
    if (r.tags) fields.push(['tags', r.tags]);
    if (r.identity) fields.push(['identity', r.identity]);
    if (r.dependsOn && r.dependsOn.length > 0) {
      fields.push(['dependsOn', expr(`[\n    ${r.dependsOn.join('\n    ')}\n  ]`)]);
    }
    fields.push(['properties', r.properties]);

    lines.push(`resource ${r.sym} '${r.type}@${r.apiVersion}' = {`);
    for (const [k, v] of fields) {
      lines.push(`  ${k}: ${bv(v, 1)}`);
    }
    lines.push('}');
    lines.push('');
  }

  for (const o of outputs) {
    lines.push(`output ${o.name} ${o.type} = ${o.value}`);
  }

  return lines.join('\n');
}

// ── Maps ─────────────────────────────────────────────────────────────────────
const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 'Standard_B1s',
  medium: 'Standard_B2s',
  large: 'Standard_B4ms',
};

interface AzureImageRef {
  publisher: string;
  offer: string;
  sku: string;
  version: string;
  isWindows: boolean;
}

const IMAGE_MAP: Record<string, AzureImageRef> = {
  'ubuntu':        { publisher: 'Canonical', offer: 'UbuntuServer', sku: '22_04-lts', version: 'latest', isWindows: false },
  'ubuntu-22.04':  { publisher: 'Canonical', offer: 'UbuntuServer', sku: '22_04-lts', version: 'latest', isWindows: false },
  'ubuntu-20.04':  { publisher: 'Canonical', offer: 'UbuntuServer', sku: '20_04-lts', version: 'latest', isWindows: false },
  'windows-2022':  { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2022-Datacenter', version: 'latest', isWindows: true },
  'windows-2019':  { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2019-Datacenter', version: 'latest', isWindows: true },
  'windows-2016':  { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2016-Datacenter', version: 'latest', isWindows: true },
};

function resolveAzureImage(image: string): { imageReference: Record<string, unknown>; isWindows: boolean } {
  const mapped = IMAGE_MAP[image];
  if (mapped) {
    const { isWindows, ...ref } = mapped;
    return { imageReference: ref, isWindows };
  }
  return { imageReference: { offer: image }, isWindows: false };
}

// SKU do flexible server (Postgres/MySQL) por tier. free = Burstable B1ms
// (~$12/mês, a mais barata elegível); standard = GeneralPurpose.
function flexibleServerSku(accountTier: 'free' | 'standard'): { name: string; tier: string } {
  return accountTier === 'free'
    ? { name: 'Standard_B1ms', tier: 'Burstable' }
    : { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' };
}

const CACHE_SKU_MAP: Record<string, { name: string; family: string; capacity: number }> = {
  small:  { name: 'Standard', family: 'C', capacity: 1 },
  medium: { name: 'Standard', family: 'C', capacity: 2 },
  large:  { name: 'Premium',  family: 'P', capacity: 1 },
};

function tag(name: string): Record<string, string> {
  return { Name: name };
}

// ── Per-construct synthesis ───────────────────────────────────────────────────
function synthesizeConstruct(
  construct: BaseConstruct,
  idx: Map<string, BaseConstruct>,
  resources: BicepResource[],
  outputs: BicepOutput[],
  needsAdminPassword: { value: boolean },
  crossParams: Map<string, string>,
  functionImageParams: Set<string>,
  sharedContainerEnvSym: string | null,
  cdnBucketRefs: Set<string>,
  accountTier: 'free' | 'standard' = 'standard',
): void {
  const props = construct.props as Record<string, unknown>;
  const sym = toSym(construct.id);

  switch (construct.type) {

    case 'Compute.Instance': {
      const { imageReference, isWindows } = resolveAzureImage(props.image as string ?? 'ubuntu');
      resources.push({
        sym,
        type: 'Microsoft.Compute/virtualMachines',
        apiVersion: '2023-03-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        properties: {
          hardwareProfile: { vmSize: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 'Standard_B1s' },
          storageProfile: { imageReference },
          osProfile: {
            computerName: construct.id,
            adminUsername: isWindows ? 'adminuser' : 'azureuser',
            ...(isWindows
              ? { windowsConfiguration: { provisionVMAgent: true, enableAutomaticUpdates: true } }
              : { linuxConfiguration: { disablePasswordAuthentication: true } }),
          },
        },
      });
      break;
    }

    case 'Compute.AutoScaling': {
      const { imageReference: asImageRef, isWindows: asIsWindows } = resolveAzureImage(props.image as string ?? 'ubuntu');
      const vmssSym = sym;
      const autoscaleSym = `${sym}Autoscale`;
      resources.push({
        sym: vmssSym,
        type: 'Microsoft.Compute/virtualMachineScaleSets',
        apiVersion: '2023-03-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        sku: {
          name: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 'Standard_B1s',
          tier: 'Standard',
          capacity: (props.desiredCapacity as number) ?? (props.minCapacity as number),
        },
        properties: {
          overprovision: true,
          upgradePolicy: { mode: 'Automatic' },
          virtualMachineProfile: {
            storageProfile: { imageReference: asImageRef },
            osProfile: {
              computerNamePrefix: construct.id.slice(0, 9),
              adminUsername: asIsWindows ? 'adminuser' : 'azureuser',
              ...(asIsWindows
                ? { windowsConfiguration: { provisionVMAgent: true, enableAutomaticUpdates: true } }
                : { linuxConfiguration: { disablePasswordAuthentication: true } }),
            },
          },
        },
      });
      resources.push({
        sym: autoscaleSym,
        type: 'Microsoft.Insights/autoscaleSettings',
        apiVersion: '2022-10-01',
        name: `${construct.id}-autoscale`,
        location: 'location',
        properties: {
          enabled: true,
          targetResourceUri: expr(`${vmssSym}.id`),
          profiles: [{
            name: 'default',
            capacity: {
              minimum: String(props.minCapacity ?? 1),
              maximum: String(props.maxCapacity ?? 10),
              default: String(props.desiredCapacity ?? props.minCapacity ?? 1),
            },
            rules: props.targetCpuUtilization ? [{
              metricTrigger: {
                metricName: 'Percentage CPU',
                metricResourceUri: expr(`${vmssSym}.id`),
                timeGrain: 'PT1M',
                statistic: 'Average',
                timeWindow: 'PT5M',
                timeAggregation: 'Average',
                operator: 'GreaterThan',
                threshold: props.targetCpuUtilization,
              },
              scaleAction: { direction: 'Increase', type: 'ChangeCount', value: '1', cooldown: 'PT5M' },
            }] : [],
          }],
        },
      });
      break;
    }

    case 'Compute.Container': {
      const environment = (props.environment as Record<string, string>) ?? {};
      const envVars = Object.entries(environment).map(([k, v]) => ({ name: k, value: v }));
      resources.push({
        sym,
        type: 'Microsoft.ContainerInstance/containerGroups',
        apiVersion: '2023-05-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        properties: {
          containers: [{
            name: construct.id,
            properties: {
              image: props.image as string,
              resources: {
                requests: {
                  cpu: Math.round((props.cpu as number ?? 256) / 1024 * 10) / 10,
                  memoryInGB: Math.round((props.memory as number ?? 512) / 1024 * 10) / 10,
                },
              },
              ports: props.port ? [{ port: props.port, protocol: 'TCP' }] : [],
              environmentVariables: envVars,
            },
          }],
          osType: 'Linux',
          ipAddress: {
            type: 'Public',
            ports: props.port ? [{ port: props.port, protocol: 'TCP' }] : [],
          },
          restartPolicy: 'OnFailure',
        },
      });
      break;
    }

    case 'Compute.Kubernetes': {
      const nodeType = INSTANCE_TYPE_MAP[props.nodeInstanceType as string] ?? 'Standard_B2s';
      resources.push({
        sym,
        type: 'Microsoft.ContainerService/managedClusters',
        apiVersion: '2023-05-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        identity: { type: 'SystemAssigned' },
        properties: {
          kubernetesVersion: (props.version as string) ?? '1.29',
          dnsPrefix: construct.id,
          enableRBAC: true,
          agentPoolProfiles: [{
            name: 'nodepool1',
            count: (props.desiredNodes as number) ?? 2,
            minCount: (props.minNodes as number) ?? 1,
            maxCount: (props.maxNodes as number) ?? 3,
            enableAutoScaling: true,
            vmSize: nodeType,
            mode: 'System',
          }],
          apiServerAccessProfile: { enablePrivateCluster: (props.privateCluster as boolean) ?? false },
          networkProfile: { networkPlugin: 'kubenet', loadBalancerSku: 'standard' },
        },
      });
      break;
    }

    case 'Storage.Bucket': {
      const storageName = safeStorageName(construct.id);
      resources.push({
        sym,
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: storageName,
        location: 'location',
        kind: 'StorageV2',
        sku: { name: 'Standard_LRS' },
        tags: tag(construct.id),
        properties: {
          allowBlobPublicAccess: (props.publicAccess as boolean) ?? false,
          supportsHttpsTrafficOnly: true,
          minimumTlsVersion: 'TLS1_2',
        },
      });
      // blobServices 'default': versioning e/ou CORS (upload/download do browser).
      const corsRules = props.cors as Array<Record<string, unknown>> | undefined;
      if (props.versioning || (corsRules && corsRules.length > 0)) {
        const blobProps: Record<string, unknown> = {};
        if (props.versioning) blobProps.isVersioningEnabled = true;
        if (corsRules && corsRules.length > 0) {
          blobProps.cors = {
            corsRules: corsRules.map(c => ({
              allowedMethods: (c.allowedMethods as string[]) ?? ['GET'],
              allowedOrigins: (c.allowedOrigins as string[]) ?? ['*'],
              allowedHeaders: (c.allowedHeaders as string[]) ?? ['*'],
              exposedHeaders: (c.exposedHeaders as string[]) ?? ['*'],
              maxAgeInSeconds: (c.maxAgeSeconds as number) ?? 3600,
            })),
          };
        }
        resources.push({
          sym: `${sym}BlobService`,
          type: 'Microsoft.Storage/storageAccounts/blobServices',
          apiVersion: '2023-01-01',
          parent: sym,
          name: 'default',
          properties: blobProps,
        });
      }
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${sym}.id` });
      outputs.push({ name: `${construct.id}Name`, type: 'string', value: `${sym}.name` });
      break;
    }

    case 'Storage.FileSystem': {
      const storageName = safeStorageName(construct.id) + 'share';
      const storageSym = `${sym}Storage`;
      const fileSvcSym = `${sym}FileService`;
      const shareSym = `${sym}Share`;
      resources.push({
        sym: storageSym,
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: storageName,
        location: 'location',
        kind: 'StorageV2',
        sku: { name: 'Standard_LRS' },
        tags: tag(construct.id),
        properties: { supportsHttpsTrafficOnly: true },
      });
      resources.push({
        sym: fileSvcSym,
        type: 'Microsoft.Storage/storageAccounts/fileServices',
        apiVersion: '2023-01-01',
        parent: storageSym,
        name: 'default',
        properties: {},
      });
      resources.push({
        sym: shareSym,
        type: 'Microsoft.Storage/storageAccounts/fileServices/shares',
        apiVersion: '2023-01-01',
        parent: fileSvcSym,
        name: construct.id,
        properties: { shareQuota: 100, enabledProtocols: 'SMB', accessTier: 'Hot' },
      });
      break;
    }

    case 'Storage.Archive': {
      const storageName = safeStorageName(construct.id + 'arc');
      resources.push({
        sym,
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: storageName,
        location: 'location',
        kind: 'BlobStorage',
        sku: { name: 'Standard_LRS' },
        tags: tag(construct.id),
        properties: {
          accessTier: 'Archive',
          allowBlobPublicAccess: false,
          supportsHttpsTrafficOnly: true,
          minimumTlsVersion: 'TLS1_2',
        },
      });
      break;
    }

    case 'Network.VPC': {
      resources.push({
        sym,
        type: 'Microsoft.Network/virtualNetworks',
        apiVersion: '2023-04-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        properties: {
          addressSpace: { addressPrefixes: [(props.cidr as string) ?? '10.0.0.0/16'] },
          dhcpOptions: { dnsServers: [] },
        },
      });
      break;
    }

    case 'Network.Subnet': {
      const vnetId = props.vpcId;
      const vnetSym = isRef(vnetId) ? toSym((vnetId as Ref).constructId) : toSym(vnetId as string);
      const subnetResource: BicepResource = {
        sym,
        type: 'Microsoft.Network/virtualNetworks/subnets',
        apiVersion: '2023-04-01',
        // subnets são recursos filho — herdam location do VNet, não declaram própria
        properties: {
          addressPrefix: props.cidr as string,
          privateEndpointNetworkPolicies: (props.public as boolean) ? 'Disabled' : 'Enabled',
        },
      };
      subnetResource.parent = vnetSym;
      subnetResource.name = construct.id;
      resources.push(subnetResource);
      break;
    }

    case 'Network.SecurityGroup': {
      const ingress = (props.ingressRules as Array<Record<string, unknown>>) ?? [];
      const egress = (props.egressRules as Array<Record<string, unknown>>) ?? [];

      const protocolMap: Record<string, string> = { tcp: 'Tcp', udp: 'Udp', icmp: 'Icmp', '-1': '*' };
      const mapProtocol = (raw: unknown): string => {
        if (raw === undefined || raw === null) return '*';
        return protocolMap[String(raw).toLowerCase()] ?? '*';
      };

      const secRules = [
        ...ingress.map((r, i) => {
          if (r.cidr === undefined) {
            console.warn(`[azure] Security group rule sem CIDR; usando * — defina props.cidr explicitamente (${construct.id} ingress[${i}])`);
          }
          return {
            name: `ingress-rule-${i}`,
            properties: {
              priority: 100 + i,
              direction: 'Inbound',
              access: 'Allow',
              protocol: mapProtocol(r.protocol),
              sourcePortRange: '*',
              destinationPortRange: r.fromPort === r.toPort ? String(r.fromPort) : `${r.fromPort}-${r.toPort}`,
              sourceAddressPrefix: (r.cidr as string) ?? '*',
              destinationAddressPrefix: '*',
              description: (r.description as string) ?? '',
            },
          };
        }),
        ...egress.map((r, i) => ({
          name: `egress-rule-${i}`,
          properties: {
            priority: 200 + i,
            direction: 'Outbound',
            access: 'Allow',
            protocol: mapProtocol(r.protocol),
            sourcePortRange: '*',
            destinationPortRange: r.fromPort === r.toPort ? String(r.fromPort) : `${r.fromPort}-${r.toPort}`,
            sourceAddressPrefix: '*',
            destinationAddressPrefix: (r.cidr as string) ?? '*',
            description: (r.description as string) ?? '',
          },
        })),
      ];

      resources.push({
        sym,
        type: 'Microsoft.Network/networkSecurityGroups',
        apiVersion: '2023-04-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        properties: { securityRules: secRules },
      });
      break;
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const customRules = rules.filter(r => !r.managedGroup).map((r, i) => ({
        name: (r.name as string) ?? `custom-rule-${i}`,
        priority: (r.priority as number) ?? (i + 1),
        ruleType: 'MatchRule',
        action: (r.action as string) ?? 'Block',
        matchConditions: [{ matchVariables: [{ variableName: 'RequestHeaders', selector: 'User-Agent' }], operator: 'Contains', matchValues: (r.matchValues as string[]) ?? ['BadBot'] }],
      }));
      const managedRules = rules.filter(r => r.managedGroup).map(r => ({ ruleSetType: (r.managedGroup as string) ?? 'OWASP', ruleSetVersion: '3.2' }));
      resources.push({
        sym,
        type: 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies',
        apiVersion: '2023-04-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        properties: {
          policySettings: { requestBodyCheck: true, maxRequestBodySizeInKb: 128, fileUploadLimitInMb: 100, state: 'Enabled', mode: (props.mode as string) ?? 'Prevention' },
          customRules,
          managedRules: { managedRuleSets: managedRules.length > 0 ? managedRules : [{ ruleSetType: 'OWASP', ruleSetVersion: '3.2' }] },
        },
      });
      break;
    }

    case 'Network.LoadBalancer': {
      const lbType = (props.type as string) ?? 'application';
      const listeners = (props.listeners as Array<Record<string, unknown>>) ?? [];
      const targetGroups = (props.targetGroups as Array<Record<string, unknown>>) ?? [];
      if (lbType === 'application') {
        resources.push({
          sym,
          type: 'Microsoft.Network/applicationGateways',
          apiVersion: '2023-04-01',
          name: construct.id,
          location: 'location',
          tags: tag(construct.id),
          properties: {
            sku: { name: 'Standard_v2', tier: 'Standard_v2', capacity: 2 },
            frontendIPConfigurations: [{ name: 'appGatewayFrontendIP', properties: { publicIPAddress: null } }],
            frontendPorts: listeners.map((l, i) => ({ name: `port${i}`, properties: { port: l.port } })),
            backendAddressPools: targetGroups.map(tg => ({ name: tg.name as string, properties: {} })),
            httpListeners: listeners.map((l, i) => ({ name: `listener${i}`, properties: { frontendPort: { id: `port${i}` }, protocol: (l.protocol as string).toLowerCase() === 'https' ? 'Https' : 'Http' } })),
            requestRoutingRules: [{ name: 'rule1', properties: { ruleType: 'Basic', priority: 100 } }],
          },
        });
      } else {
        resources.push({
          sym,
          type: 'Microsoft.Network/loadBalancers',
          apiVersion: '2023-04-01',
          name: construct.id,
          location: 'location',
          tags: tag(construct.id),
          sku: { name: 'Standard' },
          properties: {
            frontendIPConfigurations: [{ name: 'loadBalancerFrontEnd', properties: {} }],
            backendAddressPools: targetGroups.map(tg => ({ name: tg.name as string })),
            loadBalancingRules: listeners.map((l, i) => ({ name: `rule${i}`, properties: { frontendPort: l.port, backendPort: l.port, protocol: (l.protocol as string).toLowerCase() === 'tcp' ? 'Tcp' : 'Udp', enableFloatingIP: false } })),
          },
        });
      }
      break;
    }

    case 'Network.CDN': {
      // Azure CDN Classic (Standard_Microsoft) não aceita mais novos perfis —
      // "Azure CDN from Microsoft (classic) no longer support new profile creation".
      // Migrado para Azure Front Door Standard (Microsoft.Cdn/profiles com sku
      // Standard_AzureFrontDoor), que usa os mesmos tipos de recurso mas APIs distintas.
      const profileSym = `${sym}Profile`;
      const endpointSym = `${sym}Ep`;
      const ogSym = `${sym}Og`;
      const originSym = `${sym}Origin`;
      const routeSym = `${sym}Route`;

      const originsEarly = (props.origins as Array<Record<string, unknown>>) ?? [];
      const bucketRefEarly = originsEarly[0]?.bucketRef as string | undefined;
      if (accountTier === 'free') {
        // Front Door é PROIBIDO em Free Trial/Student ("Free Trial and Student
        // account is forbidden for Azure Frontdoor resources") e o CDN Classic
        // não aceita perfis novos — em free tier NÃO existe CDN criável no Azure.
        // Degrada com aviso: serve direto do endpoint público do Storage
        // (container 'web'); accountTier=standard usa Front Door normalmente.
        console.warn(`[azure] Network.CDN "${construct.id}": accountTier=free — Front Door indisponível em Free Trial; servindo direto do Storage público (sem CDN).`);
        if (bucketRefEarly) {
          const bSym = toSym(bucketRefEarly);
          cdnBucketRefs.add(bucketRefEarly);
          outputs.push({ name: `${construct.id}Url`, type: 'string', value: `'\${${bSym}.properties.primaryEndpoints.blob}web'` });
        }
        break;
      }

      // AFD Standard Profile (recurso global)
      resources.push({
        sym: profileSym,
        type: 'Microsoft.Cdn/profiles',
        apiVersion: '2023-05-01',
        name: `${construct.id}-profile`,
        // 'global' como string literal (EXPR strip produz texto raw no Bicep)
        location: "'global'",
        sku: { name: 'Standard_AzureFrontDoor' },
        tags: tag(construct.id),
        properties: {},
      });

      // AFD Endpoint
      resources.push({
        sym: endpointSym,
        type: 'Microsoft.Cdn/profiles/afdEndpoints',
        apiVersion: '2023-05-01',
        parent: profileSym,
        name: construct.id,
        location: "'global'",
        tags: tag(construct.id),
        properties: { enabledState: 'Enabled' },
      });

      // Origin Group com health probe e load balancing mínimos
      resources.push({
        sym: ogSym,
        type: 'Microsoft.Cdn/profiles/originGroups',
        apiVersion: '2023-05-01',
        parent: profileSym,
        name: `${construct.id}-og`,
        properties: {
          loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3, additionalLatencyInMilliseconds: 50 },
          healthProbeSettings: { probePath: '/', probeRequestType: 'HEAD', probeProtocol: 'Https', probeIntervalInSeconds: 100 },
        },
      });

      // Origin: quando o primeiro origin tem bucketRef, usa o blob endpoint da storage.
      // O conteúdo deve estar em blob/web (sem static-website, que é data-plane).
      // A storage referenciada é patcheada em emitBicep para allowBlobPublicAccess: true
      // + container 'web' público — faça upload de web/index.html para testar.
      const origins = (props.origins as Array<Record<string, unknown>>) ?? [];
      const bucketRefId = origins[0]?.bucketRef as string | undefined;
      let hostNameExpr: unknown;
      let originPath: string | undefined;

      if (bucketRefId) {
        const bucketSym = toSym(bucketRefId);
        // Strip 'https://' e '/' do endpoint blob — ex: "myacct.blob.core.windows.net"
        hostNameExpr = expr(`replace(replace(${bucketSym}.properties.primaryEndpoints.blob,'https://',''),'/','')`);
        originPath = '/web';
        cdnBucketRefs.add(bucketRefId);
      } else {
        hostNameExpr = origins[0]?.domainName ?? '';
      }

      resources.push({
        sym: originSym,
        type: 'Microsoft.Cdn/profiles/originGroups/origins',
        apiVersion: '2023-05-01',
        parent: ogSym,
        name: `${construct.id}-origin`,
        properties: {
          hostName: hostNameExpr,
          originHostHeader: hostNameExpr,
          httpPort: 80,
          httpsPort: 443,
          priority: 1,
          weight: 1000,
          enabledState: 'Enabled',
        },
      });

      // Route: liga endpoint → origin group
      const routeProps: Record<string, unknown> = {
        originGroup: { id: expr(`${ogSym}.id`) },
        supportedProtocols: ['Http', 'Https'],
        patternsToMatch: ['/*'],
        forwardingProtocol: 'HttpsOnly',
        linkToDefaultDomain: 'Enabled',
        httpsRedirect: 'Enabled',
        enabledState: 'Enabled',
      };
      if (originPath) routeProps.originPath = originPath;

      resources.push({
        sym: routeSym,
        type: 'Microsoft.Cdn/profiles/afdEndpoints/routes',
        apiVersion: '2023-05-01',
        parent: endpointSym,
        name: `${construct.id}-route`,
        properties: routeProps,
      });

      // Output: hostname público do endpoint AFD
      outputs.push({ name: `${construct.id}Url`, type: 'string', value: `${endpointSym}.properties.hostName` });
      break;
    }

    case 'Network.Dns': {
      const records = (props.records as Array<Record<string, unknown>>) ?? [];
      const zoneName = props.zoneName as string;
      resources.push({ sym, type: 'Microsoft.Network/dnsZones', apiVersion: '2018-05-01', name: zoneName, location: 'global', tags: tag(construct.id), properties: {} });
      for (let ri = 0; ri < records.length; ri++) {
        const r = records[ri];
        const recordType = (r.type as string).toLowerCase();
        resources.push({
          sym: `${sym}Record${ri}`, type: `Microsoft.Network/dnsZones/${recordType}`, apiVersion: '2018-05-01', parent: sym, name: r.name as string, location: 'global',
          properties: { TTL: (r.ttl as number) ?? 300, [`${recordType.toUpperCase()}Records`]: (r.values as string[]).map(v => ({ value: v })) },
        });
      }
      break;
    }

    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const serverName = `${construct.id.toLowerCase()}-server`;
      const storageBytes = (props.storageGb as number ?? 20) * 1024 * 1024 * 1024;
      // free tier: sem HA (zone redundant é pago e Burstable nem suporta).
      const zoneRedundant = accountTier === 'free' ? false : ((props.multiAz as boolean) ?? false);
      const dbSku = flexibleServerSku(accountTier);
      needsAdminPassword.value = true;

      // Admin login = 'dbadmin' (mesma convenção do RDS na AWS) — os handlers
      // gerados escrevem DB_USER: 'dbadmin' por hábito; alinhar mata o mismatch
      // (antes era pgadmin/mysqladmin e a conexão falhava com auth error).
      // Regra de firewall "Allow Azure services" (0.0.0.0/0.0.0.0): sem ela o
      // flexible server com publicNetworkAccess bloqueia até os Container Apps
      // (mesma sub, mas IP de egress público) → ETIMEDOUT na 5432/3306.
      const fwRule = { sym: `${sym}Fw`, type: `${'x'}`, apiVersion: '', parent: sym, name: 'AllowAzure', properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' } };
      if (engine === 'mysql') {
        resources.push({ sym, type: 'Microsoft.DBforMySQL/flexibleServers', apiVersion: '2023-06-30', name: serverName, location: 'location', tags: tag(construct.id), sku: dbSku, properties: { administratorLogin: 'dbadmin', administratorLoginPassword: expr('adminPassword'), version: '8.0.21', storage: { storageSizeGB: props.storageGb ?? 20, autoGrow: 'Enabled' }, backup: { backupRetentionDays: Math.max(Number(props.backupRetentionDays ?? 7), 7), geoRedundantBackup: 'Disabled' }, highAvailability: { mode: zoneRedundant ? 'ZoneRedundant' : 'Disabled' } } });
        resources.push({ ...fwRule, type: 'Microsoft.DBforMySQL/flexibleServers/firewallRules', apiVersion: '2023-06-30' });
        outputs.push({ name: `${construct.id}Endpoint`, type: 'string', value: `${sym}.properties.fullyQualifiedDomainName` });
        outputs.push({ name: `${construct.id}Port`, type: 'string', value: `'3306'` });
        outputs.push({ name: `${construct.id}Username`, type: 'string', value: `'dbadmin'` });
        break;
      }
      if (engine === 'postgres') {
        resources.push({ sym, type: 'Microsoft.DBforPostgreSQL/flexibleServers', apiVersion: '2023-06-01-preview', name: serverName, location: 'location', tags: tag(construct.id), sku: dbSku, properties: { administratorLogin: 'dbadmin', administratorLoginPassword: expr('adminPassword'), version: '15', storage: { storageSizeGB: props.storageGb ?? 32 }, backup: { backupRetentionDays: Math.max(Number(props.backupRetentionDays ?? 7), 7), geoRedundantBackup: 'Disabled' }, highAvailability: { mode: zoneRedundant ? 'ZoneRedundant' : 'Disabled' } } });
        resources.push({ ...fwRule, type: 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules', apiVersion: '2023-06-01-preview' });
        outputs.push({ name: `${construct.id}Endpoint`, type: 'string', value: `${sym}.properties.fullyQualifiedDomainName` });
        outputs.push({ name: `${construct.id}Port`, type: 'string', value: `'5432'` });
        outputs.push({ name: `${construct.id}Username`, type: 'string', value: `'dbadmin'` });
        break;
      }
      if (engine === 'mariadb') {
        resources.push({ sym, type: 'Microsoft.DBforMariaDB/servers', apiVersion: '2018-06-01', name: serverName, location: 'location', tags: tag(construct.id), sku: { name: 'GP_Gen5_2', tier: 'GeneralPurpose', capacity: 2, family: 'Gen5' }, properties: { administratorLogin: 'mariadbadmin', administratorLoginPassword: expr('adminPassword'), version: '10.3', storageProfile: { storageMB: (props.storageGb as number ?? 20) * 1024, backupRetentionDays: Math.max(Number(props.backupRetentionDays ?? 7), 7), geoRedundantBackup: 'Disabled' } } });
        break;
      }
      if (engine === 'oracle') {
        resources.push({ sym, type: 'Oracle.Database/cloudExadataInfrastructures', apiVersion: '2023-09-01', name: serverName, location: 'location', tags: tag(construct.id), properties: { displayName: construct.id, shape: 'Exadata.X9M', computeCount: 2, storageCount: 3 } });
        break;
      }
      // sqlserver (default)
      const edition = (props.edition as string) ?? 'Standard';
      const dbSym = `${sym}Db`;
      resources.push({ sym, type: 'Microsoft.Sql/servers', apiVersion: '2023-02-01-preview', name: serverName, location: 'location', tags: tag(construct.id), properties: { administratorLogin: 'sqladmin', administratorLoginPassword: expr('adminPassword'), version: '12.0' } });
      resources.push({ sym: dbSym, type: 'Microsoft.Sql/servers/databases', apiVersion: '2023-02-01-preview', parent: sym, name: construct.id, location: 'location', sku: { name: edition === 'ee' ? 'BusinessCritical' : 'Standard', tier: edition === 'ee' ? 'BusinessCritical' : 'Standard' }, properties: { collation: 'SQL_Latin1_General_CP1_CI_AS', maxSizeBytes: storageBytes, zoneRedundant } });
      outputs.push({ name: `${construct.id}Endpoint`, type: 'string', value: `${sym}.properties.fullyQualifiedDomainName` });
      outputs.push({ name: `${construct.id}Port`, type: 'string', value: `'1433'` });
      outputs.push({ name: `${construct.id}Username`, type: 'string', value: `'sqladmin'` });
      break;
    }

    case 'Database.DocumentDB': {
      needsAdminPassword.value = true;
      // Nome de conta Cosmos é GLOBALMENTE único (vira DNS <nome>.documents.azure.com)
      // — o construct id cru colide entre projetos e com tombstones de contas recém-
      // deletadas. Sufixo uniqueString(resourceGroup().id), mesmo padrão do APIM.
      resources.push({ sym, type: 'Microsoft.DocumentDB/databaseAccounts', apiVersion: '2023-04-15', name: expr(`'${construct.id.toLowerCase()}-\${uniqueString(resourceGroup().id)}'`), location: 'location', tags: tag(construct.id), properties: { databaseAccountOfferType: 'Standard', enableFreeTier: accountTier === 'free', kind: 'MongoDB', locations: [{ locationName: expr('location'), failoverPriority: 0, isZoneRedundant: false }], backupPolicy: { type: 'Periodic', periodicModeProperties: { backupIntervalInMinutes: 1440, backupRetentionIntervalInHours: 168 } }, enableAutomaticFailover: (props.deletionProtection as boolean) ?? false } });
      break;
    }

    case 'Database.DynamoDB': {
      // DynamoDB → Azure Cosmos DB for Table API. kind vai no nível do recurso,
      // não em properties. Backup Periodic (Continuous requer conta paga).
      // Nome globalmente único: ver comentário no DocumentDB acima.
      resources.push({
        sym,
        type: 'Microsoft.DocumentDB/databaseAccounts',
        apiVersion: '2023-04-15',
        name: expr(`'${construct.id.toLowerCase()}-\${uniqueString(resourceGroup().id)}'`),
        location: 'location',
        kind: 'GlobalDocumentDB',
        tags: tag(construct.id),
        properties: {
          databaseAccountOfferType: 'Standard',
          enableFreeTier: accountTier === 'free',
          capabilities: [{ name: 'EnableTable' }],
          locations: [{ locationName: expr('location'), failoverPriority: 0, isZoneRedundant: false }],
          backupPolicy: { type: 'Periodic', periodicModeProperties: { backupIntervalInMinutes: 1440, backupRetentionIntervalInHours: 168 } },
        },
      });
      // Tabela dentro da conta — sem ela o SDK falha com TableNotFound.
      const tableSym = `${sym}Table`;
      resources.push({
        sym: tableSym,
        type: 'Microsoft.DocumentDB/databaseAccounts/tables',
        apiVersion: '2023-04-15',
        parent: sym,
        name: construct.id,
        properties: {
          resource: { id: construct.id },
          options: {},
        },
      });
      outputs.push({ name: `${construct.id}Endpoint`, type: 'string', value: `${sym}.properties.documentEndpoint` });
      // Name = nome da TABELA (o que o SDK @azure/data-tables endereça), NÃO o da
      // conta — a conta (com uniqueString) é detalhe interno, já embutido na
      // ConnectionString. TABLE_NAME com o nome da conta dava ResourceNotFound.
      outputs.push({ name: crossParamName(construct.id, 'Name'), type: 'string', value: `'${construct.id}'` });
      outputs.push({ name: crossParamName(construct.id, 'Arn'), type: 'string', value: `${sym}.id` });
      // ConnectionString computada com listKeys() — usada pelos handlers via @azure/data-tables.
      outputs.push({
        name: crossParamName(construct.id, 'ConnectionString'),
        type: 'string',
        value: `'DefaultEndpointsProtocol=https;AccountName=\${${sym}.name};AccountKey=\${${sym}.listKeys().primaryMasterKey};TableEndpoint=https://\${${sym}.name}.table.cosmos.azure.com:443/;'`,
      });
      break;
    }

    case 'Cache.Redis': {
      // free tier: Basic C0 (~$16/mês, o menor); standard usa o mapa por nodeType.
      const skuInfo = accountTier === 'free'
        ? { name: 'Basic', family: 'C', capacity: 0 }
        : CACHE_SKU_MAP[(props.nodeType as string) ?? 'small'];
      resources.push({ sym, type: 'Microsoft.Cache/redis', apiVersion: '2023-08-01', name: construct.id, location: 'location', tags: tag(construct.id), sku: { name: skuInfo.name, family: skuInfo.family, capacity: skuInfo.capacity }, properties: { enableNonSslPort: false, minimumTlsVersion: '1.2', redisVersion: (props.version as string) ?? '7.0', redisConfiguration: { 'maxmemory-policy': 'volatile-lru' } } });
      outputs.push({ name: `${construct.id}Endpoint`, type: 'string', value: `${sym}.properties.hostName` });
      outputs.push({ name: `${construct.id}Port`, type: 'int', value: `${sym}.properties.sslPort` });
      break;
    }

    case 'Cache.Memcached': {
      resources.push({ sym, type: 'Microsoft.Cache/redis', apiVersion: '2023-08-01', name: `${construct.id}-cache`, location: 'location', tags: tag(construct.id), sku: { name: 'Standard', family: 'C', capacity: (props.numCacheNodes as number) ?? 2 }, properties: { enableNonSslPort: false, minimumTlsVersion: '1.2', redisConfiguration: {} } });
      break;
    }

    case 'Function.Lambda': {
      const environment = (props.environment as Record<string, string>) ?? {};
      // Lambda → Azure Container Apps (escala a zero, sem quota de VM).
      // Um único ManagedEnvironment compartilhado por stack (free tier: max 1 por região).
      // sharedContainerEnvSym é criado em emitBicep antes do loop de constructs.
      const envSym = sharedContainerEnvSym!;
      // A imagem real (buildada no ACR) é passada como parâmetro Bicep no deploy.
      // Default 'node:20-alpine' serve apenas para validação estática do template.
      const imageParamName = `${sym}Image`;
      functionImageParams.add(imageParamName);
      const envVars = Object.entries(environment).map(([k, v]) => {
        const value = resolveValue(v, idx, crossParams);
        // Container Apps rejeita env sem value ("ContainerAppEnvVarValueMissing").
        // Valor undefined = a IA pôs `process.env.X!` (runtime) no código da STACK,
        // que não existe em synth-time. Barrar com erro claro que o loop conserta.
        if (value === undefined || value === null) {
          throw new Error(`Fn.Lambda "${construct.id}": env var "${k}" resolveu para undefined. No código da STACK, o valor de environment deve ser uma string literal ou ref('X','Attr') — nunca process.env.${k} (isso é runtime, não existe no synth).`);
        }
        return { name: k, value };
      });
      resources.push({
        sym,
        type: 'Microsoft.App/containerApps',
        apiVersion: '2023-05-01',
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        location: 'location',
        tags: tag(construct.id),
        identity: { type: 'SystemAssigned' },
        properties: {
          managedEnvironmentId: expr(`${envSym}.id`),
          configuration: {
            ingress: { external: true, targetPort: 3000 },
            registries: expr(`empty(acrServer) ? [] : [{\n    server: acrServer\n    username: acrUser\n    passwordSecretRef: 'acr-pwd'\n  }]`),
            secrets: expr(`empty(acrPassword) ? [] : [{\n    name: 'acr-pwd'\n    value: acrPassword\n  }]`),
          },
          template: {
            containers: [{
              name: construct.id.toLowerCase(),
              image: expr(imageParamName),
              resources: { cpu: expr("json('0.25')"), memory: '0.5Gi' },
              env: envVars,
            }],
            scale: { minReplicas: 0, maxReplicas: 10 },
          },
        },
      });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${sym}.id` });
      outputs.push({ name: `${construct.id}PrincipalId`, type: 'string', value: `${sym}.identity.principalId` });
      break;
    }

    case 'Function.ApiGateway': {
      // nomes Azure não aceitam espaços — sanitiza para kebab-case.
      // APIM names são globalmente únicos no Azure — sufixo uniqueString garante unicidade.
      const rawName = (props.name as string) ?? construct.id;
      const apimBase = rawName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 36);
      // Bicep string interpolation: resolvida em deploy-time, não em synth-time
      const apimName = expr(`'${apimBase}-\${uniqueString(resourceGroup().id)}'`);
      const authorizerLambdaId = props.authorizerLambdaId as string | undefined;
      // SEM restore:true — com restore, o ARM falha com ServiceUndeleteNotPossible quando
      // NÃO existe instância soft-deletada com esse nome (caso normal de 1º deploy).
      // Colisão com soft-delete (redeploy no mesmo RG após destroy) se resolve com
      // `az apim deletedservice purge` antes do deploy.
      resources.push({ sym, type: 'Microsoft.ApiManagement/service', apiVersion: '2023-05-01-preview', name: apimName, location: 'location', tags: tag(construct.id), sku: { name: 'Consumption', capacity: 0 }, properties: { publisherEmail: 'admin@example.com', publisherName: construct.id, virtualNetworkType: 'None', customProperties: { 'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls10': 'false', 'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls11': 'false' } } });
      if (authorizerLambdaId) {
        const authFnSym = toSym(authorizerLambdaId);
        resources.push({ sym: `${sym}AuthorizerBackend`, type: 'Microsoft.ApiManagement/service/backends', apiVersion: '2023-05-01-preview', parent: sym, name: 'authorizer-backend', properties: { description: `Lambda authorizer backend (${authorizerLambdaId})`, url: expr(`'https://${authFnSym}.azurewebsites.net'`), protocol: 'http' } });
      }
      break;
    }

    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachTo = props.attachTo as string;
      const attachSym = toSym(attachTo);
      // Azure RBAC usa actions no formato Microsoft.*/* — mapear ações AWS para
      // um placeholder válido (o deploy precisa do formato correto, não da semântica AWS)
      const actions: string[] = [];
      const notActions: string[] = [];
      for (const s of statements) {
        const rawActions = (s.actions as string[]) ?? [];
        // Mapeia ações AWS-style para Azure-style equivalentes
        const azureActions = rawActions.map(a => {
          if (a.startsWith('dynamodb:') || a.startsWith('DocumentDB:')) return 'Microsoft.DocumentDB/databaseAccounts/*/read';
          if (a.startsWith('s3:') || a.startsWith('storage:')) return 'Microsoft.Storage/storageAccounts/blobServices/containers/*';
          if (a.startsWith('secretsmanager:') || a.startsWith('keyvault:')) return 'Microsoft.KeyVault/vaults/secrets/*';
          if (a.startsWith('sqs:') || a.startsWith('servicebus:')) return 'Microsoft.ServiceBus/namespaces/queues/*';
          if (a === '*') return '*';
          return `Microsoft.Resources/subscriptions/resourceGroups/read`; // fallback válido
        });
        if (s.effect === 'Allow') actions.push(...azureActions);
        else notActions.push(...azureActions);
      }
      const roleDefSym = `${sym}RoleDef`;
      const roleAssignSym = `${sym}RoleAssign`;
      // roleDefinitions e roleAssignments são recursos GLOBAIS — sem location
      resources.push({
        sym: roleDefSym,
        type: 'Microsoft.Authorization/roleDefinitions',
        apiVersion: '2022-04-01',
        name: expr(`guid(resourceGroup().id, '${construct.id}')`),
        properties: {
          roleName: `${construct.id}-role`,
          description: (props.description as string) ?? `Custom role for ${attachTo}`,
          type: 'CustomRole',
          permissions: [{ actions: actions.length > 0 ? [...new Set(actions)] : ['Microsoft.Resources/subscriptions/resourceGroups/read'], notActions, dataActions: [], notDataActions: [] }],
          assignableScopes: [expr('resourceGroup().id')],
        },
      });
      resources.push({
        sym: roleAssignSym,
        type: 'Microsoft.Authorization/roleAssignments',
        apiVersion: '2022-04-01',
        name: expr(`guid(resourceGroup().id, '${attachTo}', '${construct.id}')`),
        // dependsOn implícito via roleDefinitionId: roleDefSym.id — não declarar explicitamente
        properties: {
          roleDefinitionId: expr(`${roleDefSym}.id`),
          // principalId = managed identity da Function App (requer identity: SystemAssigned)
          principalId: expr(`${attachSym}.identity.principalId`),
          principalType: 'ServicePrincipal',
          description: `Role assignment for ${attachTo}`,
        },
      });
      break;
    }

    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      resources.push({ sym, type: 'Microsoft.EventGrid/namespaces', apiVersion: '2023-06-01-preview', name: (props.busName as string) ?? construct.id, location: 'location', tags: tag(construct.id), sku: { name: 'Standard', capacity: 1 }, properties: { topicsConfiguration: {}, topicSpacesConfiguration: { state: 'Enabled' } } });
      for (let ri = 0; ri < rules.length; ri++) {
        const r = rules[ri];
        resources.push({ sym: `${sym}Sub${ri}`, type: 'Microsoft.EventGrid/eventSubscriptions', apiVersion: '2022-06-15', name: (r.name as string) ?? `${construct.id}-sub-${ri}`, properties: { destination: { endpointType: 'WebHook', properties: { endpointUrl: (r.targetArn as string) ?? '' } }, filter: { includedEventTypes: (r.detailTypes as string[]) ?? ['*'] } } });
      }
      break;
    }

    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      resources.push({ sym, type: 'Microsoft.Logic/workflows', apiVersion: '2019-05-01', name: construct.id, location: 'location', tags: tag(construct.id), properties: { definition: { '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#', contentVersion: '1.0.0.0', triggers: {}, actions: Object.fromEntries(steps.map((s, i) => [s.name as string, { type: 'Http', inputs: { method: 'POST', uri: (s.resource as string) ?? '' }, runAfter: i > 0 ? { [steps[i - 1].name as string]: ['Succeeded'] } : {} }])) } } });
      break;
    }

    case 'Messaging.Queue': {
      const nsName = `${construct.id}-ns`;
      const nsSym = `${sym}Ns`;
      const qSym = `${sym}Queue`;
      resources.push({ sym: nsSym, type: 'Microsoft.ServiceBus/namespaces', apiVersion: '2022-10-01-preview', name: nsName, location: 'location', tags: tag(construct.id), sku: { name: 'Standard', tier: 'Standard' }, properties: {} });
      resources.push({ sym: qSym, type: 'Microsoft.ServiceBus/namespaces/queues', apiVersion: '2022-10-01-preview', parent: nsSym, name: construct.id, properties: { lockDuration: `PT${(props.visibilityTimeoutSeconds as number) ?? 30}S`, maxSizeInMegabytes: 1024, requiresDuplicateDetection: false, requiresSession: false, defaultMessageTimeToLive: `P${Math.floor(((props.messageRetentionSeconds as number) ?? 345600) / 86400)}D`, deadLetteringOnMessageExpiration: false } });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${nsSym}.id` });
      break;
    }

    case 'Messaging.Topic': {
      const nsName = `${construct.id}-ns`;
      const nsSym = `${sym}Ns`;
      const topicSym = `${sym}Topic`;
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];
      resources.push({ sym: nsSym, type: 'Microsoft.ServiceBus/namespaces', apiVersion: '2022-10-01-preview', name: nsName, location: 'location', tags: tag(construct.id), sku: { name: 'Standard', tier: 'Standard' }, properties: {} });
      resources.push({ sym: topicSym, type: 'Microsoft.ServiceBus/namespaces/topics', apiVersion: '2022-10-01-preview', parent: nsSym, name: construct.id, properties: { defaultMessageTimeToLive: 'P14D', requiresDuplicateDetection: false } });
      subscriptions.forEach((s, i) => {
        resources.push({ sym: `${sym}Sub${i}`, type: 'Microsoft.ServiceBus/namespaces/topics/subscriptions', apiVersion: '2022-10-01-preview', parent: topicSym, name: `sub-${i}`, properties: { lockDuration: 'PT30S', deadLetteringOnMessageExpiration: false, forwardTo: s.endpoint } });
      });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${nsSym}.id` });
      break;
    }

    case 'Secret.Vault': {
      const kvName = `${construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24)}-kv`;
      resources.push({ sym, type: 'Microsoft.KeyVault/vaults', apiVersion: '2023-02-01', name: kvName, location: 'location', tags: tag(construct.id), properties: { sku: { family: 'A', name: 'standard' }, tenantId: expr('subscription().tenantId'), enableSoftDelete: true, softDeleteRetentionInDays: 90, enablePurgeProtection: true, enabledForDeployment: false, accessPolicies: [] } });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${sym}.id` });
      break;
    }

    case 'Certificate.TLS': {
      const kvName = `${construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20)}-kv`;
      const kvSym = `${sym}Kv`;
      const certSym = `${sym}Cert`;
      resources.push({ sym: kvSym, type: 'Microsoft.KeyVault/vaults', apiVersion: '2023-02-01', name: kvName, location: 'location', properties: { sku: { family: 'A', name: 'standard' }, tenantId: expr('subscription().tenantId'), enableSoftDelete: true, accessPolicies: [] } });
      resources.push({ sym: certSym, type: 'Microsoft.KeyVault/vaults/certificates', apiVersion: '2023-02-01', parent: kvSym, name: construct.id.replace(/[^a-zA-Z0-9-]/g, '-'), properties: { properties: { x509CertificateProperties: { subject: `CN=${props.domainName as string}`, subjectAlternativeNames: { dnsNames: [(props.domainName as string), ...((props.subjectAlternativeNames as string[]) ?? [])] }, validityInMonths: 12 }, issuerParameters: { name: 'Self', issuerName: 'Self' }, keyProperties: { keyType: 'RSA', keySize: 2048, exportable: true } } } });
      break;
    }

    case 'Monitoring.Alarm': {
      const dimensions = props.dimensions as Record<string, string> | undefined;
      const operatorMap: Record<string, string> = { GreaterThanThreshold: 'GreaterThan', LessThanThreshold: 'LessThan', GreaterThanOrEqualToThreshold: 'GreaterThanOrEqual', LessThanOrEqualToThreshold: 'LessThanOrEqual' };
      resources.push({ sym, type: 'Microsoft.Insights/metricAlerts', apiVersion: '2018-03-01', name: construct.id, location: 'global', tags: tag(construct.id), properties: { description: `Alarm for ${props.metricName}`, severity: 2, enabled: true, evaluationFrequency: `PT${(props.periodSeconds as number) ?? 60}S`, windowSize: `PT${((props.periodSeconds as number) ?? 60) * ((props.evaluationPeriods as number) ?? 2)}S`, criteria: { 'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria', allOf: [{ name: 'criterion1', metricName: props.metricName as string, metricNamespace: (props.namespace as string) ?? 'Microsoft.Web/sites', operator: operatorMap[(props.comparisonOperator as string) ?? 'GreaterThanThreshold'] ?? 'GreaterThan', threshold: props.threshold as number, timeAggregation: (props.statistic as string) ?? 'Average', dimensions: dimensions ? Object.entries(dimensions).map(([k, v]) => ({ name: k, operator: 'Include', values: [v] })) : [] }] }, actions: (props.alarmActions as string[] ?? []).map(a => ({ actionGroupId: a })) } });
      break;
    }

    case 'Monitoring.Dashboard': {
      const widgets = (props.widgets as Array<Record<string, unknown>>) ?? [];
      resources.push({ sym, type: 'Microsoft.Portal/dashboards', apiVersion: '2020-09-01-preview', name: construct.id, location: 'location', tags: { 'hidden-title': construct.id }, properties: { lenses: [{ order: 0, parts: widgets.map((w, i) => ({ position: { x: (i % 3) * 4, y: Math.floor(i / 3) * 4, colSpan: 4, rowSpan: 4 }, metadata: { type: 'Extension/Microsoft_Azure_Monitoring/PartType/MetricsChartPart', settings: { content: { options: { chart: { metrics: [{ name: w.metricName, resourceMetadata: {} }] } }, title: w.title as string } } } })) }] } });
      break;
    }

    case 'Logging.Stream': {
      const wsName = `${construct.id}-law`;
      resources.push({ sym, type: 'Microsoft.OperationalInsights/workspaces', apiVersion: '2022-10-01', name: wsName, location: 'location', tags: tag(construct.id), properties: { sku: { name: 'PerGB2018' }, retentionInDays: (props.retentionDays as number) ?? 30, features: { enableLogAccessUsingOnlyResourcePermissions: true } } });
      break;
    }

    case 'Custom.Resource': {
      const bicepCustom = props.bicep as { type: string; apiVersion: string; properties: Record<string, unknown>; sku?: Record<string, unknown>; kind?: string } | undefined;
      const armCustom = props.arm as { type: string; apiVersion: string; properties: Record<string, unknown>; sku?: Record<string, unknown>; kind?: string } | undefined;
      const custom = bicepCustom ?? armCustom;
      if (!custom) break;
      resources.push({ sym, type: custom.type, apiVersion: custom.apiVersion, name: (props.name as string) ?? construct.id, location: 'location', tags: tag(construct.id), sku: custom.sku, kind: custom.kind, properties: custom.properties });
      break;
    }

    default:
      console.warn(`[iacmp/azure] construct '${construct.type}' nao suportado`);
      break;
  }
}

// ── Function metadata for packaging ──────────────────────────────────────────
export interface AzureFunctionMeta {
  constructId: string;
  containerAppName: string;
  handler: string;
  code: string;
  runtime: string;
  imageParamName: string;
}

export function extractAzureFunctionMeta(stack: Stack): AzureFunctionMeta[] {
  return stack.constructs
    .filter(c => c.type === 'Function.Lambda')
    .map(c => {
      const props = c.props as Record<string, unknown>;
      const sym = toSym(c.id);
      return {
        constructId: c.id,
        containerAppName: c.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        handler: (props.handler as string) ?? 'dist/handler.handler',
        code: (props.code as string) ?? 'dist/',
        runtime: (props.runtime as string) ?? 'nodejs20',
        imageParamName: `${sym}Image`,
      };
    });
}

// ── Main export ───────────────────────────────────────────────────────────────
export function emitBicep(stack: Stack, opts?: { accountTier?: 'free' | 'standard' }): string {
  const accountTier = opts?.accountTier ?? 'standard';
  const idx = new Map<string, BaseConstruct>(stack.constructs.map(c => [c.id, c]));
  const resources: BicepResource[] = [];
  const outputs: BicepOutput[] = [];
  const needsAdminPassword = { value: false };
  // crossParams: referências a constructs de outro stack viram parâmetros
  const crossParams = new Map<string, string>();
  // functionImageParams: param Bicep por Function.Lambda (imagem buildada no ACR)
  const functionImageParams = new Set<string>();
  // cdnBucketRefs: Storage.Buckets referenciados por Network.CDN via bucketRef —
  // precisam de allowBlobPublicAccess: true + container 'web' para servir conteúdo.
  const cdnBucketRefs = new Set<string>();

  // ManagedEnvironment compartilhado — free tier Azure limita a 1 env por região.
  // Criado uma única vez se o stack tiver alguma Function.Lambda.
  const hasLambda = stack.constructs.some(c => c.type === 'Function.Lambda');
  let sharedContainerEnvSym: string | null = null;
  if (hasLambda) {
    sharedContainerEnvSym = 'sharedContainerEnv';
    resources.push({
      sym: sharedContainerEnvSym,
      type: 'Microsoft.App/managedEnvironments',
      apiVersion: '2023-05-01',
      name: expr(`'${stack.name}-cae'`),
      location: 'location',
      tags: { Stack: stack.name },
      properties: { zoneRedundant: false },
    });
  }

  for (const construct of stack.constructs) {
    synthesizeConstruct(construct, idx, resources, outputs, needsAdminPassword, crossParams, functionImageParams, sharedContainerEnvSym, cdnBucketRefs, accountTier);
  }

  // Post-processing: Storage.Buckets referenciados por CDN via bucketRef ganham
  // allowBlobPublicAccess: true + blobServices + container 'web' com publicAccess Blob.
  for (const bucketId of cdnBucketRefs) {
    const bucketSym = toSym(bucketId);
    const bucketResource = resources.find(r => r.sym === bucketSym);
    if (bucketResource) {
      bucketResource.properties.allowBlobPublicAccess = true;
    }
    const blobSvcSym = `${bucketSym}BlobService`;
    if (!resources.find(r => r.sym === blobSvcSym)) {
      resources.push({
        sym: blobSvcSym,
        type: 'Microsoft.Storage/storageAccounts/blobServices',
        apiVersion: '2023-01-01',
        parent: bucketSym,
        name: 'default',
        properties: {},
      });
    }
    resources.push({
      sym: `${bucketSym}WebContainer`,
      type: 'Microsoft.Storage/storageAccounts/blobServices/containers',
      apiVersion: '2023-01-01',
      parent: blobSvcSym,
      name: 'web',
      properties: { publicAccess: 'Blob' },
    });
  }

  // Choke point global: NENHUM Ref tipado pode chegar cru ao render (viraria
  // objeto {kind:'iacmp:ref',...} no Bicep → BCP020/22/55). Cases individuais
  // podem esquecer o resolveValue (ex: env do Compute.Container) — esta passada
  // resolve tudo (same-stack → expressão; cross-stack → param) de forma idempotente.
  for (const r of resources) {
    r.properties = resolveValue(r.properties, idx, crossParams) as Record<string, unknown>;
    if (r.name !== undefined) r.name = resolveValue(r.name, idx, crossParams);
    if (r.tags) r.tags = resolveValue(r.tags, idx, crossParams) as Record<string, string>;
  }

  const params: Array<{ name: string; type: string; default?: unknown; secure?: boolean }> = [
    { name: 'location', type: 'string', default: expr('resourceGroup().location') },
  ];
  if (needsAdminPassword.value || crossParams.get('adminPassword') === 'secureString') {
    // SEM default: flexibleServers rejeita senha vazia ("cannot be NULL or
    // empty") — o deploy SEMPRE injeta via --parameters (gera uma por run).
    params.push({ name: 'adminPassword', type: 'string', secure: true });
    crossParams.delete('adminPassword');
  }
  // Parâmetros de imagem por Function.Lambda — default 'node:20-alpine' para
  // validação estática; o deploy sobrescreve com a imagem real buildada no ACR.
  for (const name of functionImageParams) {
    params.push({ name, type: 'string', default: 'node:20-alpine' });
  }
  // Params ACR — usados quando há Function.Lambda e o deploy faz build no ACR.
  if (hasLambda) {
    params.push({ name: 'acrServer', type: 'string', default: '' });
    params.push({ name: 'acrUser', type: 'string', default: '' });
    params.push({ name: 'acrPassword', type: 'string', default: '', secure: true });
  }
  // Parâmetros cross-stack (sem default — devem ser passados no deploy)
  for (const [name, type] of crossParams) {
    if (type === 'secureString') { params.push({ name, type: 'string', secure: true }); continue; }
    params.push({ name, type });
  }

  return renderBicep(params, resources, outputs);
}
