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

const AMI_MAP: Record<string, string> = {
  'ubuntu': '{{resolve:ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}',
  'ubuntu-22.04': '{{resolve:ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}',
  'ubuntu-20.04': '{{resolve:ssm:/aws/service/canonical/ubuntu/server/20.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}',
  'amazon-linux-2': '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2}}',
  'amazon-linux-2023': '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}',
};

// Retorna array de [logicalId, resource] para suportar constructs que geram múltiplos recursos
function synthesizeConstruct(construct: BaseConstruct): Array<[string, CloudFormationResource]> {
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  const props = construct.props as Record<string, unknown>;

  switch (construct.type) {
    case 'Compute.Instance':
      return [[logicalId, {
        Type: 'AWS::EC2::Instance',
        Properties: {
          InstanceType: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 't3.small',
          ImageId: AMI_MAP[props.image as string] ?? (props.image as string),
        },
      }]];

    case 'Storage.Bucket':
      return [[logicalId, {
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
      }]];

    case 'Network.VPC':
      return [[logicalId, {
        Type: 'AWS::EC2::VPC',
        Properties: {
          CidrBlock: (props.cidr as string) ?? '10.0.0.0/16',
          EnableDnsHostnames: true,
          EnableDnsSupport: true,
          Tags: [{ Key: 'Name', Value: logicalId }],
        },
      }]];

    case 'Network.Subnet': {
      const isPublic = (props.public as boolean) ?? false;
      return [[logicalId, {
        Type: 'AWS::EC2::Subnet',
        Properties: {
          VpcId: props.vpcId as string,
          CidrBlock: props.cidr as string,
          ...(props.availabilityZone ? { AvailabilityZone: props.availabilityZone as string } : {}),
          MapPublicIpOnLaunch: isPublic,
          Tags: [
            { Key: 'Name', Value: logicalId },
            { Key: 'Type', Value: isPublic ? 'public' : 'private' },
          ],
        },
      }]];
    }

    case 'Network.SecurityGroup': {
      const ingress = (props.ingressRules as Array<Record<string, unknown>>) ?? [];
      const egress = (props.egressRules as Array<Record<string, unknown>>) ?? [];
      return [[logicalId, {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupDescription: (props.description as string) ?? `Security group ${logicalId}`,
          VpcId: props.vpcId as string,
          SecurityGroupIngress: ingress.map(r => ({
            IpProtocol: r.protocol as string,
            FromPort: r.fromPort as number,
            ToPort: r.toPort as number,
            CidrIp: (r.cidr as string) ?? '0.0.0.0/0',
            ...(r.description ? { Description: r.description as string } : {}),
          })),
          SecurityGroupEgress: egress.length > 0
            ? egress.map(r => ({
                IpProtocol: r.protocol as string,
                FromPort: r.fromPort as number,
                ToPort: r.toPort as number,
                CidrIp: (r.cidr as string) ?? '0.0.0.0/0',
                ...(r.description ? { Description: r.description as string } : {}),
              }))
            : [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'Allow all egress' }],
          Tags: [{ Key: 'Name', Value: logicalId }],
        },
      }]];
    }

    case 'Database.SQL': {
      const engine = props.engine as string;
      return [[logicalId, {
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
      }]];
    }

    case 'Function.Lambda': {
      const environment = props.environment as Record<string, string> | undefined;
      return [[logicalId, {
        Type: 'AWS::Lambda::Function',
        Properties: {
          Runtime: 'nodejs20.x',
          Handler: props.handler as string,
          Code: { ZipFile: props.code as string },
          MemorySize: (props.memory as number) ?? 128,
          Timeout: (props.timeout as number) ?? 30,
          Role: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/LambdaExecutionRole' },
          ...(environment && Object.keys(environment).length > 0
            ? { Environment: { Variables: environment } }
            : {}),
        },
      }]];
    }

    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachType = props.attachType as string;
      const attachTo = (props.attachTo as string).replace(/[^a-zA-Z0-9]/g, '');

      const principalService =
        attachType === 'lambda' ? 'lambda.amazonaws.com' :
        attachType === 'compute' ? 'ec2.amazonaws.com' :
        'ec2.amazonaws.com';

      const managedPolicies: string[] = attachType === 'lambda'
        ? ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
        : attachType === 'compute'
        ? ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore']
        : [];

      const policyDoc = {
        Version: '2012-10-17',
        Statement: statements.map(s => ({
          Sid: (s.actions as string[])[0]?.replace(/[^a-zA-Z0-9]/g, '') + 'Stmt',
          Effect: s.effect as string,
          Action: s.actions as string[],
          Resource: (s.resources as string[]) ?? ['*'],
          ...(s.conditions ? { Condition: s.conditions } : {}),
        })),
      };

      const roleLogicalId = `${logicalId}Role`;
      const roleResource: CloudFormationResource = {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { 'Fn::Sub': `${attachTo}-role-\${AWS::StackName}` },
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { Service: principalService },
              Action: 'sts:AssumeRole',
            }],
          },
          ManagedPolicyArns: managedPolicies,
          Policies: [{
            PolicyName: logicalId,
            PolicyDocument: policyDoc,
          }],
          Tags: [{ Key: 'Name', Value: roleLogicalId }],
        },
      };

      // Se for compute, também cria InstanceProfile
      if (attachType === 'compute') {
        const profileLogicalId = `${logicalId}InstanceProfile`;
        const profileResource: CloudFormationResource = {
          Type: 'AWS::IAM::InstanceProfile',
          Properties: {
            InstanceProfileName: { 'Fn::Sub': `${attachTo}-profile-\${AWS::StackName}` },
            Roles: [{ Ref: roleLogicalId }],
          },
        };
        return [[roleLogicalId, roleResource], [profileLogicalId, profileResource]];
      }

      return [[roleLogicalId, roleResource]];
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const scope = (props.scope as string) ?? 'REGIONAL';
      const defaultAction = (props.defaultAction as string) ?? 'allow';

      const wafRules = rules.map((r, i) => ({
        Name: (r.name as string) ?? `rule-${i}`,
        Priority: (r.priority as number) ?? (i + 1),
        Action: { [(r.action as string) === 'block' ? 'Block' : (r.action as string) === 'count' ? 'Count' : 'Allow']: {} },
        VisibilityConfig: {
          SampledRequestsEnabled: true,
          CloudWatchMetricsEnabled: true,
          MetricName: ((r.name as string) ?? `rule${i}`).replace(/[^a-zA-Z0-9]/g, ''),
        },
        Statement: r.managedGroup
          ? { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: r.managedGroup as string } }
          : {
              ByteMatchStatement: {
                SearchString: ((r.matchValues as string[]) ?? ['BadBot'])[0],
                FieldToMatch: { SingleHeader: { Name: 'user-agent' } },
                TextTransformations: [{ Priority: 0, Type: 'NONE' }],
                PositionalConstraint: 'CONTAINS',
              },
            },
      }));

      return [[logicalId, {
        Type: 'AWS::WAFv2::WebACL',
        Properties: {
          Name: logicalId,
          Scope: scope,
          DefaultAction: { [defaultAction === 'block' ? 'Block' : 'Allow']: {} },
          Description: (props.description as string) ?? `WAF ${logicalId}`,
          Rules: wafRules,
          VisibilityConfig: {
            SampledRequestsEnabled: true,
            CloudWatchMetricsEnabled: true,
            MetricName: logicalId,
          },
        },
      }]];
    }

    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const busName = (props.busName as string) ?? 'default';

      const entries: Array<[string, CloudFormationResource]> = [];

      if (busName !== 'default') {
        entries.push([`${logicalId}Bus`, {
          Type: 'AWS::Events::EventBus',
          Properties: { Name: busName },
        }]);
      }

      for (const r of rules) {
        const ruleName = ((r.name as string) ?? 'rule').replace(/[^a-zA-Z0-9]/g, '');
        const ruleLogicalId = `${logicalId}${ruleName}Rule`;
        const pattern: Record<string, unknown> = {};
        if (r.source) pattern['source'] = r.source;
        if (r.detailTypes) pattern['detail-type'] = r.detailTypes;

        entries.push([ruleLogicalId, {
          Type: 'AWS::Events::Rule',
          Properties: {
            Name: r.name as string,
            EventBusName: busName,
            EventPattern: pattern,
            State: 'ENABLED',
            Description: (r.description as string) ?? '',
            Targets: r.targetArn ? [{
              Id: `${ruleName}Target`,
              Arn: r.targetArn as string,
            }] : [],
          },
        }]);
      }

      return entries;
    }

    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const sfType = (props.type as string) ?? 'STANDARD';

      const definition = {
        Comment: (props.description as string) ?? `Workflow ${construct.id}`,
        StartAt: steps.length > 0 ? (steps[0].name as string) : 'Start',
        States: Object.fromEntries(steps.map((s, i) => [
          s.name as string,
          {
            Type: (s.type as string) ?? 'Task',
            Resource: (s.resource as string) ?? { 'Fn::Sub': 'arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:placeholder' },
            Comment: (s.description as string) ?? '',
            ...(i < steps.length - 1
              ? { Next: steps[i + 1].name as string }
              : { End: true }),
          },
        ])),
      };

      return [[logicalId, {
        Type: 'AWS::StepFunctions::StateMachine',
        Properties: {
          StateMachineName: construct.id,
          StateMachineType: sfType,
          DefinitionString: { 'Fn::Sub': JSON.stringify(definition) },
          RoleArn: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/StepFunctionsExecutionRole' },
          LoggingConfiguration: {
            Level: 'ERROR',
            IncludeExecutionData: false,
          },
        },
      }]];
    }

    case 'Cache.Redis': {
      const nodeTypeMap: Record<string, string> = {
        small: 'cache.t3.micro',
        medium: 'cache.t3.medium',
        large: 'cache.r6g.large',
      };
      const numNodes = (props.numCacheNodes as number) ?? 1;
      const autoFailover = (props.automaticFailoverEnabled as boolean) ?? false;

      return [[logicalId, {
        Type: 'AWS::ElastiCache::ReplicationGroup',
        Properties: {
          ReplicationGroupDescription: `Redis cluster ${construct.id}`,
          ReplicationGroupId: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
          CacheNodeType: nodeTypeMap[(props.nodeType as string) ?? 'small'] ?? 'cache.t3.micro',
          Engine: 'redis',
          EngineVersion: '7.0',
          NumCacheClusters: numNodes,
          AutomaticFailoverEnabled: autoFailover && numNodes > 1,
          AtRestEncryptionEnabled: (props.atRestEncryptionEnabled as boolean) ?? true,
          TransitEncryptionEnabled: (props.transitEncryptionEnabled as boolean) ?? true,
        },
      }]];
    }

    case 'Database.DocumentDB': {
      const instanceType = (props.instanceType as string) ?? 'db.t3.medium';
      const instances = (props.instances as number) ?? 1;
      const clusterLogicalId = `${logicalId}Cluster`;

      const clusterResource: CloudFormationResource = {
        Type: 'AWS::DocDB::DBCluster',
        DeletionPolicy: (props.deletionProtection as boolean) ? 'Retain' : 'Snapshot',
        Properties: {
          DBClusterIdentifier: construct.id.toLowerCase(),
          MasterUsername: 'docdbadmin',
          MasterUserPassword: { 'Fn::Sub': '{{resolve:ssm:/iacmp/${AWS::StackName}/docdb-password}}' },
          StorageEncrypted: true,
          BackupRetentionPeriod: 7,
          DeletionProtection: (props.deletionProtection as boolean) ?? false,
          EnableCloudwatchLogsExports: ['audit', 'profiler'],
        },
      };

      const instanceEntries: Array<[string, CloudFormationResource]> = Array.from({ length: instances }, (_, i) => {
        const instLogicalId = `${logicalId}Instance${i + 1}`;
        return [instLogicalId, {
          Type: 'AWS::DocDB::DBInstance',
          Properties: {
            DBClusterIdentifier: { Ref: clusterLogicalId },
            DBInstanceClass: instanceType,
            DBInstanceIdentifier: `${construct.id.toLowerCase()}-${i + 1}`,
          },
        }] as [string, CloudFormationResource];
      });

      return [[clusterLogicalId, clusterResource], ...instanceEntries];
    }

    case 'Messaging.Queue': {
      const fifo = (props.fifo as boolean) ?? false;
      const queueName = fifo
        ? `${construct.id}.fifo`
        : construct.id;

      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::SQS::Queue',
        Properties: {
          QueueName: queueName,
          VisibilityTimeout: (props.visibilityTimeoutSeconds as number) ?? 30,
          MessageRetentionPeriod: (props.messageRetentionSeconds as number) ?? 345600,
          DelaySeconds: (props.delaySeconds as number) ?? 0,
          FifoQueue: fifo,
          SqsManagedSseEnabled: (props.encrypted as boolean) ?? true,
          ...(props.dlqArn ? {
            RedrivePolicy: {
              deadLetterTargetArn: props.dlqArn as string,
              maxReceiveCount: (props.maxReceiveCount as number) ?? 3,
            },
          } : {}),
        },
      }]];

      return entries;
    }

    case 'Messaging.Topic': {
      const fifo = (props.fifo as boolean) ?? false;
      const topicName = fifo ? `${construct.id}.fifo` : construct.id;
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];

      const topicEntry: [string, CloudFormationResource] = [logicalId, {
        Type: 'AWS::SNS::Topic',
        Properties: {
          TopicName: topicName,
          DisplayName: (props.displayName as string) ?? construct.id,
          FifoTopic: fifo,
          KmsMasterKeyId: (props.encrypted as boolean) ? 'alias/aws/sns' : undefined,
          Subscription: subscriptions.map(s => ({
            Protocol: s.protocol,
            Endpoint: s.endpoint,
          })),
        },
      }];

      return [topicEntry];
    }

    default:
      return [];
  }
}

// Gera subnets, IGW e route tables para VPC com maxAzs
function synthesizeVPCChildren(
  logicalId: string,
  cidr: string,
  maxAzs: number,
  resources: Record<string, CloudFormationResource>
): void {
  if (!maxAzs || maxAzs <= 0) return;

  const azLetters = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, maxAzs);
  const cidrBase = cidr.split('.').slice(0, 2).join('.');

  const igwId = `${logicalId}IGW`;
  resources[igwId] = { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: [{ Key: 'Name', Value: igwId }] } };
  resources[`${igwId}Attachment`] = {
    Type: 'AWS::EC2::VPCGatewayAttachment',
    Properties: { VpcId: { Ref: logicalId }, InternetGatewayId: { Ref: igwId } },
  };

  const pubRTId = `${logicalId}PublicRT`;
  resources[pubRTId] = { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: { Ref: logicalId }, Tags: [{ Key: 'Name', Value: pubRTId }] } };
  resources[`${pubRTId}DefaultRoute`] = {
    Type: 'AWS::EC2::Route',
    Properties: { RouteTableId: { Ref: pubRTId }, DestinationCidrBlock: '0.0.0.0/0', GatewayId: { Ref: igwId } },
  };

  azLetters.forEach((az, i) => {
    const pubSubnetId = `${logicalId}PublicSubnet${az.toUpperCase()}`;
    const privSubnetId = `${logicalId}PrivateSubnet${az.toUpperCase()}`;

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
    const entries = synthesizeConstruct(construct);
    for (const [id, resource] of entries) {
      resources[id] = resource;
    }

    if (construct.type === 'Network.VPC') {
      const props = construct.props as Record<string, unknown>;
      const maxAzs = (props.maxAzs as number) ?? 0;
      const cidr = (props.cidr as string) ?? '10.0.0.0/16';
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      synthesizeVPCChildren(logicalId, cidr, maxAzs, resources);
    }
  }

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Stack ${stack.name} — gerada pelo iacmp`,
    Resources: resources,
  };
}
