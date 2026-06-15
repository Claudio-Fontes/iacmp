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
  const region = zone.split('-').slice(0, 2).join('-');

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
              sourceImage: `global/images/${(props.image as string) ?? 'ubuntu-2204-lts'}`,
            },
          }],
          networkInterfaces: [{ network: 'global/networks/default' }],
        },
      }];

    case 'Storage.Bucket':
      return [{
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        type: 'storage.v1.bucket',
        properties: {
          location: (props.region as string) ?? 'US',
          versioning: { enabled: (props.versioning as boolean) ?? false },
          iamConfiguration: {
            uniformBucketLevelAccess: { enabled: !(props.publicAccess as boolean) },
          },
        },
      }];

    case 'Network.VPC':
      return [{
        name: construct.id,
        type: 'compute.v1.network',
        properties: {
          autoCreateSubnetworks: false,
          routingConfig: { routingMode: 'REGIONAL' },
        },
      }];

    case 'Network.Subnet': {
      return [{
        name: construct.id,
        type: 'compute.v1.subnetwork',
        properties: {
          network: `global/networks/${props.vpcId as string}`,
          ipCidrRange: props.cidr as string,
          region: region,
          privateIpGoogleAccess: !(props.public as boolean),
        },
      }];
    }

    case 'Network.SecurityGroup': {
      const ingress = (props.ingressRules as Array<Record<string, unknown>>) ?? [];
      const egress = (props.egressRules as Array<Record<string, unknown>>) ?? [];

      // No GCP: Firewall rules por entrada
      const ingressResources: GCPResource[] = ingress.map((r, i) => ({
        name: `${construct.id}-ingress-${i}`,
        type: 'compute.v1.firewall',
        properties: {
          network: `global/networks/${props.vpcId as string}`,
          direction: 'INGRESS',
          priority: 1000 + i,
          allowed: [{
            IPProtocol: r.protocol as string,
            ports: r.fromPort === r.toPort
              ? [`${r.fromPort}`]
              : [`${r.fromPort}-${r.toPort}`],
          }],
          sourceRanges: [(r.cidr as string) ?? '0.0.0.0/0'],
          description: (r.description as string) ?? '',
        },
      }));

      const egressList = egress.length > 0 ? egress : [{
        protocol: 'all', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0', description: 'Allow all egress',
      }];
      const egressResources: GCPResource[] = egressList.map((r: Record<string, unknown>, i) => ({
        name: `${construct.id}-egress-${i}`,
        type: 'compute.v1.firewall',
        properties: {
          network: `global/networks/${props.vpcId as string}`,
          direction: 'EGRESS',
          priority: 1000 + i,
          allowed: [{
            IPProtocol: (r.protocol as string) === '-1' ? 'all' : r.protocol as string,
            ...(r.protocol !== '-1' && r.fromPort !== 0 ? {
              ports: r.fromPort === r.toPort ? [`${r.fromPort}`] : [`${r.fromPort}-${r.toPort}`],
            } : {}),
          }],
          destinationRanges: [(r.cidr as string) ?? '0.0.0.0/0'],
          description: (r.description as string) ?? '',
        },
      }));

      return [...ingressResources, ...egressResources];
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const securityRules = rules.map((r, i) => ({
        priority: (r.priority as number) ?? (i + 1),
        action: (r.action as string) ?? 'allow',
        match: {
          versionedExpr: 'SRC_IPS_V1',
          config: {
            srcIpRanges: (r.sourceIps as string[]) ?? ['*'],
          },
        },
        description: (r.description as string) ?? '',
      }));

      return [{
        name: construct.id,
        type: 'compute.v1.securityPolicy',
        properties: {
          description: (props.description as string) ?? `WAF ${construct.id}`,
          rules: securityRules.length > 0 ? securityRules : [{
            priority: 2147483647,
            action: (props.defaultAction as string) ?? 'allow',
            match: {
              versionedExpr: 'SRC_IPS_V1',
              config: { srcIpRanges: ['*'] },
            },
            description: 'Default rule',
          }],
        },
      }];
    }

    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const dbVersion = engine === 'postgres' ? 'POSTGRES_15' : 'MYSQL_8_0';
      return [{
        name: construct.id,
        type: 'sqladmin.v1beta4.instance',
        properties: {
          databaseVersion: dbVersion,
          region: region !== 'us-central1-a' ? region : 'us-central1',
          settings: {
            tier: 'db-f1-micro',
            backupConfiguration: { enabled: true },
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
          location: region !== 'us-central1-a' ? region : 'us-central1',
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

    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachTo = props.attachTo as string;
      const serviceAccount = `${attachTo.toLowerCase().replace(/[^a-z0-9-]/g, '-')}@PROJECT_ID.iam.gserviceaccount.com`;

      return [
        {
          name: `${construct.id}-sa`,
          type: 'iam.v1.serviceAccount',
          properties: {
            accountId: attachTo.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30),
            displayName: `Service Account for ${attachTo}`,
            description: (props.description as string) ?? '',
          },
        },
        ...statements.map((s, i) => ({
          name: `${construct.id}-binding-${i}`,
          type: 'gcp-types/cloudresourcemanager-v1:virtual.projects.iamMemberBinding',
          properties: {
            resource: 'PROJECT_ID',
            role: (s.actions as string[])[0]?.startsWith('roles/')
              ? (s.actions as string[])[0]
              : `roles/custom.${construct.id.replace(/[^a-zA-Z0-9]/g, '')}`,
            member: `serviceAccount:${serviceAccount}`,
          },
        })),
      ];
    }

    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const definition = {
        Comment: (props.description as string) ?? `Workflow ${construct.id}`,
        StartAt: steps.length > 0 ? (steps[0].name as string) : 'Start',
        States: Object.fromEntries(steps.map((s, i) => [
          s.name as string,
          {
            Type: (s.type as string) ?? 'Task',
            Resource: (s.resource as string) ?? 'arn:aws:lambda:us-east-1:ACCOUNT:function:placeholder',
            ...(i < steps.length - 1
              ? { Next: steps[i + 1].name as string }
              : { End: true }),
          },
        ])),
      };

      return [{
        name: construct.id,
        type: 'workflows.v1.workflow',
        properties: {
          region: region !== 'us-central1-a' ? region : 'us-central1',
          description: (props.description as string) ?? '',
          sourceContents: JSON.stringify(definition, null, 2),
        },
      }];
    }

    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      return rules.map(r => ({
        name: `${construct.id}-${(r.name as string) ?? 'rule'}`,
        type: 'pubsub.v1.topic',
        properties: {
          topic: (r.name as string) ?? construct.id,
          messageStoragePolicy: {
            allowedPersistenceRegions: [region !== 'us-central1-a' ? region : 'us-central1'],
          },
        },
      }));
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
