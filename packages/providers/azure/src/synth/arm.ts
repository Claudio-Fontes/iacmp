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
            imageReference: {
              offer: props.image as string,
            },
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
