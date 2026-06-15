import { Stack, BaseConstruct } from '@iacmp/core';

export interface GCPResource {
  name: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface GCPDeployment {
  resources: GCPResource[];
}

const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 'e2-small',
  medium: 'e2-medium',
  large: 'e2-standard-4',
};

function synthesizeConstruct(construct: BaseConstruct): GCPResource[] {
  const props = construct.props as Record<string, unknown>;
  const zone = (props.region as string) ?? 'us-central1-a';

  switch (construct.type) {
    case 'Compute.Instance':
      return [{
        name: construct.id,
        type: 'compute.v1.instance',
        properties: {
          zone,
          machineType: `zones/${zone}/machineTypes/${INSTANCE_TYPE_MAP[props.instanceType as string] ?? 'e2-small'}`,
          disks: [{
            boot: true,
            autoDelete: true,
            initializeParams: {
              sourceImage: `global/images/${props.image as string ?? 'ubuntu-2204-lts'}`,
            },
          }],
          networkInterfaces: [{
            network: 'global/networks/default',
          }],
        },
      }];

    case 'Storage.Bucket':
      return [{
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        type: 'storage.v1.bucket',
        properties: {
          location: (props.region as string) ?? 'US',
          versioning: {
            enabled: (props.versioning as boolean) ?? false,
          },
          iamConfiguration: {
            uniformBucketLevelAccess: {
              enabled: !(props.publicAccess as boolean),
            },
          },
        },
      }];

    case 'Network.VPC':
      return [{
        name: construct.id,
        type: 'compute.v1.network',
        properties: {
          autoCreateSubnetworks: false,
          routingConfig: {
            routingMode: 'REGIONAL',
          },
        },
      }];

    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const dbVersion = engine === 'postgres' ? 'POSTGRES_15' : 'MYSQL_8_0';
      return [{
        name: construct.id,
        type: 'sqladmin.v1beta4.instance',
        properties: {
          databaseVersion: dbVersion,
          region: (props.region as string) ?? 'us-central1',
          settings: {
            tier: 'db-f1-micro',
            backupConfiguration: {
              enabled: true,
            },
          },
        },
      }];
    }

    case 'Function.Lambda': {
      const environment = (props.environment as Record<string, string>) ?? {};
      return [{
        name: construct.id,
        type: 'cloudfunctions.v2.function',
        properties: {
          location: (props.region as string) ?? 'us-central1',
          description: `Function ${construct.id} — gerada pelo iacmp`,
          buildConfig: {
            runtime: 'nodejs20',
            entryPoint: (props.handler as string) ?? 'handler',
          },
          serviceConfig: {
            availableMemory: `${(props.memory as number) ?? 128}M`,
            timeoutSeconds: (props.timeout as number) ?? 30,
            ...(Object.keys(environment).length > 0 ? { environmentVariables: environment } : {}),
          },
        },
      }];
    }

    default:
      return [];
  }
}

export function synthesize(stack: Stack): GCPDeployment {
  const resources: GCPResource[] = [];

  for (const construct of stack.constructs) {
    const result = synthesizeConstruct(construct);
    resources.push(...result);
  }

  return { resources };
}
