import { Stack, BaseConstruct } from '@iacmp/core';

export interface CloudFormationResource {
  Type: string;
  DeletionPolicy?: string;
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

// BUG-06: resolve nomes amigáveis para SSM Parameter paths
const AMI_MAP: Record<string, string> = {
  'ubuntu': '{{resolve:ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}',
  'ubuntu-22.04': '{{resolve:ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}',
  'ubuntu-20.04': '{{resolve:ssm:/aws/service/canonical/ubuntu/server/20.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}',
  'amazon-linux-2': '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2}}',
  'amazon-linux-2023': '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}',
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
          // BUG-06 fix: resolve imagem para SSM path ou usa como literal se for AMI ID (ami-*)
          ImageId: AMI_MAP[props.image as string] ?? (props.image as string),
          // BUG-07 fix: region não mapeia para AvailabilityZone — removido
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

    case 'Network.VPC': {
      const cidr = (props.cidr as string) ?? '10.0.0.0/16';
      const maxAzs = (props.maxAzs as number) ?? 0;
      const resource: CloudFormationResource = {
        Type: 'AWS::EC2::VPC',
        Properties: {
          CidrBlock: cidr,
          EnableDnsHostnames: true,
          EnableDnsSupport: true,
          Tags: [{ Key: 'Name', Value: logicalId }],
        },
      };
      return [logicalId, resource];
      // BUG-03: maxAzs gera subnets/IGW — implementado no synthesize() abaixo
    }

    case 'Database.SQL': {
      const engine = props.engine as string;
      // BUG-02 fix: DeletionPolicy como atributo do resource, não dentro de Properties
      return [logicalId, {
        Type: 'AWS::RDS::DBInstance',
        DeletionPolicy: 'Snapshot',
        Properties: {
          DBInstanceClass: (props.instanceType as string) ?? 'db.t3.micro',
          Engine: engine === 'postgres' ? 'postgres' : 'mysql',
          EngineVersion: engine === 'postgres' ? '15.4' : '8.0.36',
          AllocatedStorage: '20',
          MultiAZ: (props.multiAz as boolean) ?? false,
          MasterUsername: 'dbadmin',
          MasterUserPassword: { 'Fn::Sub': '{{resolve:ssm:/iacmp/${AWS::StackName}/db-password}}' },
          StorageEncrypted: true,
          BackupRetentionPeriod: 7,
        },
      }];
    }

    case 'Function.Lambda': {
      const environment = props.environment as Record<string, string> | undefined;
      return [logicalId, {
        Type: 'AWS::Lambda::Function',
        Properties: {
          Runtime: 'nodejs20.x',
          Handler: props.handler as string,
          Code: { ZipFile: props.code as string },
          MemorySize: (props.memory as number) ?? 128,
          Timeout: (props.timeout as number) ?? 30,
          Role: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/LambdaExecutionRole' },
          // BUG-01 fix: inclui Environment.Variables quando definido
          ...(environment && Object.keys(environment).length > 0
            ? { Environment: { Variables: environment } }
            : {}),
        },
      }];
    }

    default:
      return null;
  }
}

// BUG-03 fix: gera subnets, IGW e route tables para VPC com maxAzs
function synthesizeVPCChildren(
  logicalId: string,
  cidr: string,
  maxAzs: number,
  resources: Record<string, CloudFormationResource>
): void {
  if (!maxAzs || maxAzs <= 0) return;

  const azLetters = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, maxAzs);
  const cidrBase = cidr.split('.').slice(0, 2).join('.'); // ex: "10.0"

  // Internet Gateway
  const igwId = `${logicalId}IGW`;
  resources[igwId] = { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: [{ Key: 'Name', Value: igwId }] } };
  resources[`${igwId}Attachment`] = {
    Type: 'AWS::EC2::VPCGatewayAttachment',
    Properties: { VpcId: { Ref: logicalId }, InternetGatewayId: { Ref: igwId } },
  };

  // Route table público
  const pubRTId = `${logicalId}PublicRT`;
  resources[pubRTId] = { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: { Ref: logicalId }, Tags: [{ Key: 'Name', Value: pubRTId }] } };
  resources[`${pubRTId}DefaultRoute`] = {
    Type: 'AWS::EC2::Route',
    Properties: { RouteTableId: { Ref: pubRTId }, DestinationCidrBlock: '0.0.0.0/0', GatewayId: { Ref: igwId } },
  };

  azLetters.forEach((az, i) => {
    const pubSubnetId = `${logicalId}PublicSubnet${az.toUpperCase()}`;
    const privSubnetId = `${logicalId}PrivateSubnet${az.toUpperCase()}`;

    // Subnet pública
    resources[pubSubnetId] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: { Ref: logicalId },
        CidrBlock: `${cidrBase}.${i * 2}.0/24`,
        AvailabilityZone: { 'Fn::Select': [i, { 'Fn::GetAZs': '' }] },
        MapPublicIpOnLaunch: true,
        Tags: [{ Key: 'Name', Value: pubSubnetId }],
      },
    };
    resources[`${pubSubnetId}RTAssoc`] = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: { SubnetId: { Ref: pubSubnetId }, RouteTableId: { Ref: pubRTId } },
    };

    // Subnet privada
    resources[privSubnetId] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: { Ref: logicalId },
        CidrBlock: `${cidrBase}.${i * 2 + 1}.0/24`,
        AvailabilityZone: { 'Fn::Select': [i, { 'Fn::GetAZs': '' }] },
        Tags: [{ Key: 'Name', Value: privSubnetId }],
      },
    };
  });
}

export function synthesize(stack: Stack): CloudFormationTemplate {
  const resources: Record<string, CloudFormationResource> = {};

  for (const construct of stack.constructs) {
    const result = synthesizeConstruct(construct);
    if (result) {
      const [id, resource] = result;
      resources[id] = resource;

      // BUG-03: gera recursos filhos da VPC quando maxAzs está definido
      if (construct.type === 'Network.VPC') {
        const props = construct.props as Record<string, unknown>;
        const maxAzs = (props.maxAzs as number) ?? 0;
        const cidr = (props.cidr as string) ?? '10.0.0.0/16';
        synthesizeVPCChildren(id, cidr, maxAzs, resources);
      }
    }
  }

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Stack ${stack.name} — gerada pelo iacmp`,
    Resources: resources,
  };
}
