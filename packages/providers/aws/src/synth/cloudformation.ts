import { Stack, BaseConstruct } from '@iacmp/core';

export interface CloudFormationResource {
  Type: string;
  Properties: Record<string, unknown>;
}

export interface CloudFormationTemplate {
  AWSTemplateFormatVersion: string;
  Description: string;
  Resources: Record<string, CloudFormationResource>;
}

const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 't3.small',
  medium: 't3.medium',
  large: 't3.large',
};

function synthesizeConstruct(construct: BaseConstruct): [string, CloudFormationResource] | null {
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  const props = construct.props as Record<string, unknown>;

  switch (construct.type) {
    case 'Compute.Instance':
      return [logicalId, {
        Type: 'AWS::EC2::Instance',
        Properties: {
          InstanceType: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 't3.small',
          ImageId: props.image as string,
          ...(props.region ? { AvailabilityZone: `${props.region}a` } : {}),
        },
      }];

    case 'Storage.Bucket':
      return [logicalId, {
        Type: 'AWS::S3::Bucket',
        Properties: {
          VersioningConfiguration: props.versioning
            ? { Status: 'Enabled' }
            : { Status: 'Suspended' },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: !props.publicAccess,
            BlockPublicPolicy: !props.publicAccess,
            IgnorePublicAcls: !props.publicAccess,
            RestrictPublicBuckets: !props.publicAccess,
          },
        },
      }];

    case 'Network.VPC':
      return [logicalId, {
        Type: 'AWS::EC2::VPC',
        Properties: {
          CidrBlock: (props.cidr as string) ?? '10.0.0.0/16',
          EnableDnsHostnames: true,
          EnableDnsSupport: true,
          Tags: [{ Key: 'Name', Value: logicalId }],
        },
      }];

    case 'Database.SQL': {
      const engine = props.engine as string;
      return [logicalId, {
        Type: 'AWS::RDS::DBInstance',
        Properties: {
          DBInstanceClass: (props.instanceType as string) ?? 'db.t3.micro',
          Engine: engine === 'postgres' ? 'postgres' : 'mysql',
          EngineVersion: engine === 'postgres' ? '15.4' : '8.0.36',
          AllocatedStorage: '20',
          MultiAZ: (props.multiAz as boolean) ?? false,
          DeletionPolicy: 'Snapshot',
        },
      }];
    }

    case 'Function.Lambda':
      return [logicalId, {
        Type: 'AWS::Lambda::Function',
        Properties: {
          Runtime: 'nodejs20.x',
          Handler: props.handler as string,
          Code: { ZipFile: props.code as string },
          MemorySize: (props.memory as number) ?? 128,
          Timeout: (props.timeout as number) ?? 30,
          Role: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/LambdaExecutionRole' },
        },
      }];

    default:
      return null;
  }
}

export function synthesize(stack: Stack): CloudFormationTemplate {
  const resources: Record<string, CloudFormationResource> = {};

  for (const construct of stack.constructs) {
    const result = synthesizeConstruct(construct);
    if (result) {
      const [id, resource] = result;
      resources[id] = resource;
    }
  }

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Stack ${stack.name} — gerada pelo iacmp`,
    Resources: resources,
  };
}
