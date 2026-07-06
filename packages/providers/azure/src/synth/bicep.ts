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
  'Storage.Bucket':        { Arn: 'id', Name: 'name', ConnectionString: '__blob_connection_string__' },
  'Function.Lambda':       { Arn: 'id', Fqdn: 'properties.configuration.ingress.fqdn' },
  'Database.SQL':          { Endpoint: 'properties.fullyQualifiedDomainName', SecretArn: 'id', Password: 'id', Username: 'id' },
  'Database.DocumentDB':   { Endpoint: 'properties.documentEndpoint', SecretArn: 'id', ConnectionString: '__mongo_connection_string__' },
  'Database.DynamoDB':     { Arn: 'id', Name: 'name', ConnectionString: '__connection_string__' },
  'Messaging.Stream':      { Arn: 'id', Name: 'name' },
  'Messaging.Topic':       { Arn: 'id', TopicArn: 'id' },
  'Messaging.Queue':       { Arn: 'id', QueueUrl: 'id', QueueArn: 'id', ConnectionString: '__sb_connection_string__' },
  'Cache.Redis':           { Endpoint: 'properties.hostName', Port: 'properties.sslPort', ConnectionString: '__redis_cs__' },
  'Secret.Vault':          { SecretArn: 'id', Arn: 'id', VaultUri: 'properties.vaultUri', Name: 'name' },
  'Network.LoadBalancer':  { TargetGroupArn: 'id', DnsName: 'properties.dnsName' },
  'Compute.Container':     { Arn: 'id', Fqdn: 'properties.configuration.ingress.fqdn', DnsName: 'properties.configuration.ingress.fqdn' },
};

function crossParamName(constructId: string, attribute: string): string {
  return `${constructId.replace(/[^a-zA-Z0-9]/g, '')}${attribute}`;
}

function resolveRef(r: Ref, idx: Map<string, BaseConstruct>, crossParams: Map<string, string>): string {
  const c = idx.get(r.constructId);
  if (!c) {
    // Referência cross-stack — vira parâmetro no template.
    // 'string:optional' gera default '' — permite deploy mesmo quando o construto
    // referenciado não existe em nenhuma stack (env var fica vazia, não bloqueia ARM).
    const pName = crossParamName(r.constructId, r.attribute);
    if (!crossParams.has(pName)) crossParams.set(pName, 'string:optional');
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
  // ConnectionString do Cosmos DB MongoDB API — obtida via listConnectionStrings().
  // Retorna URI mongodb://... pronta para o driver mongodb nativo.
  if (c.type === 'Database.DocumentDB' && r.attribute === 'ConnectionString') {
    return expr(`${sym}.listConnectionStrings().connectionStrings[0].connectionString`);
  }
  // ConnectionString do Service Bus (Messaging.Queue) — obtida via listKeys() na
  // authorization rule padrão. O handler usa @azure/service-bus com esta string.
  if (c.type === 'Messaging.Queue' && r.attribute === 'ConnectionString') {
    const nsSym = `${sym}Ns`;
    return expr(`listKeys(resourceId('Microsoft.ServiceBus/namespaces/authorizationRules', ${nsSym}.name, 'RootManageSharedAccessKey'), '2022-10-01-preview').primaryConnectionString`);
  }
  // ConnectionString do Cache.Redis — formato ioredis rediss://:KEY@HOST:PORT via listKeys().
  if (c.type === 'Cache.Redis' && r.attribute === 'ConnectionString') {
    return expr(`'rediss://:$\{${sym}.listKeys().primaryKey}@$\{${sym}.properties.hostName}:6380'`);
  }
  // ConnectionString do Storage.Bucket (blob) — com a account key via listKeys().
  // O handler usa BlobServiceClient.fromConnectionString; antes o modelo punha
  // BLOB_KEY: 'your-key' literal (placeholder) → SAS 403 (ciclo p04az5).
  if (c.type === 'Storage.Bucket' && r.attribute === 'ConnectionString') {
    return expr(`'DefaultEndpointsProtocol=https;AccountName=\${${sym}.name};AccountKey=\${${sym}.listKeys().keys[0].value};EndpointSuffix=core.windows.net'`);
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
  // Subnet inline — não tem recurso próprio; referência via resourceId() com o nome do VNet pai.
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
  /** Bicep conditional: `= if (condition) { ... }` — recurso só criado quando true. */
  condition?: string;
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

    lines.push(`resource ${r.sym} '${r.type}@${r.apiVersion}' = ${r.condition ? `if (${r.condition}) ` : ''}{`);
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
  subnetsByVpc: Map<string, Array<{id: string; cidr: string; public: boolean}>>,
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
      // Compute.Container → Azure Container Apps (Microsoft.App/containerApps).
      // ContainerInstance/containerGroups foi descartado: o Azure Bicep NÃO suporta
      // número decimal (float literal), e cpu/memoryInGB em ContainerInstance são float
      // (0.25, 0.5 …) — isso gera BCP055/BCP018/BCP020 no parser Bicep.
      // Container Apps aceita cpu via json('0.25') e memory como string ('0.5Gi'),
      // e entrega ingress HTTP nativo (external:true) = o "load balancer" do prompt.
      const envSym = sharedContainerEnvSym!;
      const imageParamName = `${sym}Image`;
      functionImageParams.add(imageParamName);

      const environment = (props.environment as Record<string, string | unknown>) ?? {};
      const envVars = Object.entries(environment).map(([k, v]) => {
        const value = resolveValue(v, idx, crossParams);
        if (value === undefined || value === null) {
          throw new Error(
            `Compute.Container "${construct.id}": env var "${k}" resolveu para undefined. ` +
            `O valor deve ser string literal ou ref() — nunca process.env.${k} (runtime).`,
          );
        }
        return { name: k, value };
      });

      // CPU: ECS units (1024 units = 1 vCPU) → vCores do Container Apps
      // Container Apps permite: 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0
      // Float literal não é Bicep válido — DEVE usar json('0.25')
      const cpuUnits = (props.cpu as number) ?? 256;
      const cpuVCores = Math.max(0.25, Math.min(2.0, Math.round(cpuUnits / 1024 * 4) / 4));
      const cpuExpr = expr(`json('${cpuVCores}')`);

      // Memory: ECS MB → string Gi (ex: 512 → '0.5Gi', 1024 → '1Gi')
      const memMB = (props.memory as number) ?? 512;
      const memGiRaw = Math.max(0.5, Math.round(memMB / 512) / 2);
      const memStr = `${memGiRaw}Gi`;

      const minReplicas = (props.minCapacity as number) ?? (props.desiredCount as number) ?? 0;
      const maxReplicas = (props.maxCapacity as number) ?? 10;
      const targetPort = (props.port as number) ?? 80;

      resources.push({
        sym,
        type: 'Microsoft.App/containerApps',
        apiVersion: '2023-05-01',
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        location: 'location',
        tags: tag(construct.id),
        identity: { type: 'SystemAssigned' },
        properties: {
          managedEnvironmentId: expr(`empty(sharedCaeId) ? sharedContainerEnv.id : sharedCaeId`),
          configuration: {
            ingress: { external: true, targetPort },
            registries: expr(`empty(acrServer) ? [] : [{\n    server: acrServer\n    username: acrUser\n    passwordSecretRef: 'acr-pwd'\n  }]`),
            secrets: expr(`empty(acrPassword) ? [] : [{\n    name: 'acr-pwd'\n    value: acrPassword\n  }]`),
          },
          template: {
            containers: [{
              name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
              image: expr(imageParamName),
              resources: { cpu: cpuExpr, memory: memStr },
              env: envVars,
              // startup probe: garante ready antes de criar Event Grid subscription (cold-start race)
              probes: [{ type: 'Startup', tcpSocket: { port: targetPort }, periodSeconds: 5, failureThreshold: 30 }],
            }],
            scale: { minReplicas, maxReplicas },
          },
        },
      });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${sym}.id` });
      outputs.push({ name: `${construct.id}PrincipalId`, type: 'string', value: `${sym}.identity.principalId` });
      outputs.push({ name: `${construct.id}Fqdn`, type: 'string', value: `${sym}.properties.configuration.ingress.fqdn` });
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
      // Nome globalmente único: prefixo ≤ 11 chars + uniqueString(rg) 13 chars = 24 (limite).
      const safePfx = construct.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 11) || 'st';
      const storageNameExpr = expr(`'${safePfx}\${uniqueString(resourceGroup().id)}'`);
      resources.push({
        sym,
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: storageNameExpr,
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
      // ConnectionString (com a account key) — cross-stack para o handler blob
      // (BlobServiceClient.fromConnectionString). Ver resolveRef Storage.Bucket.
      outputs.push({ name: `${construct.id}ConnectionString`, type: 'string', value: `'DefaultEndpointsProtocol=https;AccountName=\${${sym}.name};AccountKey=\${${sym}.listKeys().keys[0].value};EndpointSuffix=core.windows.net'` });
      // Event Grid trigger — eventNotifications → systemTopic no storage account + eventSubscription por lambdaId.
      // Abordagem: Event Grid (não KEDA). KEDA só escala réplicas, não entrega o payload BlobCreated ao handler.
      // Event Grid envia o evento via webhook HTTP (/events) e o adaptador server.js traduz
      // o payload EventGrid → Records[].s3 (formato que o handler gerado pelo modelo espera).
      // Cross-stack: bucket e lambda podem estar em stacks diferentes — usa param Fqdn (mesmo padrão do APIM).
      const eventNotifications = (props.eventNotifications as Array<Record<string, unknown>>) ?? [];
      if (eventNotifications.length > 0) {
        const topicSym = `${sym}EventTopic`;
        resources.push({
          sym: topicSym,
          type: 'Microsoft.EventGrid/systemTopics',
          apiVersion: '2022-06-15',
          name: `${safeStorageName(construct.id)}-evttopic`,
          location: 'location',
          tags: tag(construct.id),
          properties: {
            source: expr(`${sym}.id`),
            topicType: 'Microsoft.Storage.StorageAccounts',
          },
        });
        for (let ni = 0; ni < eventNotifications.length; ni++) {
          const notification = eventNotifications[ni];
          const lambdaIdRaw = notification.lambdaId;
          // lambdaId pode ser string ou Ref<'Arn'> — extrai o constructId.
          const lambdaId = isRef(lambdaIdRaw) ? (lambdaIdRaw as Ref).constructId : lambdaIdRaw as string;
          if (!lambdaId) continue;
          const lambdaConstruct = idx.get(lambdaId);
          const lambdaSym = toSym(lambdaId);
          let webhookUrl: string;
          let subCondition: string | undefined;
          if (lambdaConstruct) {
            // Mesma stack: referência direta ao FQDN do Container App.
            webhookUrl = expr(`'https://\${${lambdaSym}.properties.configuration.ingress.fqdn}/events'`);
          } else {
            // Stack diferente: param opcional (default '') para evitar ciclo de dependência.
            // O Event Grid subscription só é criado no segundo passo (após lambda estar deployada).
            // O param com default '' não conta como import no cycle-detection (regex exige param sem default).
            const fqdnParam = crossParamName(lambdaId, 'Fqdn');
            crossParams.set(fqdnParam, 'string:optional');
            webhookUrl = expr(`'https://\${${fqdnParam}}/events'`);
            subCondition = `!empty(${fqdnParam})`;
          }
          resources.push({
            sym: `${topicSym}Sub${ni}`,
            type: 'Microsoft.EventGrid/systemTopics/eventSubscriptions',
            apiVersion: '2022-06-15',
            parent: topicSym,
            name: `blob-created-${ni}`,
            // dependsOn explícito garante que o Container App esteja criado antes do Event Grid
            // tentar validar o webhook — sem isso, a validação pode falhar por cold start.
            ...(lambdaConstruct ? { dependsOn: [lambdaSym] } : {}),
            // Cross-stack: só cria a subscrição quando FQDN disponível (segundo passo de deploy)
            ...(subCondition ? { condition: subCondition } : {}),
            properties: {
              eventDeliverySchema: 'EventGridSchema',
              destination: {
                endpointType: 'WebHook',
                properties: { endpointUrl: webhookUrl },
              },
              filter: {
                includedEventTypes: ['Microsoft.Storage.BlobCreated'],
              },
            },
          });
        }
      }
      break;
    }

    case 'Storage.FileSystem': {
      const fsPfx = (construct.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 7) || 'fs') + 'sh';
      const storageNameExprFs = expr(`'${fsPfx}\${uniqueString(resourceGroup().id)}'`);
      const storageSym = `${sym}Storage`;
      const fileSvcSym = `${sym}FileService`;
      const shareSym = `${sym}Share`;
      resources.push({
        sym: storageSym,
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: storageNameExprFs,
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
      const vpcSubnets = subnetsByVpc.get(construct.id) ?? [];
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
          ...(vpcSubnets.length > 0 ? {
            subnets: vpcSubnets.map(s => ({
              name: s.id,
              properties: {
                addressPrefix: s.cidr,
                privateEndpointNetworkPolicies: s.public ? 'Disabled' : 'Enabled',
              },
            })),
          } : {}),
        },
      });
      break;
    }

    case 'Network.Subnet': {
      // Subnets são declaradas inline na propriedade subnets[] do virtualNetworks
      // (via Network.VPC case + subnetsByVpc). Recursos separados causam
      // AnotherOperationInProgress — o ARM tenta criar subnets em paralelo no mesmo VNet.
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
      // Mapa de nomes AWS → Azure OWASP/Microsoft equivalentes
      const AWS_RULE_MAP: Record<string, { ruleSetType: string; ruleSetVersion: string }> = {
        AWSManagedRulesCommonRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesKnownBadInputsRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesAmazonIpReputationList: { ruleSetType: 'Microsoft_BotManagerRuleSet', ruleSetVersion: '1.0' },
        AWSManagedRulesBotControlRuleSet: { ruleSetType: 'Microsoft_BotManagerRuleSet', ruleSetVersion: '1.0' },
        AWSManagedRulesAdminProtectionRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesSQLiRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesLinuxRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesWindowsRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesPHPRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
        AWSManagedRulesWordPressRuleSet: { ruleSetType: 'OWASP', ruleSetVersion: '3.2' },
      };
      const customRules = rules.filter(r => !r.managedGroup).map((r, i) => ({
        name: (r.name as string) ?? `custom-rule-${i}`,
        priority: (r.priority as number) ?? (i + 1),
        // App Gateway WAF suporta apenas MatchRule — RateLimitRule é exclusivo do Front Door
        ruleType: 'MatchRule',
        // action deve ser capitalizado: Block, Allow, Log (Azure não aceita lowercase)
        action: ({ allow: 'Allow', block: 'Block', log: 'Log' }[(r.action as string)?.toLowerCase() ?? 'block']) ?? 'Block',
        // negationConditon: ARM API tem este typo histórico (falta um 'i') — Bicep BCP089 confirma
        matchConditions: [{ matchVariables: [{ variableName: 'RemoteAddr' }], operator: 'IPMatch', matchValues: (r.matchValues as string[]) ?? ['192.0.2.0/24'], negationConditon: false }],
      }));
      // Mapear e deduplicar: vários grupos AWS podem gerar o mesmo Azure ruleSetType
      const seenRuleSets = new Set<string>();
      const managedRules = rules.filter(r => r.managedGroup).reduce<Array<{ ruleSetType: string; ruleSetVersion: string }>>((acc, r) => {
        const group = r.managedGroup as string;
        const mapped = AWS_RULE_MAP[group] ?? { ruleSetType: 'OWASP', ruleSetVersion: '3.2' };
        const key = `${mapped.ruleSetType}@${mapped.ruleSetVersion}`;
        if (!seenRuleSets.has(key)) { seenRuleSets.add(key); acc.push(mapped); }
        return acc;
      }, []);
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
      // Azure: quando a stack contém Compute.Container, o Container App já emite
      // ingress externo (type:application, external:true, targetPort) que É o load
      // balancer HTTP/HTTPS público nativo — FQDN gerenciado, TLS automático, escala.
      // Emitir um Application Gateway separado seria redundante e SEMPRE quebraria
      // o deploy: o ARM exige subnet dedicada /24, publicIPAddress resource, e
      // gatewayIPConfigurations que o construct agnóstico não fornece (erro
      // InvalidRequestFormat: "Cannot parse the request." confirmado em deploy real).
      // → NO-OP quando detectado Compute.Container na mesma stack.
      const hasContainerInStack = Array.from(idx.values()).some(c => c.type === 'Compute.Container');
      if (hasContainerInStack) {
        console.warn(
          `[azure] Network.LoadBalancer "${construct.id}": no-op — stack contém Compute.Container ` +
          `cujo ingress externo (Container Apps) já provê load balancing HTTP público. ` +
          `Referencie o endpoint via output <ContainerId>Fqdn.`,
        );
        break;
      }
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
      // Database filho — obrigatório para o driver MongoDB encontrar o banco.
      const dbSym = `${sym}Db`;
      const dbName = `${construct.id.toLowerCase()}-db`;
      resources.push({
        sym: dbSym,
        type: 'Microsoft.DocumentDB/databaseAccounts/mongodbDatabases',
        apiVersion: '2023-04-15',
        parent: sym,
        name: `'${dbName}'`,
        properties: { resource: { id: dbName }, options: {} },
      });
      // Collection "documents" dentro do banco — a collection que o handler usa.
      resources.push({
        sym: `${sym}Coll`,
        type: 'Microsoft.DocumentDB/databaseAccounts/mongodbDatabases/collections',
        apiVersion: '2023-04-15',
        parent: dbSym,
        name: `'documents'`,
        properties: { resource: { id: 'documents' }, options: {} },
      });
      // Outputs para referências cross-stack e injeção como env var nos handlers.
      outputs.push({ name: `${construct.id}Endpoint`, type: 'string', value: `${sym}.properties.documentEndpoint` });
      outputs.push({ name: crossParamName(construct.id, 'Endpoint'), type: 'string', value: `${sym}.properties.documentEndpoint` });
      outputs.push({ name: crossParamName(construct.id, 'ConnectionString'), type: 'string', value: `${sym}.listConnectionStrings().connectionStrings[0].connectionString` });
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
      // Azure Cache for Redis (Basic/Standard/Premium) foi retirado — migrado para
      // Azure Managed Redis (Microsoft.Cache/redisEnterprise). Tier mínimo Balanced_B0.
      // EnterpriseCluster mode na porta 10000 é compatível com ioredis single-node.
      const dbSym = `${sym}Db`;
      const reName = expr(`'${construct.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || 're'}-\${uniqueString(resourceGroup().id)}'`);
      resources.push({ sym, type: 'Microsoft.Cache/redisEnterprise', apiVersion: '2024-10-01', name: reName, location: 'location', tags: tag(construct.id), sku: { name: 'Balanced_B0' }, properties: {} });
      resources.push({ sym: dbSym, type: 'Microsoft.Cache/redisEnterprise/databases', apiVersion: '2024-10-01', parent: sym, name: 'default', properties: { clientProtocol: 'Encrypted', port: 10000, clusteringPolicy: 'EnterpriseCluster', evictionPolicy: 'VolatileLRU', modules: [], persistence: { aofEnabled: false } } });
      outputs.push({ name: `${construct.id}Endpoint`, type: 'string', value: `${sym}.properties.hostName` });
      outputs.push({ name: `${construct.id}Port`, type: 'int', value: `${dbSym}.properties.port` });
      // ConnectionString no formato ioredis: rediss://:KEY@HOSTNAME:PORT
      // Consumido cross-stack via param (compute-stack env var REDIS_CONNECTION_STRING).
      outputs.push({ name: crossParamName(construct.id, 'ConnectionString'), type: 'string', value: `'rediss://:$\{${dbSym}.listKeys().primaryKey}@$\{${sym}.properties.hostName}:10000'` });
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
          managedEnvironmentId: expr(`empty(sharedCaeId) ? sharedContainerEnv.id : sharedCaeId`),
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
              // startup probe: garante ready antes de criar Event Grid subscription (cold-start race)
              probes: [{ type: 'Startup', tcpSocket: { port: 3000 }, periodSeconds: 5, failureThreshold: 30 }],
            }],
            scale: { minReplicas: 0, maxReplicas: 10 },
          },
        },
      });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${sym}.id` });
      outputs.push({ name: `${construct.id}PrincipalId`, type: 'string', value: `${sym}.identity.principalId` });
      // Fqdn: APIM (cross-stack) consome este output para montar a URL do backend.
      // O FQDN só está disponível após criação com ingress externo — ARM resolve em deploy-time.
      outputs.push({ name: `${construct.id}Fqdn`, type: 'string', value: `${sym}.properties.configuration.ingress.fqdn` });
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
      const routes = (props.routes as Array<Record<string, unknown>>) ?? [];

      // Coleta authorizer IDs por rota (per-route authorizerLambdaId, não apenas top-level).
      const routeAuthorizerIds = [...new Set(routes.filter(r => r.authorizerLambdaId).map(r => r.authorizerLambdaId as string))];
      const hasRouteAuthorizer = routeAuthorizerIds.length > 0;

      // Quando há rotas protegidas, procura um Secret.Vault na mesma stack para usar como
      // JWT signing key via APIM validate-jwt (Azure-native, sem precisar do Container App authorizer).
      const kvEntry = hasRouteAuthorizer ? [...idx.entries()].find(([, c]) => c.type === 'Secret.Vault') : undefined;
      const jwtKvSym = kvEntry ? toSym(kvEntry[0]) : undefined;
      // sym do named value pré-computado para usar como dependsOn nas policies validate-jwt.
      // Sem este dependsOn, o APIM tentaria criar as policies antes do named value existir → ValidationError.
      const apimNamedValueSym = jwtKvSym ? `${sym}JwtNamedValue` : undefined;

      // SEM restore:true — com restore, o ARM falha com ServiceUndeleteNotPossible quando
      // NÃO existe instância soft-deletada com esse nome (caso normal de 1º deploy).
      // Colisão com soft-delete (redeploy no mesmo RG após destroy) se resolve com
      // `az apim deletedservice purge` antes do deploy.
      // SystemAssigned identity necessário para APIM acessar Key Vault via named value.
      resources.push({
        sym,
        type: 'Microsoft.ApiManagement/service',
        apiVersion: '2023-05-01-preview',
        name: apimName,
        location: 'location',
        tags: tag(construct.id),
        sku: { name: 'Consumption', capacity: 0 },
        ...(jwtKvSym ? { identity: { type: 'SystemAssigned' } } : {}),
        properties: {
          publisherEmail: 'admin@example.com',
          publisherName: construct.id,
          virtualNetworkType: 'None',
          customProperties: {
            'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls10': 'false',
            'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls11': 'false',
          },
        },
      });

      // API — um único recurso de API contém todas as operações (rotas).
      // subscriptionRequired:false = SAS/token da app, sem subscription key do APIM.
      const apiSym = `${sym}Api`;
      resources.push({
        sym: apiSym,
        type: 'Microsoft.ApiManagement/service/apis',
        apiVersion: '2023-05-01-preview',
        parent: sym,
        name: 'main',
        properties: { displayName: rawName, path: '', protocols: ['https'], subscriptionRequired: false, serviceUrl: '' },
      });

      // CORS no nível da API — sem ele o browser bloqueia a SAS request (preflight OPTIONS).
      if (props.cors) {
        const corsXml = `<policies><inbound><base /><cors allow-credentials="false"><allowed-origins><origin>*</origin></allowed-origins><allowed-methods preflight-result-max-age="300"><method>*</method></allowed-methods><allowed-headers><header>*</header></allowed-headers></cors></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>`;
        resources.push({ sym: `${sym}ApiPolicy`, type: 'Microsoft.ApiManagement/service/apis/policies', apiVersion: '2023-05-01-preview', parent: apiSym, name: 'policy', properties: { value: corsXml, format: 'xml' } });
      }

      // Backends — um por lambdaId único nas rotas. URL = FQDN do Container App.
      // Same-stack: referencia o sym diretamente (ARM resolve em deploy-time).
      // Cross-stack: usa param Bicep (output Fqdn da outra stack, coletado pelo
      // azureOutputAccumulator no deploy e injetado como --parameters).
      const uniqueLambdaIds = [...new Set(routes.filter(r => r.lambdaId).map(r => r.lambdaId as string))];
      const backendNameMap = new Map<string, string>();
      for (const lambdaId of uniqueLambdaIds) {
        const backendName = `backend-${lambdaId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
        backendNameMap.set(lambdaId, backendName);
        let backendUrl: string;
        if (idx.get(lambdaId)) {
          // Mesma stack: sym do Container App disponível localmente
          const lambdaSym = toSym(lambdaId);
          backendUrl = expr(`'https://\${${lambdaSym}.properties.configuration.ingress.fqdn}'`);
        } else {
          // Stack diferente: param cross-stack gerado a partir do output Fqdn da outra stack
          const fqdnParam = crossParamName(lambdaId, 'Fqdn');
          crossParams.set(fqdnParam, 'string');
          backendUrl = expr(`'https://\${${fqdnParam}}'`);
        }
        resources.push({
          sym: `${sym}Backend${lambdaId.replace(/[^a-zA-Z0-9]/g, '')}`,
          type: 'Microsoft.ApiManagement/service/backends',
          apiVersion: '2023-05-01-preview',
          parent: sym,
          name: backendName,
          properties: {
            url: backendUrl,
            protocol: 'http',
            description: `Container App backend for ${lambdaId}`,
          },
        });
      }

      // Operações + políticas — uma por rota declarada no construct.
      // Rotas com authorizerLambdaId ganham validate-jwt via APIM native policy (Azure-native),
      // sem precisar chamar o Container App authorizer como pré-flight.
      for (let ri = 0; ri < routes.length; ri++) {
        const route = routes[ri];
        const method = (route.method as string) ?? 'GET';
        const path = (route.path as string) ?? '/';
        const lambdaId = route.lambdaId as string | undefined;
        const routeAuthId = route.authorizerLambdaId as string | undefined;
        const opSym = `${sym}Op${ri}`;
        const sanitizedPath = path.replace(/\{(\w+)\+\}/g, '{$1}').replace(/^\$/, '');
        const templateParams = [...sanitizedPath.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], required: true, type: 'string' }));
        resources.push({
          sym: opSym,
          type: 'Microsoft.ApiManagement/service/apis/operations',
          apiVersion: '2023-05-01-preview',
          parent: apiSym,
          name: `op-${method.toLowerCase()}-${ri}`,
          properties: {
            displayName: `${method} ${path}`,
            method,
            urlTemplate: sanitizedPath,
            description: (route.description as string) ?? `${method} ${path}`,
            ...(templateParams.length > 0 ? { templateParameters: templateParams } : {}),
          },
        });
        if (lambdaId) {
          const backendId = backendNameMap.get(lambdaId) ?? `backend-${lambdaId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
          // Rota com authorizerLambdaId e Key Vault disponível → validate-jwt nativo do APIM.
          // O APIM verifica o Bearer token antes de rotear para o backend.
          // dependsOn no named value garante que ele existe antes que a policy seja criada (sem ele → ValidationError).
          const usesJwt = routeAuthId !== undefined && jwtKvSym !== undefined;
          const opXml = usesJwt
            ? `<policies><inbound><base /><validate-jwt header-name="Authorization" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized" require-expiration-time="false"><issuer-signing-keys><key>{{jwt-signing-key}}</key></issuer-signing-keys></validate-jwt><set-backend-service backend-id="${backendId}" /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>`
            : `<policies><inbound><base /><set-backend-service backend-id="${backendId}" /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>`;
          resources.push({
            sym: `${sym}Policy${ri}`,
            type: 'Microsoft.ApiManagement/service/apis/operations/policies',
            apiVersion: '2023-05-01-preview',
            parent: opSym,
            name: 'policy',
            properties: { value: opXml, format: 'xml' },
            ...(usesJwt && apimNamedValueSym ? { dependsOn: [apimNamedValueSym] } : {}),
          });
        }
      }

      // validate-jwt infrastructure: KV access policy + APIM named value.
      // O named value 'jwt-signing-key' é referenciado na policy acima como {{jwt-signing-key}}.
      // dependsOn garante que o APIM já tem acesso ao KV antes de tentar sincronizar o named value.
      if (jwtKvSym) {
        const apimKvAccessPolicySym = `${sym}KvAccessPolicy`;
        resources.push({
          sym: apimKvAccessPolicySym,
          type: 'Microsoft.KeyVault/vaults/accessPolicies',
          apiVersion: '2023-02-01',
          parent: jwtKvSym,
          name: 'add',
          properties: {
            accessPolicies: [{
              tenantId: expr('subscription().tenantId'),
              objectId: expr(`${sym}.identity.principalId`),
              permissions: { secrets: ['get'] },
            }],
          },
        });
        // Usa o sym pré-computado (mesmo valor, mas declarado antes do loop de rotas)
        resources.push({
          sym: `${sym}JwtNamedValue`,
          type: 'Microsoft.ApiManagement/service/namedValues',
          apiVersion: '2023-05-01-preview',
          parent: sym,
          name: 'jwt-signing-key',
          properties: {
            displayName: 'jwt-signing-key',
            secret: true,
            keyVault: {
              secretIdentifier: expr(`'\${${jwtKvSym}.properties.vaultUri}secrets/secret-value'`),
            },
          },
          dependsOn: [apimKvAccessPolicySym],
        });
      }

      // Authorizer backend (se definido no nível do gateway) — same vs. cross-stack
      if (authorizerLambdaId) {
        let authUrl: string;
        if (idx.get(authorizerLambdaId)) {
          const authFnSym = toSym(authorizerLambdaId);
          authUrl = expr(`'https://\${${authFnSym}.properties.configuration.ingress.fqdn}'`);
        } else {
          const authFqdnParam = crossParamName(authorizerLambdaId, 'Fqdn');
          crossParams.set(authFqdnParam, 'string');
          authUrl = expr(`'https://\${${authFqdnParam}}'`);
        }
        resources.push({ sym: `${sym}AuthorizerBackend`, type: 'Microsoft.ApiManagement/service/backends', apiVersion: '2023-05-01-preview', parent: sym, name: 'authorizer-backend', properties: { description: `Lambda authorizer backend (${authorizerLambdaId})`, url: authUrl, protocol: 'http' } });
      }

      outputs.push({ name: `${construct.id}Url`, type: 'string', value: `${sym}.properties.gatewayUrl` });
      break;
    }

    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const rawAttachTo = props.attachTo;
      const attachTo = isRef(rawAttachTo) ? rawAttachTo.constructId : (rawAttachTo as string);
      const attachSym = toSym(attachTo);
      // Azure RBAC usa actions (management plane) e dataActions (data plane).
      // Key Vault com enableRbacAuthorization:true usa data plane — ações de secret
      // devem ir em dataActions, não actions. Sem isso o ARM aceita o template mas
      // o SDK recebe 403 ("Caller is not authorized to perform action").
      const actions: string[] = [];
      const notActions: string[] = [];
      const dataActions: string[] = [];
      const notDataActions: string[] = [];
      for (const s of statements) {
        const rawActions = (s.actions as string[]) ?? [];
        const isAllow = s.effect === 'Allow';
        for (const a of rawActions) {
          // Key Vault data plane: leitura de secrets usa getSecret/action
          if (a.startsWith('secretsmanager:') || a.startsWith('keyvault:')) {
            const da = 'Microsoft.KeyVault/vaults/secrets/getSecret/action';
            if (isAllow) dataActions.push(da); else notDataActions.push(da);
          // Cosmos/DocumentDB management plane
          } else if (a.startsWith('dynamodb:') || a.startsWith('DocumentDB:')) {
            const mgmt = 'Microsoft.DocumentDB/databaseAccounts/*/read';
            if (isAllow) actions.push(mgmt); else notActions.push(mgmt);
          // Storage management plane
          } else if (a.startsWith('s3:') || a.startsWith('storage:')) {
            const mgmt = 'Microsoft.Storage/storageAccounts/blobServices/containers/*';
            if (isAllow) actions.push(mgmt); else notActions.push(mgmt);
          // Service Bus management plane
          } else if (a.startsWith('sqs:') || a.startsWith('servicebus:')) {
            const mgmt = 'Microsoft.ServiceBus/namespaces/queues/*';
            if (isAllow) actions.push(mgmt); else notActions.push(mgmt);
          } else if (a === '*') {
            if (isAllow) actions.push('*'); else notActions.push('*');
          } else {
            const fallback = 'Microsoft.Resources/subscriptions/resourceGroups/read';
            if (isAllow) actions.push(fallback); else notActions.push(fallback);
          }
        }
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
          permissions: [{
            actions: actions.length > 0 ? [...new Set(actions)] : (dataActions.length === 0 ? ['Microsoft.Resources/subscriptions/resourceGroups/read'] : []),
            notActions: [...new Set(notActions)],
            dataActions: [...new Set(dataActions)],
            notDataActions: [...new Set(notDataActions)],
          }],
          assignableScopes: [expr('resourceGroup().id')],
        },
      });
      // Cross-stack: se o construct não está nesta stack, o principalId vem via param
      let principalIdExpr: string;
      if (idx.get(attachTo)) {
        principalIdExpr = `${attachSym}.identity.principalId`;
      } else {
        const principalIdParam = crossParamName(attachTo, 'PrincipalId');
        crossParams.set(principalIdParam, 'string');
        principalIdExpr = principalIdParam;
      }
      resources.push({
        sym: roleAssignSym,
        type: 'Microsoft.Authorization/roleAssignments',
        apiVersion: '2022-04-01',
        name: expr(`guid(resourceGroup().id, '${attachTo}', '${construct.id}')`),
        // dependsOn implícito via roleDefinitionId: roleDefSym.id — não declarar explicitamente
        properties: {
          roleDefinitionId: expr(`${roleDefSym}.id`),
          // principalId = managed identity da Function App (requer identity: SystemAssigned)
          principalId: expr(principalIdExpr),
          principalType: 'ServicePrincipal',
          description: `Role assignment for ${attachTo}`,
        },
      });
      break;
    }

    case 'Events.EventBridge': {
      // Azure equivalente de EventBridge scheduled rules: Logic Apps com Recurrence trigger.
      // Cada rule com cron/rate vira um Logic App que faz HTTP POST no Container App alvo.
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      for (let ri = 0; ri < rules.length; ri++) {
        const r = rules[ri];
        const ruleSym = `${sym}Rule${ri}`;
        const ruleName = ((r.name as string) ?? `${construct.id}-rule-${ri}`).toLowerCase();

        // Montar recurrence a partir de cron (AWS format) ou rate
        let recurrence: Record<string, unknown> = { frequency: 'Day', interval: 1 };
        if (r.cron) {
          // AWS cron: "minute hour day month day-of-week year"  ex: "0 8 * * ? *"
          const parts = (r.cron as string).trim().split(/\s+/);
          const minute = parseInt(parts[0] ?? '0', 10) || 0;
          const hour   = parseInt(parts[1] ?? '0', 10) || 0;
          recurrence = { frequency: 'Day', interval: 1, timeZone: 'UTC', schedule: { hours: [String(hour)], minutes: [minute] } };
        } else if (r.rate) {
          const m = (r.rate as string).toLowerCase().match(/^(\d+)\s+(minute|minutes|hour|hours|day|days)$/);
          if (m) {
            const freqMap: Record<string, string> = { minute: 'Minute', minutes: 'Minute', hour: 'Hour', hours: 'Hour', day: 'Day', days: 'Day' };
            recurrence = { frequency: freqMap[m[2]] ?? 'Hour', interval: parseInt(m[1], 10) };
          }
        }

        // Resolver URL do Container App alvo (mesma stack ou cross-stack)
        let targetUrl: unknown = '';
        const targetLambdaId = r.targetLambdaId as string | undefined;
        if (targetLambdaId) {
          if (idx.get(targetLambdaId)) {
            const lSym = toSym(targetLambdaId);
            targetUrl = expr(`'https://\${${lSym}.properties.configuration.ingress.fqdn}/invoke'`);
          } else {
            const fqdnParam = crossParamName(targetLambdaId, 'Fqdn');
            crossParams.set(fqdnParam, 'string');
            targetUrl = expr(`'https://\${${fqdnParam}}/invoke'`);
          }
        }

        resources.push({
          sym: ruleSym,
          type: 'Microsoft.Logic/workflows',
          apiVersion: '2019-05-01',
          name: ruleName,
          location: 'location',
          tags: tag(construct.id),
          properties: {
            definition: {
              '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
              contentVersion: '1.0.0.0',
              triggers: {
                Recurrence: { type: 'Recurrence', recurrence },
              },
              actions: {
                InvokeTarget: {
                  type: 'Http',
                  inputs: { method: 'POST', uri: targetUrl, body: { rule: ruleName, time: '@{utcNow()}' } },
                  runAfter: {},
                },
              },
            },
            parameters: {},
          },
        });
      }
      break;
    }

    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const actions: Record<string, unknown> = {};
      for (let si = 0; si < steps.length; si++) {
        const s = steps[si];
        const stepName = s.name as string;
        const runAfter = si > 0 ? { [steps[si - 1].name as string]: ['Succeeded'] } : {};
        const stepType = (s.type as string) ?? 'Task';
        if (stepType === 'Wait') {
          // Logic Apps Wait action: usa interval em minutos (mínimo 1).
          const secs = (s.seconds as number) ?? 60;
          const mins = Math.max(1, Math.ceil(secs / 60));
          actions[stepName] = { type: 'Wait', inputs: { interval: { count: mins, unit: 'Minute' } }, runAfter };
        } else {
          // Resolve resource → URL HTTP do Container App.
          // s.resource é um Ref (ainda não processado por resolveValue), então resolvemos
          // manualmente para obter o FQDN com prefixo https://.
          let uri: unknown = '';
          const rawResource = s.resource;
          if (isRef(rawResource)) {
            const refObj = rawResource as Ref;
            const refConstruct = idx.get(refObj.constructId);
            if (refConstruct && (refConstruct.type === 'Function.Lambda' || refConstruct.type === 'Compute.Container')) {
              const lambdaSym = toSym(refObj.constructId);
              uri = expr(`'https://\${${lambdaSym}.properties.configuration.ingress.fqdn}'`);
            } else if (!refConstruct) {
              // cross-stack: injeta param Bicep com o FQDN da stack produtora.
              const fqdnParam = crossParamName(refObj.constructId, 'Fqdn');
              crossParams.set(fqdnParam, 'string');
              uri = expr(`'https://\${${fqdnParam}}'`);
            } else {
              uri = resolveRef(refObj, idx, crossParams);
            }
          } else if (typeof rawResource === 'string') {
            uri = rawResource;
          }
          actions[stepName] = { type: 'Http', inputs: { method: 'POST', uri }, runAfter };
        }
      }
      resources.push({ sym, type: 'Microsoft.Logic/workflows', apiVersion: '2019-05-01', name: construct.id, location: 'location', tags: tag(construct.id), properties: { definition: { '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#', contentVersion: '1.0.0.0', triggers: {}, actions } } });
      // Output do ARN (= resource ID no Azure) para referência cross-stack (ex: WORKFLOW_ID env var).
      // O 2º passo do deploy injeta este valor via param Bicep soft (default '') na stack consumidora.
      outputs.push({ name: crossParamName(construct.id, 'Arn'), type: 'string', value: `${sym}.id` });
      break;
    }

    case 'Messaging.Queue': {
      // Namespace names: lowercase, 6-50 chars, globalmente únicos no Azure.
      const sbQPfx = construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'sb';
      const nsName = expr(`'${sbQPfx}-\${uniqueString(resourceGroup().id)}'`);
      const nsSym = `${sym}Ns`;
      const qSym = `${sym}Queue`;
      resources.push({ sym: nsSym, type: 'Microsoft.ServiceBus/namespaces', apiVersion: '2022-10-01-preview', name: nsName, location: 'location', tags: tag(construct.id), sku: { name: 'Standard', tier: 'Standard' }, properties: {} });
      resources.push({ sym: qSym, type: 'Microsoft.ServiceBus/namespaces/queues', apiVersion: '2022-10-01-preview', parent: nsSym, name: construct.id, properties: { lockDuration: `PT${(props.visibilityTimeoutSeconds as number) ?? 30}S`, maxSizeInMegabytes: 1024, requiresDuplicateDetection: false, requiresSession: false, defaultMessageTimeToLive: `P${Math.floor(((props.messageRetentionSeconds as number) ?? 345600) / 86400)}D`, deadLetteringOnMessageExpiration: false } });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${nsSym}.id` });
      // Output para referência cross-stack via ref(..., 'Url') — gera param ApprovalQueueUrl
      // na stack consumidora. Valor = endpoint do Service Bus namespace (sb://<name>.servicebus.windows.net/).
      outputs.push({ name: crossParamName(construct.id, 'Url'), type: 'string', value: `'sb://\${${nsSym}.name}.servicebus.windows.net/'` });
      // Output da connection string completa — para ref(..., 'ConnectionString') cross-stack.
      // O handler usa @azure/service-bus com esta string (ServiceBusClient.fromConnectionString).
      outputs.push({ name: crossParamName(construct.id, 'ConnectionString'), type: 'string', value: `listKeys(resourceId('Microsoft.ServiceBus/namespaces/authorizationRules', ${nsSym}.name, 'RootManageSharedAccessKey'), '2022-10-01-preview').primaryConnectionString` });
      break;
    }

    case 'Messaging.Stream': {
      const nsName = `${construct.id.toLowerCase()}-ns`;
      const nsSym = `${sym}Ns`;
      resources.push({
        sym: nsSym, type: 'Microsoft.EventHub/namespaces', apiVersion: '2022-10-01-preview',
        name: nsName, location: 'location', tags: tag(construct.id),
        sku: { name: 'Standard', tier: 'Standard', capacity: 1 }, properties: {}
      });
      resources.push({
        sym, type: 'Microsoft.EventHub/namespaces/eventhubs', apiVersion: '2022-10-01-preview',
        parent: nsSym, name: construct.id,
        properties: {
          messageRetentionInDays: Math.ceil(((props.retentionHours as number) ?? 24) / 24),
          partitionCount: (props.shardCount as number) ?? 2
        }
      });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${sym}.id` });
      outputs.push({ name: `${construct.id}Name`, type: 'string', value: `'${construct.id}'` });
      break;
    }

    case 'Messaging.Topic': {
      // Namespace names: lowercase, 6-50 chars, globalmente únicos no Azure.
      const sbTPfx = construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'sb';
      const nsName = expr(`'${sbTPfx}-\${uniqueString(resourceGroup().id)}'`);
      const nsSym = `${sym}Ns`;
      const topicSym = `${sym}Topic`;
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];
      resources.push({ sym: nsSym, type: 'Microsoft.ServiceBus/namespaces', apiVersion: '2022-10-01-preview', name: nsName, location: 'location', tags: tag(construct.id), sku: { name: 'Standard', tier: 'Standard' }, properties: {} });
      resources.push({ sym: topicSym, type: 'Microsoft.ServiceBus/namespaces/topics', apiVersion: '2022-10-01-preview', parent: nsSym, name: construct.id, properties: { defaultMessageTimeToLive: 'P14D', requiresDuplicateDetection: false } });
      subscriptions.forEach((s, i) => {
        // forwardTo is only valid for Service Bus queues/topics in the same namespace.
        // Lambda/container protocol endpoints are external — omit forwardTo.
        const isInternalForward = s.protocol !== 'lambda' && s.protocol !== 'function' && s.protocol !== 'container' && !isRef(s.endpoint as unknown);
        const subProps: Record<string, unknown> = { lockDuration: 'PT30S', deadLetteringOnMessageExpiration: false };
        if (isInternalForward) subProps.forwardTo = s.endpoint;
        resources.push({ sym: `${sym}Sub${i}`, type: 'Microsoft.ServiceBus/namespaces/topics/subscriptions', apiVersion: '2022-10-01-preview', parent: topicSym, name: `sub-${i}`, properties: subProps });
      });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${nsSym}.id` });
      break;
    }

    case 'Secret.Vault': {
      // uniqueString(resourceGroup().id, construct.id) → nome globalmente único, sem soft-delete collision
      // enableRbacAuthorization: true → funciona com Policy.IAM (roleAssignments); sem accessPolicies.
      // enablePurgeProtection: false → permite recriar após destroy sem az keyvault purge.
      // Limite Key Vault: 3-24 chars. kv-(3) + id(7) + -(1) + uniqueString(13) = 24 exatos.
      const kvName = expr(`'kv-${construct.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 7)}-\${uniqueString(resourceGroup().id, '${construct.id}')}'`);
      resources.push({ sym, type: 'Microsoft.KeyVault/vaults', apiVersion: '2023-02-01', name: kvName, location: 'location', tags: tag(construct.id), properties: { sku: { family: 'A', name: 'standard' }, tenantId: expr('subscription().tenantId'), enableSoftDelete: false, enableRbacAuthorization: true, enabledForDeployment: false, accessPolicies: [] } });
      // Gera um secret com valor aleatório-mas-determinístico. Usado como signing key JWT
      // pelo validate-jwt do APIM (via named value ligado ao Key Vault).
      const kvSecretSym = `${sym}SecretValue`;
      // Concatena 3 uniqueString (39 chars) antes de base64() para garantir ≥ 32 bytes após
      // decodificação — mínimo exigido pelo validate-jwt do APIM para HS256 (256 bits).
      // Para gerar JWT de teste: leia o secret do KV → base64-decode → use como signing key no jwt.sign().
      resources.push({ sym: kvSecretSym, type: 'Microsoft.KeyVault/vaults/secrets', apiVersion: '2023-02-01', parent: sym, name: 'secret-value', properties: { value: expr(`base64(concat(uniqueString(resourceGroup().id, '${construct.id}', 'a'), uniqueString(resourceGroup().id, '${construct.id}', 'b'), uniqueString(resourceGroup().id, '${construct.id}', 'c')))`) } });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${sym}.id` });
      outputs.push({ name: `${construct.id}VaultUri`, type: 'string', value: `${sym}.properties.vaultUri` });
      outputs.push({ name: `${construct.id}Name`, type: 'string', value: `${sym}.name` });
      break;
    }

    case 'Certificate.TLS': {
      // Limite Key Vault: 3-24 chars. id(21) + -kv(3) = 24 exatos.
      const kvName = `${construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 21)}-kv`;
      const kvSym = `${sym}Kv`;
      const certSym = `${sym}Cert`;
      resources.push({ sym: kvSym, type: 'Microsoft.KeyVault/vaults', apiVersion: '2023-02-01', name: kvName, location: 'location', properties: { sku: { family: 'A', name: 'standard' }, tenantId: expr('subscription().tenantId'), enableSoftDelete: true, accessPolicies: [] } });
      resources.push({ sym: certSym, type: 'Microsoft.KeyVault/vaults/certificates', apiVersion: '2023-02-01', parent: kvSym, name: construct.id.replace(/[^a-zA-Z0-9-]/g, '-'), properties: { properties: { x509CertificateProperties: { subject: `CN=${props.domainName as string}`, subjectAlternativeNames: { dnsNames: [(props.domainName as string), ...((props.subjectAlternativeNames as string[]) ?? [])] }, validityInMonths: 12 }, issuerParameters: { name: 'Self', issuerName: 'Self' }, keyProperties: { keyType: 'RSA', keySize: 2048, exportable: true } } } });
      break;
    }

    case 'Monitoring.Alarm': {
      const dimensions = props.dimensions as Record<string, string> | undefined;
      const operatorMap: Record<string, string> = { GreaterThanThreshold: 'GreaterThan', LessThanThreshold: 'LessThan', GreaterThanOrEqualToThreshold: 'GreaterThanOrEqual', LessThanOrEqualToThreshold: 'LessThanOrEqual' };
      // Azure Metric Alerts need actionGroups — refs to topics/lambdas are not valid.
      // Auto-create a Microsoft.Insights/actionGroups and wire it to the alarm.
      const rawAlarmActions = (props.alarmActions as unknown[]) ?? [];
      let alarmActionList: Array<Record<string, unknown>> = [];
      if (rawAlarmActions.length > 0) {
        const agSym = `${sym}Ag`;
        const agName = `${construct.id}-ag`;
        const azureFunctionReceivers: Array<Record<string, unknown>> = [];
        for (const action of rawAlarmActions) {
          if (isRef(action as Record<string, unknown>)) {
            const ref = action as Ref;
            const target = idx.get(ref.constructId);
            if (target && (target.type === 'Function.Lambda' || target.type === 'Compute.Container')) {
              const tSym = toSym(ref.constructId);
              azureFunctionReceivers.push({
                name: `fn-${ref.constructId}`,
                functionAppResourceId: expr(`${tSym}.id`),
                functionName: ref.constructId,
                httpTriggerUrl: expr(`'https://\${${tSym}.properties.configuration.ingress.fqdn}/api/alert'`),
                useCommonAlertSchema: true,
              });
            }
            // Messaging.Topic/other: empty action group is valid — Azure will route via email if configured later
          }
        }
        resources.push({ sym: agSym, type: 'Microsoft.Insights/actionGroups', apiVersion: '2023-01-01', name: agName, location: "'global'", tags: tag(construct.id), properties: { groupShortName: 'alert-ag', enabled: true, emailReceivers: [], smsReceivers: [], webhookReceivers: [], azureFunctionReceivers } });
        alarmActionList = [{ actionGroupId: expr(`${agSym}.id`) }];
      }
      // metricAlerts require location 'global' (string literal, not a Bicep identifier).
      // Scope: find a Container App in the same stack to use as the single-resource scope.
      // If none found, fall back to subscription scope with MultipleResource criteria.
      // Convert seconds to nearest allowed ISO 8601 interval (PT1M,PT5M,PT15M,PT30M,PT1H,PT6H,PT12H,P1D).
      const allowedMins = [1, 5, 15, 30, 60, 360, 720, 1440];
      const toInterval = (secs: number): string => {
        const mins = Math.round(secs / 60) || 1;
        const clamped = allowedMins.reduce((a, b) => Math.abs(b - mins) < Math.abs(a - mins) ? b : a);
        if (clamped >= 1440) return 'P1D';
        if (clamped >= 60) return `PT${clamped / 60}H`;
        return `PT${clamped}M`;
      };
      const periodSecs = (props.periodSeconds as number) ?? 60;
      const evalPeriods = (props.evaluationPeriods as number) ?? 1;
      const evalFreq = toInterval(periodSecs);
      const windowSizeVal = toInterval(periodSecs * evalPeriods);
      // Find a Function.Lambda or Compute.Container in the same stack to scope the alarm.
      const lambdaConstruct = [...idx.values()].find(c => c.type === 'Function.Lambda' || c.type === 'Compute.Container');
      let alarmScopes: unknown[];
      let alarmCriteriaType: string;
      let alarmMetricNamespace: string;
      if (lambdaConstruct) {
        const lSym = toSym(lambdaConstruct.id);
        alarmScopes = [expr(`${lSym}.id`)];
        alarmCriteriaType = 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria';
        alarmMetricNamespace = 'Microsoft.App/containerApps';
      } else {
        alarmScopes = [expr('subscription().id')];
        alarmCriteriaType = 'Microsoft.Azure.Monitor.MultipleResourceMultipleMetricCriteria';
        alarmMetricNamespace = 'Microsoft.App/containerApps';
      }
      // Map AWS/abstract metric names to valid Azure Container Apps metrics.
      // Valid Container Apps metrics: Requests, TotalCpuUsage, TotalMemoryUsage, Replicas, RestartCount.
      const metricNameMap: Record<string, string> = {
        Errors: 'Requests', p99: 'Requests', Latency: 'Requests',
        ThrottledRequests: 'Requests', Duration: 'TotalCpuUsage', Invocations: 'Requests',
        ConcurrentExecutions: 'Replicas', Count: 'Requests', RequestDuration: 'Requests',
      };
      const rawMetricName = props.metricName as string;
      const azureMetricName = metricNameMap[rawMetricName] ?? (alarmMetricNamespace === 'Microsoft.App/containerApps' ? 'Requests' : rawMetricName);
      resources.push({ sym, type: 'Microsoft.Insights/metricAlerts', apiVersion: '2018-03-01', name: construct.id, location: "'global'", tags: tag(construct.id), properties: { description: `Alarm for ${props.metricName}`, severity: 2, enabled: true, scopes: alarmScopes, evaluationFrequency: evalFreq, windowSize: windowSizeVal, criteria: { 'odata.type': alarmCriteriaType, allOf: [{ name: 'criterion1', criterionType: 'StaticThresholdCriterion', metricName: azureMetricName, metricNamespace: alarmMetricNamespace, operator: operatorMap[(props.comparisonOperator as string) ?? 'GreaterThanThreshold'] ?? 'GreaterThan', threshold: props.threshold as number, timeAggregation: (props.statistic as string) ?? 'Average', dimensions: [] }] }, actions: alarmActionList } });
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
  /** Path patterns (ex: "/files/{key}", "/files/{key+}") de todos os ApiGateway que apontam pra esse lambda. */
  routePatterns: string[];
}

export function extractAzureFunctionMeta(stack: Stack, allStacks?: Stack[]): AzureFunctionMeta[] {
  // Monta mapa lambdaId → paths das rotas, varrendo os Function.ApiGateway de TODAS as
  // stacks. O ApiGateway costuma ficar numa stack separada dos Function.Lambda (o gerador
  // divide por domínio); sem o universo completo, routesByLambda fica vazio para os lambdas
  // e o adaptador HTTP não consegue extrair os path params nomeados ({key}) → DELETE 400.
  const universe = allStacks ?? [stack];
  const routesByLambda = new Map<string, string[]>();
  for (const s of universe) {
    for (const c of s.constructs) {
      if (c.type !== 'Function.ApiGateway') continue;
      const routes = ((c.props as Record<string, unknown>).routes as Array<Record<string, unknown>>) ?? [];
      for (const route of routes) {
        const lambdaId = route.lambdaId as string | undefined;
        const routePath = route.path as string | undefined;
        if (lambdaId && routePath) {
          if (!routesByLambda.has(lambdaId)) routesByLambda.set(lambdaId, []);
          routesByLambda.get(lambdaId)!.push(routePath);
        }
      }
    }
  }

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
        routePatterns: routesByLambda.get(c.id) ?? [],
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
  // lambdaWithEventGridTrigger: Function.Lambda/Compute.Container que têm Event Grid
  // subscriptions same-stack apontando para eles. Esses containers precisam de
  // minReplicas:1 — com minReplicas:0 o container escala a zero e o primeiro request
  // de validação do Event Grid retorna vazio (cold-start race), fazendo o ARM cancelar
  // a criação da subscription e consequentemente o deployment inteiro.
  const lambdaWithEventGridTrigger = new Set<string>();
  for (const c of stack.constructs) {
    if (c.type !== 'Storage.Bucket') continue;
    const p = c.props as Record<string, unknown>;
    const notifications = (p.eventNotifications as Array<Record<string, unknown>>) ?? [];
    for (const n of notifications) {
      const raw = n.lambdaId;
      const lid = isRef(raw) ? (raw as Ref).constructId : raw as string;
      if (lid && idx.has(lid)) lambdaWithEventGridTrigger.add(lid);
    }
  }

  // subnetsByVpc: subnets agrupadas por VPC — serão declaradas inline em
  // properties.subnets[] do virtualNetworks para evitar AnotherOperationInProgress
  // (ARM não permite operações concorrentes no mesmo VNet; recursos separados falham).
  const subnetsByVpc = new Map<string, Array<{id: string; cidr: string; public: boolean}>>();
  for (const c of stack.constructs) {
    if (c.type !== 'Network.Subnet') continue;
    const p = c.props as Record<string, unknown>;
    const vpcId = p.vpcId;
    const vnetId = isRef(vpcId) ? (vpcId as Ref).constructId : vpcId as string;
    if (!subnetsByVpc.has(vnetId)) subnetsByVpc.set(vnetId, []);
    subnetsByVpc.get(vnetId)!.push({ id: c.id, cidr: p.cidr as string, public: (p.public as boolean) ?? false });
  }

  // ManagedEnvironment compartilhado — free tier Azure limita a 1 env por região.
  // Criado uma única vez se o stack tiver alguma Function.Lambda ou Compute.Container.
  // Se um CAE de outra stack já existe (param sharedCaeId != ''), reutiliza em vez de criar.
  // O deploy/azure.ts injeta sharedCaeId como soft param a partir dos outputs acumulados.
  const hasLambda = stack.constructs.some(c => c.type === 'Function.Lambda' || c.type === 'Compute.Container');
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
      condition: 'empty(sharedCaeId)',
    });
    // Output para que a próxima stack possa reutilizar este CAE sem criar um novo.
    outputs.push({ name: 'sharedCaeId', type: 'string', value: `empty(sharedCaeId) ? ${sharedContainerEnvSym}.id : sharedCaeId` });
  }

  for (const construct of stack.constructs) {
    synthesizeConstruct(construct, idx, resources, outputs, needsAdminPassword, crossParams, functionImageParams, sharedContainerEnvSym, cdnBucketRefs, subnetsByVpc, accountTier);
  }

  // Post-processing: Container Apps com Event Grid trigger same-stack → minReplicas:1.
  // Sem isso, o container parte de zero réplicas e o primeiro request de validação
  // do Event Grid falha (body vazio / 503) por cold-start, cancelando o deployment ARM.
  for (const lambdaId of lambdaWithEventGridTrigger) {
    const app = resources.find(r => r.sym === toSym(lambdaId) && r.type === 'Microsoft.App/containerApps');
    if (app?.properties?.template) {
      const tmpl = app.properties.template as Record<string, unknown>;
      tmpl.scale = { ...(tmpl.scale as object ?? {}), minReplicas: 1 };
    }
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
  // Params ACR + CAE compartilhado — usados quando há Function.Lambda.
  if (hasLambda) {
    params.push({ name: 'acrServer', type: 'string', default: '' });
    params.push({ name: 'acrUser', type: 'string', default: '' });
    params.push({ name: 'acrPassword', type: 'string', default: '', secure: true });
    // sharedCaeId: ID do CAE de outra stack; vazio = criar novo CAE nesta stack.
    // Injetado automaticamente pelo deploy/azure.ts via outputs acumulados.
    params.push({ name: 'sharedCaeId', type: 'string', default: '' });
  }
  // Parâmetros cross-stack
  for (const [name, type] of crossParams) {
    if (type === 'secureString') { params.push({ name, type: 'string', secure: true }); continue; }
    // 'string:optional': param com default '' — permite deploy sem valor (1º passo);
    // o 2º passo re-deploya com o valor real quando disponível nos outputs acumulados.
    if (type === 'string:optional') { params.push({ name, type: 'string', default: '' }); continue; }
    params.push({ name, type });
  }

  return renderBicep(params, resources, outputs);
}
