import { Stack, BaseConstruct } from '@iacmp/core';

export interface ARMResource {
  type: string;
  apiVersion: string;
  name: string;
  location: string;
  properties: Record<string, unknown>;
  kind?: string;
  sku?: Record<string, unknown>;
  dependsOn?: string[];
  identity?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export interface ARMTemplate {
  $schema: string;
  contentVersion: string;
  resources: ARMResource[];
}

const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 'Standard_B1s',
  medium: 'Standard_B2s',
  large: 'Standard_B4ms',
};

const CACHE_SKU_MAP: Record<string, { name: string; family: string; capacity: number }> = {
  small: { name: 'Standard', family: 'C', capacity: 1 },
  medium: { name: 'Standard', family: 'C', capacity: 2 },
  large: { name: 'Premium', family: 'P', capacity: 1 },
};

function tag(name: string): Record<string, string> {
  return { Name: name };
}

function synthesizeConstruct(construct: BaseConstruct): ARMResource[] {
  const props = construct.props as Record<string, unknown>;
  const location = (props.region as string) ?? '[resourceGroup().location]';

  switch (construct.type) {

    // ── Compute ──────────────────────────────────────────────────────────
    case 'Compute.Instance':
      return [{
        type: 'Microsoft.Compute/virtualMachines',
        apiVersion: '2023-03-01',
        name: construct.id,
        location,
        tags: tag(construct.id),
        properties: {
          hardwareProfile: { vmSize: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 'Standard_B1s' },
          storageProfile: { imageReference: { offer: props.image as string } },
          osProfile: { computerName: construct.id, adminUsername: 'azureuser' },
        },
      }];

    case 'Compute.AutoScaling': {
      const vmssBody: ARMResource = {
        type: 'Microsoft.Compute/virtualMachineScaleSets',
        apiVersion: '2023-03-01',
        name: construct.id,
        location,
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
            storageProfile: {
              imageReference: {
                publisher: 'Canonical',
                offer: 'UbuntuServer',
                sku: '22_04-lts',
                version: 'latest',
              },
            },
            osProfile: { computerNamePrefix: construct.id.slice(0, 9), adminUsername: 'azureuser' },
          },
        },
      };

      const autoscaleBody: ARMResource = {
        type: 'Microsoft.Insights/autoscaleSettings',
        apiVersion: '2022-10-01',
        name: `${construct.id}-autoscale`,
        location,
        properties: {
          enabled: true,
          targetResourceUri: `[resourceId('Microsoft.Compute/virtualMachineScaleSets', '${construct.id}')]`,
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
                metricResourceUri: `[resourceId('Microsoft.Compute/virtualMachineScaleSets', '${construct.id}')]`,
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
      };

      return [vmssBody, autoscaleBody];
    }

    case 'Compute.Container': {
      const environment = (props.environment as Record<string, string>) ?? {};
      const envVars = Object.entries(environment).map(([k, v]) => ({ name: k, value: v }));
      return [{
        type: 'Microsoft.ContainerInstance/containerGroups',
        apiVersion: '2023-05-01',
        name: construct.id,
        location,
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
      }];
    }

    case 'Compute.Kubernetes': {
      const nodeType = INSTANCE_TYPE_MAP[props.nodeInstanceType as string] ?? 'Standard_B2s';
      return [{
        type: 'Microsoft.ContainerService/managedClusters',
        apiVersion: '2023-05-01',
        name: construct.id,
        location,
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
          apiServerAccessProfile: {
            enablePrivateCluster: (props.privateCluster as boolean) ?? false,
          },
          networkProfile: { networkPlugin: 'kubenet', loadBalancerSku: 'standard' },
        },
      }];
    }

    // ── Storage ───────────────────────────────────────────────────────────
    case 'Storage.Bucket': {
      const resources: ARMResource[] = [{
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: construct.id.toLowerCase().replace(/[^a-z0-9]/g, ''),
        location,
        kind: 'StorageV2',
        sku: { name: 'Standard_LRS' },
        tags: tag(construct.id),
        properties: {
          allowBlobPublicAccess: (props.publicAccess as boolean) ?? false,
          supportsHttpsTrafficOnly: true,
          minimumTlsVersion: 'TLS1_2',
        },
      }];

      if (props.versioning) {
        resources.push({
          type: 'Microsoft.Storage/storageAccounts/blobServices',
          apiVersion: '2023-01-01',
          name: `${construct.id.toLowerCase().replace(/[^a-z0-9]/g, '')}/default`,
          location,
          properties: { isVersioningEnabled: true },
        });
      }

      return resources;
    }

    case 'Storage.FileSystem':
      return [{
        type: 'Microsoft.Storage/storageAccounts/fileServices/shares',
        apiVersion: '2023-01-01',
        name: `${construct.id.toLowerCase().replace(/[^a-z0-9]/g, '')}share/default/${construct.id}`,
        location,
        properties: {
          shareQuota: 100,
          enabledProtocols: 'SMB',
          accessTier: 'Hot',
        },
      }];

    case 'Storage.Archive':
      return [{
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: `${construct.id.toLowerCase().replace(/[^a-z0-9]/g, '')}arc`,
        location,
        kind: 'BlobStorage',
        sku: { name: 'Standard_LRS' },
        tags: tag(construct.id),
        properties: {
          accessTier: 'Archive',
          allowBlobPublicAccess: false,
          supportsHttpsTrafficOnly: true,
          minimumTlsVersion: 'TLS1_2',
        },
      }];

    // ── Network ───────────────────────────────────────────────────────────
    case 'Network.VPC':
      return [{
        type: 'Microsoft.Network/virtualNetworks',
        apiVersion: '2023-04-01',
        name: construct.id,
        location,
        tags: tag(construct.id),
        properties: {
          addressSpace: { addressPrefixes: [(props.cidr as string) ?? '10.0.0.0/16'] },
          dhcpOptions: { dnsServers: [] },
        },
      }];

    case 'Network.Subnet': {
      const vnetName = props.vpcId as string;
      return [{
        type: 'Microsoft.Network/virtualNetworks/subnets',
        apiVersion: '2023-04-01',
        name: `${vnetName}/${construct.id}`,
        location,
        dependsOn: [`[resourceId('Microsoft.Network/virtualNetworks', '${vnetName}')]`],
        properties: {
          addressPrefix: props.cidr as string,
          privateEndpointNetworkPolicies: (props.public as boolean) ? 'Disabled' : 'Enabled',
        },
      }];
    }

    case 'Network.SecurityGroup': {
      const ingress = (props.ingressRules as Array<Record<string, unknown>>) ?? [];
      const egress = (props.egressRules as Array<Record<string, unknown>>) ?? [];

      const secRules = [
        ...ingress.map((r, i) => ({
          name: `ingress-rule-${i}`,
          properties: {
            priority: 100 + i,
            direction: 'Inbound',
            access: 'Allow',
            protocol: (r.protocol as string) === '-1' ? '*' : (r.protocol as string).toUpperCase(),
            sourcePortRange: '*',
            destinationPortRange: r.fromPort === r.toPort
              ? String(r.fromPort)
              : `${r.fromPort}-${r.toPort}`,
            sourceAddressPrefix: (r.cidr as string) ?? '*',
            destinationAddressPrefix: '*',
            description: (r.description as string) ?? '',
          },
        })),
        ...egress.map((r, i) => ({
          name: `egress-rule-${i}`,
          properties: {
            priority: 200 + i,
            direction: 'Outbound',
            access: 'Allow',
            protocol: (r.protocol as string) === '-1' ? '*' : (r.protocol as string).toUpperCase(),
            sourcePortRange: '*',
            destinationPortRange: r.fromPort === r.toPort
              ? String(r.fromPort)
              : `${r.fromPort}-${r.toPort}`,
            sourceAddressPrefix: '*',
            destinationAddressPrefix: (r.cidr as string) ?? '*',
            description: (r.description as string) ?? '',
          },
        })),
      ];

      return [{
        type: 'Microsoft.Network/networkSecurityGroups',
        apiVersion: '2023-04-01',
        name: construct.id,
        location,
        tags: tag(construct.id),
        properties: { securityRules: secRules },
      }];
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const customRules = rules.filter(r => !r.managedGroup).map((r, i) => ({
        name: (r.name as string) ?? `custom-rule-${i}`,
        priority: (r.priority as number) ?? (i + 1),
        ruleType: 'MatchRule',
        action: (r.action as string) ?? 'Block',
        matchConditions: [{
          matchVariables: [{ variableName: 'RequestHeaders', selector: 'User-Agent' }],
          operator: 'Contains',
          matchValues: (r.matchValues as string[]) ?? ['BadBot'],
        }],
      }));
      const managedRules = rules.filter(r => r.managedGroup).map(r => ({
        ruleSetType: (r.managedGroup as string) ?? 'OWASP',
        ruleSetVersion: '3.2',
      }));

      return [{
        type: 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies',
        apiVersion: '2023-04-01',
        name: construct.id,
        location,
        tags: tag(construct.id),
        properties: {
          policySettings: {
            requestBodyCheck: true,
            maxRequestBodySizeInKb: 128,
            fileUploadLimitInMb: 100,
            state: 'Enabled',
            mode: (props.mode as string) ?? 'Prevention',
          },
          customRules,
          managedRules: {
            managedRuleSets: managedRules.length > 0 ? managedRules : [{ ruleSetType: 'OWASP', ruleSetVersion: '3.2' }],
          },
        },
      }];
    }

    case 'Network.LoadBalancer': {
      const lbType = (props.type as string) ?? 'application';
      const isInternal = (props.scheme as string) === 'internal';
      const listeners = (props.listeners as Array<Record<string, unknown>>) ?? [];
      const targetGroups = (props.targetGroups as Array<Record<string, unknown>>) ?? [];

      if (lbType === 'application') {
        return [{
          type: 'Microsoft.Network/applicationGateways',
          apiVersion: '2023-04-01',
          name: construct.id,
          location,
          tags: tag(construct.id),
          properties: {
            sku: { name: 'Standard_v2', tier: 'Standard_v2', capacity: 2 },
            frontendIPConfigurations: [{ name: 'appGatewayFrontendIP', properties: { publicIPAddress: null } }],
            frontendPorts: listeners.map((l, i) => ({ name: `port${i}`, properties: { port: l.port } })),
            backendAddressPools: targetGroups.map(tg => ({ name: tg.name as string, properties: {} })),
            httpListeners: listeners.map((l, i) => ({
              name: `listener${i}`,
              properties: {
                frontendPort: { id: `port${i}` },
                protocol: (l.protocol as string).toLowerCase() === 'https' ? 'Https' : 'Http',
              },
            })),
            requestRoutingRules: [{
              name: 'rule1',
              properties: { ruleType: 'Basic', priority: 100 },
            }],
          },
        }];
      }

      return [{
        type: 'Microsoft.Network/loadBalancers',
        apiVersion: '2023-04-01',
        name: construct.id,
        location,
        tags: tag(construct.id),
        sku: { name: 'Standard' },
        properties: {
          frontendIPConfigurations: [{ name: 'loadBalancerFrontEnd', properties: {} }],
          backendAddressPools: targetGroups.map(tg => ({ name: tg.name as string })),
          loadBalancingRules: listeners.map((l, i) => ({
            name: `rule${i}`,
            properties: {
              frontendPort: l.port,
              backendPort: l.port,
              protocol: (l.protocol as string).toLowerCase() === 'tcp' ? 'Tcp' : 'Udp',
              enableFloatingIP: false,
            },
          })),
        },
      }];
    }

    case 'Network.CDN': {
      const origins = (props.origins as Array<Record<string, unknown>>) ?? [];
      return [{
        type: 'Microsoft.Cdn/profiles/endpoints',
        apiVersion: '2023-05-01',
        name: `${construct.id}-profile/${construct.id}`,
        location,
        tags: tag(construct.id),
        properties: {
          originHostHeader: origins[0]?.domainName ?? '',
          isHttpAllowed: false,
          isHttpsAllowed: true,
          origins: origins.map(o => ({
            name: (o.id as string) ?? 'origin1',
            properties: { hostName: o.domainName as string, httpPort: 80, httpsPort: 443 },
          })),
          deliveryPolicy: {
            rules: [{
              name: 'enforceHttps',
              order: 1,
              conditions: [{ name: 'RequestScheme', parameters: { operator: 'Equal', matchValues: ['HTTP'] } }],
              actions: [{ name: 'UrlRedirect', parameters: { redirectType: 'Moved', destinationProtocol: 'Https' } }],
            }],
          },
        },
      }];
    }

    case 'Network.Dns': {
      const records = (props.records as Array<Record<string, unknown>>) ?? [];
      const zoneName = props.zoneName as string;

      const resources: ARMResource[] = [{
        type: 'Microsoft.Network/dnsZones',
        apiVersion: '2018-05-01',
        name: zoneName,
        location: 'global',
        tags: tag(construct.id),
        properties: {},
      }];

      for (const r of records) {
        const recordType = (r.type as string).toLowerCase();
        resources.push({
          type: `Microsoft.Network/dnsZones/${recordType}`,
          apiVersion: '2018-05-01',
          name: `${zoneName}/${r.name}`,
          location: 'global',
          dependsOn: [`[resourceId('Microsoft.Network/dnsZones', '${zoneName}')]`],
          properties: {
            TTL: (r.ttl as number) ?? 300,
            [`${recordType.toUpperCase()}Records`]: (r.values as string[]).map(v => ({ value: v })),
          },
        });
      }

      return resources;
    }

    // ── Database ──────────────────────────────────────────────────────────
    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const serverName = `${construct.id.toLowerCase()}-server`;
      const storageBytes = (props.storageGb as number ?? 20) * 1024 * 1024 * 1024;
      const zoneRedundant = (props.multiAz as boolean) ?? false;

      // MySQL → Azure Database for MySQL Flexible Server
      if (engine === 'mysql') {
        return [
          {
            type: 'Microsoft.DBforMySQL/flexibleServers',
            apiVersion: '2023-06-30',
            name: serverName,
            location,
            tags: tag(construct.id),
            sku: { name: 'Standard_D2ds_v4', tier: 'GeneralPurpose' },
            properties: {
              administratorLogin: 'mysqladmin',
              administratorLoginPassword: '[parameters(\'adminPassword\')]',
              version: '8.0.21',
              storage: { storageSizeGB: props.storageGb ?? 20, autoGrow: 'Enabled' },
              backup: { backupRetentionDays: props.backupRetentionDays ?? 7, geoRedundantBackup: 'Disabled' },
              highAvailability: { mode: zoneRedundant ? 'ZoneRedundant' : 'Disabled' },
            },
          },
        ];
      }

      // PostgreSQL → Azure Database for PostgreSQL Flexible Server
      if (engine === 'postgres') {
        return [
          {
            type: 'Microsoft.DBforPostgreSQL/flexibleServers',
            apiVersion: '2023-06-01-preview',
            name: serverName,
            location,
            tags: tag(construct.id),
            sku: { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' },
            properties: {
              administratorLogin: 'pgadmin',
              administratorLoginPassword: '[parameters(\'adminPassword\')]',
              version: '15',
              storage: { storageSizeGB: props.storageGb ?? 32 },
              backup: { backupRetentionDays: props.backupRetentionDays ?? 7, geoRedundantBackup: 'Disabled' },
              highAvailability: { mode: zoneRedundant ? 'ZoneRedundant' : 'Disabled' },
            },
          },
        ];
      }

      // MariaDB → Azure Database for MariaDB
      if (engine === 'mariadb') {
        return [
          {
            type: 'Microsoft.DBforMariaDB/servers',
            apiVersion: '2018-06-01',
            name: serverName,
            location,
            tags: tag(construct.id),
            sku: { name: 'GP_Gen5_2', tier: 'GeneralPurpose', capacity: 2, family: 'Gen5' },
            properties: {
              administratorLogin: 'mariadbadmin',
              administratorLoginPassword: '[parameters(\'adminPassword\')]',
              version: '10.3',
              storageProfile: {
                storageMB: (props.storageGb as number ?? 20) * 1024,
                backupRetentionDays: props.backupRetentionDays ?? 7,
                geoRedundantBackup: 'Disabled',
              },
            },
          },
        ];
      }

      // Oracle → Oracle Database@Azure (exadata-based, requer subscription agreement)
      if (engine === 'oracle') {
        return [
          {
            type: 'Oracle.Database/cloudExadataInfrastructures',
            apiVersion: '2023-09-01',
            name: serverName,
            location,
            tags: tag(construct.id),
            properties: {
              displayName: construct.id,
              shape: 'Exadata.X9M',
              computeCount: 2,
              storageCount: 3,
            },
          },
        ];
      }

      // SQL Server (padrão) → Azure SQL Database
      const edition = (props.edition as string) ?? 'Standard';
      return [
        {
          type: 'Microsoft.Sql/servers',
          apiVersion: '2023-02-01-preview',
          name: serverName,
          location,
          tags: tag(construct.id),
          properties: {
            administratorLogin: 'sqladmin',
            administratorLoginPassword: '[parameters(\'adminPassword\')]',
            version: '12.0',
          },
        },
        {
          type: 'Microsoft.Sql/servers/databases',
          apiVersion: '2023-02-01-preview',
          name: `${serverName}/${construct.id}`,
          location,
          dependsOn: [`[resourceId('Microsoft.Sql/servers', '${serverName}')]`],
          sku: { name: edition === 'ee' ? 'BusinessCritical' : 'Standard', tier: edition === 'ee' ? 'BusinessCritical' : 'Standard' },
          properties: {
            collation: 'SQL_Latin1_General_CP1_CI_AS',
            maxSizeBytes: storageBytes,
            zoneRedundant,
          },
        },
      ];
    }

    case 'Database.DocumentDB':
      return [{
        type: 'Microsoft.DocumentDB/databaseAccounts',
        apiVersion: '2023-04-15',
        name: construct.id.toLowerCase(),
        location,
        tags: tag(construct.id),
        properties: {
          databaseAccountOfferType: 'Standard',
          kind: 'MongoDB',
          locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }],
          backupPolicy: { type: 'Periodic', periodicModeProperties: { backupIntervalInMinutes: 1440, backupRetentionIntervalInHours: 168 } },
          enableAutomaticFailover: (props.deletionProtection as boolean) ?? false,
        },
      }];

    case 'Database.DynamoDB':
      // Azure equivalent: Cosmos DB with Table API
      return [{
        type: 'Microsoft.DocumentDB/databaseAccounts',
        apiVersion: '2023-04-15',
        name: construct.id.toLowerCase(),
        location,
        tags: tag(construct.id),
        properties: {
          databaseAccountOfferType: 'Standard',
          kind: 'GlobalDocumentDB',
          capabilities: [{ name: 'EnableTable' }],
          locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }],
          backupPolicy: { type: 'Continuous', continuousModeProperties: { tier: 'Continuous30Days' } },
        },
      }];

    // ── Cache ─────────────────────────────────────────────────────────────
    case 'Cache.Redis': {
      const skuInfo = CACHE_SKU_MAP[(props.nodeType as string) ?? 'small'];
      return [{
        type: 'Microsoft.Cache/redis',
        apiVersion: '2023-08-01',
        name: construct.id,
        location,
        tags: tag(construct.id),
        sku: { name: skuInfo.name, family: skuInfo.family, capacity: skuInfo.capacity },
        properties: {
          enableNonSslPort: false,
          minimumTlsVersion: '1.2',
          redisVersion: (props.version as string) ?? '7.0',
          redisConfiguration: {
            'maxmemory-policy': 'volatile-lru',
          },
        },
      }];
    }

    case 'Cache.Memcached':
      // Azure doesn't have native Memcached — map to Redis as closest equivalent
      return [{
        type: 'Microsoft.Cache/redis',
        apiVersion: '2023-08-01',
        name: `${construct.id}-cache`,
        location,
        tags: tag(construct.id),
        sku: { name: 'Standard', family: 'C', capacity: (props.numCacheNodes as number) ?? 2 },
        properties: {
          enableNonSslPort: false,
          minimumTlsVersion: '1.2',
          redisConfiguration: {},
        },
      }];

    // ── Function ──────────────────────────────────────────────────────────
    case 'Function.Lambda': {
      const environment = (props.environment as Record<string, string>) ?? {};
      const runtimeMap: Record<string, string> = {
        'nodejs20': 'node|20', 'nodejs18': 'node|18',
        'python3.12': 'python|3.12', 'python3.11': 'python|3.11',
        'java21': 'java|21', 'go1.x': 'go|1', 'dotnet8': 'dotnet|8',
      };
      const baseSettings = [
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' },
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: (props.runtime as string)?.startsWith('nodejs') ? 'node' : (props.runtime as string)?.startsWith('python') ? 'python' : 'dotnet' },
      ];
      const envSettings = Object.entries(environment).map(([k, v]) => ({ name: k, value: v }));
      return [{
        type: 'Microsoft.Web/sites',
        apiVersion: '2023-01-01',
        name: construct.id,
        location,
        kind: 'functionapp',
        tags: tag(construct.id),
        properties: {
          siteConfig: {
            linuxFxVersion: runtimeMap[(props.runtime as string) ?? 'nodejs20'] ?? 'node|20',
            appSettings: [...baseSettings, ...envSettings],
            ...(props.memory ? { memoryAllocation: props.memory } : {}),
          },
          httpsOnly: true,
        },
      }];
    }

    case 'Function.ApiGateway':
      return [{
        type: 'Microsoft.ApiManagement/service',
        apiVersion: '2023-05-01-preview',
        name: (props.name as string) ?? construct.id,
        location,
        tags: tag(construct.id),
        sku: { name: 'Consumption', capacity: 0 },
        properties: {
          publisherEmail: 'admin@example.com',
          publisherName: construct.id,
          virtualNetworkType: 'None',
          customProperties: {
            'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls10': 'false',
            'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls11': 'false',
          },
        },
      }];

    // ── Policy ────────────────────────────────────────────────────────────
    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachType = props.attachType as string;
      const attachTo = props.attachTo as string;

      const actions: string[] = [];
      const notActions: string[] = [];
      for (const s of statements) {
        const stmtActions = s.actions as string[];
        if (s.effect === 'Allow') actions.push(...stmtActions);
        else notActions.push(...stmtActions);
      }

      const principalType = attachType === 'lambda' ? 'FunctionApp' : 'VirtualMachine';

      return [
        {
          type: 'Microsoft.Authorization/roleDefinitions',
          apiVersion: '2022-04-01',
          name: `[guid(resourceGroup().id, '${construct.id}')]`,
          location,
          properties: {
            roleName: `${construct.id}-role`,
            description: (props.description as string) ?? `Custom role for ${attachTo}`,
            type: 'CustomRole',
            permissions: [{
              actions,
              notActions,
              dataActions: [],
              notDataActions: [],
            }],
            assignableScopes: [`[resourceGroup().id]`],
          },
        },
        {
          type: 'Microsoft.Authorization/roleAssignments',
          apiVersion: '2022-04-01',
          name: `[guid(resourceGroup().id, '${attachTo}', '${construct.id}')]`,
          location,
          dependsOn: [`[resourceId('Microsoft.Authorization/roleDefinitions', guid(resourceGroup().id, '${construct.id}'))]`],
          properties: {
            roleDefinitionId: `[resourceId('Microsoft.Authorization/roleDefinitions', guid(resourceGroup().id, '${construct.id}'))]`,
            principalType,
            description: `Role assignment for ${attachTo} (${principalType})`,
          },
        },
      ];
    }

    // ── Events ────────────────────────────────────────────────────────────
    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      return [{
        type: 'Microsoft.EventGrid/namespaces',
        apiVersion: '2023-06-01-preview',
        name: (props.busName as string) ?? construct.id,
        location,
        tags: tag(construct.id),
        sku: { name: 'Standard', capacity: 1 },
        properties: {
          topicsConfiguration: {},
          topicSpacesConfiguration: {
            state: 'Enabled',
          },
        },
      }, ...rules.map(r => ({
        type: 'Microsoft.EventGrid/eventSubscriptions',
        apiVersion: '2022-06-15',
        name: (r.name as string) ?? construct.id,
        location,
        properties: {
          destination: {
            endpointType: 'WebHook',
            properties: { endpointUrl: (r.targetArn as string) ?? '' },
          },
          filter: {
            includedEventTypes: (r.detailTypes as string[]) ?? ['*'],
          },
        },
      }))];
    }

    // ── Workflow ──────────────────────────────────────────────────────────
    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const definition = {
        definition: {
          '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
          contentVersion: '1.0.0.0',
          triggers: {},
          actions: Object.fromEntries(steps.map((s, i) => [s.name as string, {
            type: 'Http',
            inputs: { method: 'POST', uri: (s.resource as string) ?? '' },
            runAfter: i > 0 ? { [steps[i - 1].name as string]: ['Succeeded'] } : {},
          }])),
        },
      };

      return [{
        type: 'Microsoft.Logic/workflows',
        apiVersion: '2019-05-01',
        name: construct.id,
        location,
        tags: tag(construct.id),
        properties: definition,
      }];
    }

    // ── Messaging ─────────────────────────────────────────────────────────
    case 'Messaging.Queue': {
      const nsName = `${construct.id}-ns`;
      return [
        {
          type: 'Microsoft.ServiceBus/namespaces',
          apiVersion: '2022-10-01-preview',
          name: nsName,
          location,
          tags: tag(construct.id),
          sku: { name: 'Standard', tier: 'Standard' },
          properties: {},
        },
        {
          type: 'Microsoft.ServiceBus/namespaces/queues',
          apiVersion: '2022-10-01-preview',
          name: `${nsName}/${construct.id}`,
          location,
          dependsOn: [`[resourceId('Microsoft.ServiceBus/namespaces', '${nsName}')]`],
          properties: {
            lockDuration: `PT${(props.visibilityTimeoutSeconds as number) ?? 30}S`,
            maxSizeInMegabytes: 1024,
            requiresDuplicateDetection: false,
            requiresSession: false,
            defaultMessageTimeToLive: `P${Math.floor(((props.messageRetentionSeconds as number) ?? 345600) / 86400)}D`,
            deadLetteringOnMessageExpiration: false,
          },
        },
      ];
    }

    case 'Messaging.Topic': {
      const nsName = `${construct.id}-ns`;
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];
      const resources: ARMResource[] = [
        {
          type: 'Microsoft.ServiceBus/namespaces',
          apiVersion: '2022-10-01-preview',
          name: nsName,
          location,
          tags: tag(construct.id),
          sku: { name: 'Standard', tier: 'Standard' },
          properties: {},
        },
        {
          type: 'Microsoft.ServiceBus/namespaces/topics',
          apiVersion: '2022-10-01-preview',
          name: `${nsName}/${construct.id}`,
          location,
          dependsOn: [`[resourceId('Microsoft.ServiceBus/namespaces', '${nsName}')]`],
          properties: {
            defaultMessageTimeToLive: 'P14D',
            requiresDuplicateDetection: false,
          },
        },
      ];

      subscriptions.forEach((s, i) => {
        resources.push({
          type: 'Microsoft.ServiceBus/namespaces/topics/subscriptions',
          apiVersion: '2022-10-01-preview',
          name: `${nsName}/${construct.id}/sub-${i}`,
          location,
          dependsOn: [`[resourceId('Microsoft.ServiceBus/namespaces/topics', '${nsName}', '${construct.id}')]`],
          properties: {
            lockDuration: 'PT30S',
            deadLetteringOnMessageExpiration: false,
            forwardTo: s.endpoint,
          },
        });
      });

      return resources;
    }

    // ── Secret / Certificate ──────────────────────────────────────────────
    case 'Secret.Vault': {
      const kvName = `${construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24)}-kv`;
      return [{
        type: 'Microsoft.KeyVault/vaults',
        apiVersion: '2023-02-01',
        name: kvName,
        location,
        tags: tag(construct.id),
        properties: {
          sku: { family: 'A', name: 'standard' },
          tenantId: '[subscription().tenantId]',
          enableSoftDelete: true,
          softDeleteRetentionInDays: 90,
          enablePurgeProtection: true,
          enabledForDeployment: false,
          accessPolicies: [],
        },
      }];
    }

    case 'Certificate.TLS': {
      const kvName = `${construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20)}-kv`;
      return [{
        type: 'Microsoft.KeyVault/vaults/certificates',
        apiVersion: '2023-02-01',
        name: `${kvName}/${construct.id.replace(/[^a-zA-Z0-9-]/g, '-')}`,
        location,
        properties: {
          properties: {
            x509CertificateProperties: {
              subject: `CN=${props.domainName as string}`,
              subjectAlternativeNames: {
                dnsNames: [(props.domainName as string), ...((props.subjectAlternativeNames as string[]) ?? [])],
              },
              validityInMonths: 12,
            },
            issuerParameters: { name: 'Self', issuerName: 'Self' },
            keyProperties: { keyType: 'RSA', keySize: 2048, exportable: true },
          },
        },
      }];
    }

    // ── Monitoring ────────────────────────────────────────────────────────
    case 'Monitoring.Alarm': {
      const dimensions = props.dimensions as Record<string, string> | undefined;
      const operatorMap: Record<string, string> = {
        GreaterThanThreshold: 'GreaterThan',
        LessThanThreshold: 'LessThan',
        GreaterThanOrEqualToThreshold: 'GreaterThanOrEqual',
        LessThanOrEqualToThreshold: 'LessThanOrEqual',
      };
      return [{
        type: 'Microsoft.Insights/metricAlerts',
        apiVersion: '2018-03-01',
        name: construct.id,
        location: 'global',
        tags: tag(construct.id),
        properties: {
          description: `Alarm for ${props.metricName}`,
          severity: 2,
          enabled: true,
          evaluationFrequency: `PT${(props.periodSeconds as number) ?? 60}S`,
          windowSize: `PT${((props.periodSeconds as number) ?? 60) * ((props.evaluationPeriods as number) ?? 2)}S`,
          criteria: {
            'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria',
            allOf: [{
              name: 'criterion1',
              metricName: props.metricName as string,
              metricNamespace: (props.namespace as string) ?? 'Microsoft.Web/sites',
              operator: operatorMap[(props.comparisonOperator as string) ?? 'GreaterThanThreshold'] ?? 'GreaterThan',
              threshold: props.threshold as number,
              timeAggregation: (props.statistic as string) ?? 'Average',
              dimensions: dimensions
                ? Object.entries(dimensions).map(([k, v]) => ({ name: k, operator: 'Include', values: [v] }))
                : [],
            }],
          },
          actions: (props.alarmActions as string[] ?? []).map(a => ({ actionGroupId: a })),
        },
      }];
    }

    case 'Monitoring.Dashboard': {
      const widgets = (props.widgets as Array<Record<string, unknown>>) ?? [];
      return [{
        type: 'Microsoft.Portal/dashboards',
        apiVersion: '2020-09-01-preview',
        name: construct.id,
        location,
        tags: {
          'hidden-title': construct.id,
        },
        properties: {
          lenses: [{
            order: 0,
            parts: widgets.map((w, i) => ({
              position: { x: (i % 3) * 4, y: Math.floor(i / 3) * 4, colSpan: 4, rowSpan: 4 },
              metadata: {
                type: 'Extension/Microsoft_Azure_Monitoring/PartType/MetricsChartPart',
                settings: {
                  content: {
                    options: { chart: { metrics: [{ name: w.metricName, resourceMetadata: {} }] } },
                    title: w.title as string,
                  },
                },
              },
            })),
          }],
        },
      }];
    }

    case 'Logging.Stream': {
      const wsName = `${construct.id}-law`;
      return [{
        type: 'Microsoft.OperationalInsights/workspaces',
        apiVersion: '2022-10-01',
        name: wsName,
        location,
        tags: tag(construct.id),
        properties: {
          sku: { name: 'PerGB2018' },
          retentionInDays: (props.retentionDays as number) ?? 30,
          features: { enableLogAccessUsingOnlyResourcePermissions: true },
        },
      }];
    }

    default:
      return [];
  }
}

export function synthesize(stack: Stack): ARMTemplate {
  const resources: ARMResource[] = [];

  for (const construct of stack.constructs) {
    const result = synthesizeConstruct(construct);
    resources.push(...result);
  }

  return {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    resources,
  };
}
