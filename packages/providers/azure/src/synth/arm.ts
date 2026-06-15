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

const DB_ENGINE_MAP: Record<string, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
};

function synthesizeConstruct(construct: BaseConstruct): ARMResource[] {
  const props = construct.props as Record<string, unknown>;
  const location = (props.region as string) ?? '[resourceGroup().location]';

  switch (construct.type) {
    case 'Compute.Instance':
      return [{
        type: 'Microsoft.Compute/virtualMachines',
        apiVersion: '2023-03-01',
        name: construct.id,
        location,
        properties: {
          hardwareProfile: {
            vmSize: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 'Standard_B1s',
          },
          storageProfile: {
            imageReference: { offer: props.image as string },
          },
          osProfile: {
            computerName: construct.id,
            adminUsername: 'azureuser',
          },
        },
      }];

    case 'Storage.Bucket':
      return [{
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: construct.id.toLowerCase().replace(/[^a-z0-9]/g, ''),
        location,
        kind: 'StorageV2',
        sku: { name: 'Standard_LRS' },
        properties: {
          allowBlobPublicAccess: (props.publicAccess as boolean) ?? false,
          supportsHttpsTrafficOnly: true,
          minimumTlsVersion: 'TLS1_2',
        },
      }];

    case 'Network.VPC':
      return [{
        type: 'Microsoft.Network/virtualNetworks',
        apiVersion: '2023-04-01',
        name: construct.id,
        location,
        properties: {
          addressSpace: {
            addressPrefixes: [(props.cidr as string) ?? '10.0.0.0/16'],
          },
        },
      }];

    case 'Network.Subnet': {
      const vnetName = (props.vpcId as string);
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
        properties: {
          securityRules: secRules,
        },
      }];
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const defaultAction = (props.defaultAction as string) ?? 'Allow';

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

    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const serverName = `${construct.id.toLowerCase()}-server`;
      return [
        {
          type: 'Microsoft.Sql/servers',
          apiVersion: '2023-02-01-preview',
          name: serverName,
          location,
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
          properties: {
            collation: 'SQL_Latin1_General_CP1_CI_AS',
            catalogCollation: DB_ENGINE_MAP[engine] ?? 'SQL_Latin1_General_CP1_CI_AS',
            maxSizeBytes: 2147483648,
          },
        },
      ];
    }

    case 'Function.Lambda': {
      const environment = (props.environment as Record<string, string>) ?? {};
      const baseSettings = [
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' },
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' },
      ];
      const envSettings = Object.entries(environment).map(([k, v]) => ({ name: k, value: v }));
      return [{
        type: 'Microsoft.Web/sites',
        apiVersion: '2023-01-01',
        name: construct.id,
        location,
        kind: 'functionapp',
        properties: {
          siteConfig: {
            nodeVersion: '~20',
            appSettings: [...baseSettings, ...envSettings],
          },
          httpsOnly: true,
        },
      }];
    }

    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachType = props.attachType as string;
      const attachTo = props.attachTo as string;

      // No Azure, IAM → RBAC via role definition + assignment
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

    case 'Policy.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      return rules.map(r => ({
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
      }));
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
