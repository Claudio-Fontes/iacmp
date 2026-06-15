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

const CACHE_NODE_TYPE_MAP: Record<string, string> = {
  small: 'cache.t3.micro',
  medium: 'cache.t3.medium',
  large: 'cache.r6g.large',
};

const K8S_NODE_TYPE_MAP: Record<string, string> = {
  small: 't3.medium',
  medium: 'm5.large',
  large: 'm5.2xlarge',
};

function synthesizeConstruct(construct: BaseConstruct): Array<[string, CloudFormationResource]> {
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  const props = construct.props as Record<string, unknown>;

  switch (construct.type) {

    // ── Compute ──────────────────────────────────────────────────────────
    case 'Compute.Instance':
      return [[logicalId, {
        Type: 'AWS::EC2::Instance',
        Properties: {
          InstanceType: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 't3.small',
          ImageId: AMI_MAP[props.image as string] ?? (props.image as string),
        },
      }]];

    case 'Compute.AutoScaling': {
      const lcId = `${logicalId}LC`;
      const asgId = `${logicalId}ASG`;
      const spId = `${logicalId}ScalingPolicy`;

      const lc: CloudFormationResource = {
        Type: 'AWS::AutoScaling::LaunchConfiguration',
        Properties: {
          ImageId: AMI_MAP[props.image as string] ?? (props.image as string),
          InstanceType: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 't3.small',
          ...(props.securityGroupIds ? { SecurityGroups: props.securityGroupIds } : {}),
        },
      };

      const asg: CloudFormationResource = {
        Type: 'AWS::AutoScaling::AutoScalingGroup',
        Properties: {
          LaunchConfigurationName: { Ref: lcId },
          MinSize: String(props.minCapacity ?? 1),
          MaxSize: String(props.maxCapacity ?? 3),
          DesiredCapacity: String(props.desiredCapacity ?? props.minCapacity ?? 1),
          ...(props.subnetIds ? { VPCZoneIdentifier: props.subnetIds } : {}),
          Tags: [{ Key: 'Name', Value: logicalId, PropagateAtLaunch: true }],
        },
      };

      const entries: Array<[string, CloudFormationResource]> = [[lcId, lc], [asgId, asg]];

      if (props.targetCpuUtilization) {
        entries.push([spId, {
          Type: 'AWS::AutoScaling::ScalingPolicy',
          Properties: {
            AutoScalingGroupName: { Ref: asgId },
            PolicyType: 'TargetTrackingScaling',
            TargetTrackingConfiguration: {
              PredefinedMetricSpecification: { PredefinedMetricType: 'ASGAverageCPUUtilization' },
              TargetValue: props.targetCpuUtilization,
            },
          },
        }]);
      }

      return entries;
    }

    case 'Compute.Container': {
      const clusterLogicalId = `${logicalId}Cluster`;
      const tdLogicalId = `${logicalId}TaskDef`;
      const svcLogicalId = `${logicalId}Service`;
      const environment = props.environment as Record<string, string> | undefined;

      return [
        [clusterLogicalId, {
          Type: 'AWS::ECS::Cluster',
          Properties: { ClusterName: construct.id },
        }],
        [tdLogicalId, {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            Family: construct.id,
            NetworkMode: 'awsvpc',
            RequiresCompatibilities: ['FARGATE'],
            Cpu: String(props.cpu ?? 256),
            Memory: String(props.memory ?? 512),
            ExecutionRoleArn: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/ecsTaskExecutionRole' },
            ContainerDefinitions: [{
              Name: construct.id,
              Image: props.image as string,
              PortMappings: props.port ? [{ ContainerPort: props.port, Protocol: 'tcp' }] : [],
              Environment: environment
                ? Object.entries(environment).map(([k, v]) => ({ Name: k, Value: v }))
                : [],
              LogConfiguration: {
                LogDriver: 'awslogs',
                Options: {
                  'awslogs-group': `/ecs/${construct.id}`,
                  'awslogs-region': { Ref: 'AWS::Region' },
                  'awslogs-stream-prefix': 'ecs',
                },
              },
            }],
          },
        }],
        [svcLogicalId, {
          Type: 'AWS::ECS::Service',
          Properties: {
            Cluster: { Ref: clusterLogicalId },
            TaskDefinition: { Ref: tdLogicalId },
            DesiredCount: props.desiredCount ?? 1,
            LaunchType: 'FARGATE',
            NetworkConfiguration: {
              AwsvpcConfiguration: {
                AssignPublicIp: (props.publicIp as boolean) ? 'ENABLED' : 'DISABLED',
                Subnets: [],
              },
            },
          },
        }],
      ];
    }

    case 'Compute.Kubernetes': {
      return [
        [logicalId, {
          Type: 'AWS::EKS::Cluster',
          Properties: {
            Name: construct.id,
            Version: (props.version as string) ?? '1.29',
            ResourcesVpcConfig: {
              SubnetIds: [],
              EndpointPrivateAccess: (props.privateCluster as boolean) ?? false,
              EndpointPublicAccess: !(props.privateCluster as boolean),
            },
            RoleArn: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/EKSClusterRole' },
          },
        }],
        [`${logicalId}NodeGroup`, {
          Type: 'AWS::EKS::Nodegroup',
          Properties: {
            ClusterName: { Ref: logicalId },
            NodegroupName: `${construct.id}-ng`,
            ScalingConfig: {
              MinSize: props.minNodes ?? 1,
              MaxSize: props.maxNodes ?? 3,
              DesiredSize: props.desiredNodes ?? 2,
            },
            InstanceTypes: [K8S_NODE_TYPE_MAP[(props.nodeInstanceType as string) ?? 'medium'] ?? 'm5.large'],
            NodeRole: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/EKSNodeRole' },
            Subnets: [],
          },
        }],
      ];
    }

    // ── Storage ───────────────────────────────────────────────────────────
    case 'Storage.Bucket': {
      const lifecycleRules = (props.lifecycleRules as Array<Record<string, unknown>>) ?? [];
      return [[logicalId, {
        Type: 'AWS::S3::Bucket',
        Properties: {
          VersioningConfiguration: props.versioning ? { Status: 'Enabled' } : { Status: 'Suspended' },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: !props.publicAccess,
            BlockPublicPolicy: !props.publicAccess,
            IgnorePublicAcls: !props.publicAccess,
            RestrictPublicBuckets: !props.publicAccess,
          },
          ...(lifecycleRules.length > 0 ? {
            LifecycleConfiguration: {
              Rules: lifecycleRules.map((r, i) => ({
                Id: `rule-${i}`,
                Status: 'Enabled',
                ...(r.prefix ? { Prefix: r.prefix } : {}),
                ...(r.expireAfterDays ? { ExpirationInDays: r.expireAfterDays } : {}),
                ...(r.transitionToGlacierDays ? {
                  Transitions: [{ TransitionInDays: r.transitionToGlacierDays, StorageClass: 'GLACIER' }],
                } : {}),
              })),
            },
          } : {}),
        },
      }]];
    }

    case 'Storage.FileSystem': {
      const accessPoints = (props.accessPoints as Array<Record<string, unknown>>) ?? [];
      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::EFS::FileSystem',
        Properties: {
          PerformanceMode: (props.performanceMode as string) ?? 'generalPurpose',
          ThroughputMode: (props.throughputMode as string) ?? 'bursting',
          Encrypted: (props.encrypted as boolean) ?? true,
          LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }],
          FileSystemTags: [{ Key: 'Name', Value: construct.id }],
        },
      }]];

      for (const ap of accessPoints) {
        const apId = `${logicalId}AP${(ap.name as string).replace(/[^a-zA-Z0-9]/g, '')}`;
        entries.push([apId, {
          Type: 'AWS::EFS::AccessPoint',
          Properties: {
            FileSystemId: { Ref: logicalId },
            RootDirectory: { Path: ap.path as string },
            ...(ap.uid ? { PosixUser: { Uid: String(ap.uid), Gid: String(ap.gid ?? ap.uid) } } : {}),
            AccessPointTags: [{ Key: 'Name', Value: ap.name as string }],
          },
        }]);
      }
      return entries;
    }

    case 'Storage.Archive': {
      return [[logicalId, {
        Type: 'AWS::S3::Bucket',
        Properties: {
          LifecycleConfiguration: {
            Rules: [{
              Id: 'archive-rule',
              Status: 'Enabled',
              Transitions: [{ TransitionInDays: 0, StorageClass: 'DEEP_ARCHIVE' }],
              ...(props.retentionDays ? { ExpirationInDays: props.retentionDays } : {}),
            }],
          },
          ObjectLockEnabled: (props.lockEnabled as boolean) ?? false,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true, BlockPublicPolicy: true,
            IgnorePublicAcls: true, RestrictPublicBuckets: true,
          },
        },
      }]];
    }

    // ── Network ───────────────────────────────────────────────────────────
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
          Tags: [{ Key: 'Name', Value: logicalId }, { Key: 'Type', Value: isPublic ? 'public' : 'private' }],
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
            ...(r.description ? { Description: r.description } : {}),
          })),
          SecurityGroupEgress: egress.length > 0
            ? egress.map(r => ({
                IpProtocol: r.protocol as string,
                FromPort: r.fromPort as number,
                ToPort: r.toPort as number,
                CidrIp: (r.cidr as string) ?? '0.0.0.0/0',
                ...(r.description ? { Description: r.description } : {}),
              }))
            : [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'Allow all egress' }],
          Tags: [{ Key: 'Name', Value: logicalId }],
        },
      }]];
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const defaultAction = (props.defaultAction as string) ?? 'allow';
      return [[logicalId, {
        Type: 'AWS::WAFv2::WebACL',
        Properties: {
          Name: logicalId,
          Scope: (props.scope as string) ?? 'REGIONAL',
          DefaultAction: { [defaultAction === 'block' ? 'Block' : 'Allow']: {} },
          Description: (props.description as string) ?? `WAF ${logicalId}`,
          Rules: rules.map((r, i) => ({
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
          })),
          VisibilityConfig: {
            SampledRequestsEnabled: true,
            CloudWatchMetricsEnabled: true,
            MetricName: logicalId,
          },
        },
      }]];
    }

    case 'Network.LoadBalancer': {
      const lbType = (props.type as string) ?? 'application';
      const listeners = (props.listeners as Array<Record<string, unknown>>) ?? [];
      const targetGroups = (props.targetGroups as Array<Record<string, unknown>>) ?? [];

      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        Properties: {
          Name: construct.id,
          Type: lbType,
          Scheme: (props.scheme as string) ?? 'internet-facing',
          Subnets: (props.subnetIds as string[]) ?? [],
          ...(lbType === 'application' && props.securityGroupIds
            ? { SecurityGroups: props.securityGroupIds }
            : {}),
          LoadBalancerAttributes: [
            { Key: 'deletion_protection.enabled', Value: String(props.deletionProtection ?? false) },
          ],
        },
      }]];

      for (const tg of targetGroups) {
        const tgId = `${logicalId}TG${(tg.name as string).replace(/[^a-zA-Z0-9]/g, '')}`;
        entries.push([tgId, {
          Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          Properties: {
            Name: tg.name as string,
            Port: tg.port as number,
            Protocol: tg.protocol as string,
            VpcId: '',
            HealthCheckPath: (tg.healthCheckPath as string) ?? '/',
            HealthCheckPort: String(tg.healthCheckPort ?? tg.port),
            TargetType: 'ip',
          },
        }]);
      }

      for (let i = 0; i < listeners.length; i++) {
        const l = listeners[i];
        entries.push([`${logicalId}Listener${i + 1}`, {
          Type: 'AWS::ElasticLoadBalancingV2::Listener',
          Properties: {
            LoadBalancerArn: { Ref: logicalId },
            Port: l.port as number,
            Protocol: l.protocol as string,
            ...(l.certificateArn ? { Certificates: [{ CertificateArn: l.certificateArn }] } : {}),
            DefaultActions: (l.redirectToHttps as boolean)
              ? [{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } }]
              : [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404', MessageBody: 'Not found', ContentType: 'text/plain' } }],
          },
        }]);
      }

      return entries;
    }

    case 'Network.CDN': {
      const origins = (props.origins as Array<Record<string, unknown>>) ?? [];
      const cachePolicies = (props.cachePolicies as Array<Record<string, unknown>>) ?? [];

      return [[logicalId, {
        Type: 'AWS::CloudFront::Distribution',
        Properties: {
          DistributionConfig: {
            Enabled: true,
            HttpVersion: (props.httpVersion as string) ?? 'http2',
            PriceClass: (props.priceClass as string) ?? 'PriceClass_100',
            DefaultRootObject: (props.defaultRootObject as string) ?? 'index.html',
            ...(props.aliases ? { Aliases: props.aliases } : {}),
            ...(props.certificateArn
              ? { ViewerCertificate: { AcmCertificateArn: props.certificateArn, SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' } }
              : { ViewerCertificate: { CloudFrontDefaultCertificate: true } }),
            ...(props.wafAclId ? { WebACLId: props.wafAclId } : {}),
            Origins: origins.map(o => ({
              Id: o.id as string,
              DomainName: o.domainName as string,
              OriginPath: (o.path as string) ?? '',
              CustomOriginConfig: { HTTPSPort: 443, OriginProtocolPolicy: (o.protocol as string) ?? 'https-only' },
            })),
            DefaultCacheBehavior: {
              TargetOriginId: origins[0].id as string,
              ViewerProtocolPolicy: 'redirect-to-https',
              AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
              CachedMethods: ['GET', 'HEAD'],
              Compress: true,
              ForwardedValues: { QueryString: false, Cookies: { Forward: 'none' } },
            },
            CacheBehaviors: cachePolicies.map(cp => ({
              PathPattern: cp.pathPattern as string,
              TargetOriginId: origins[0].id as string,
              ViewerProtocolPolicy: 'redirect-to-https',
              DefaultTTL: cp.ttlSeconds ?? 86400,
              MaxTTL: (cp.ttlSeconds as number ?? 86400) * 2,
              Compress: (cp.compress as boolean) ?? true,
              ForwardedValues: { QueryString: true, Cookies: { Forward: 'all' } },
              AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
              CachedMethods: ['GET', 'HEAD'],
            })),
          },
        },
      }]];
    }

    case 'Network.Dns': {
      const records = (props.records as Array<Record<string, unknown>>) ?? [];
      const hostedZoneId = `${logicalId}Zone`;

      const entries: Array<[string, CloudFormationResource]> = [[hostedZoneId, {
        Type: 'AWS::Route53::HostedZone',
        Properties: {
          Name: props.zoneName as string,
          HostedZoneConfig: { Comment: `Zone for ${props.zoneName}` },
        },
      }]];

      for (const r of records) {
        const recId = `${logicalId}${(r.name as string).replace(/[^a-zA-Z0-9]/g, '')}${r.type}`;
        entries.push([recId, {
          Type: 'AWS::Route53::RecordSet',
          Properties: {
            HostedZoneId: { Ref: hostedZoneId },
            Name: r.name as string,
            Type: r.type as string,
            TTL: String(r.ttl ?? 300),
            ...(r.aliasTarget
              ? { AliasTarget: { DNSName: r.aliasTarget, HostedZoneId: 'Z35SXDOTRQ7X7K' } }
              : { ResourceRecords: r.values as string[] }),
          },
        }]);
      }

      return entries;
    }

    // ── Database ──────────────────────────────────────────────────────────
    case 'Database.SQL': {
      const engine = props.engine as string;
      const edition = (props.edition as string) ?? '';

      // Mapeia engine → Engine + EngineVersion do RDS
      const engineMap: Record<string, { Engine: string; EngineVersion: string }> = {
        mysql:     { Engine: 'mysql',                                    EngineVersion: '8.0.36' },
        postgres:  { Engine: 'postgres',                                 EngineVersion: '15.4' },
        mariadb:   { Engine: 'mariadb',                                  EngineVersion: '10.11.6' },
        oracle:    { Engine: `oracle-${edition || 'se2'}`,               EngineVersion: '19.0.0.0.ru-2024-01.rur-2024-01.r1' },
        sqlserver: { Engine: `sqlserver-${edition || 'ex'}`,             EngineVersion: '15.00.4365.2.v1' },
      };
      const mapped = engineMap[engine] ?? engineMap['mysql'];

      const isOracle    = engine === 'oracle';
      const isSqlServer = engine === 'sqlserver';
      const licenseModel = (props.licenseModel as string)
        ?? (isOracle || isSqlServer ? 'license-included' : undefined);

      // SQL Server com licença incluída não suporta MasterUsername customizado
      const masterUser = isSqlServer ? 'sqladmin' : 'dbadmin';

      // Oracle e SQL Server exigem instâncias maiores (mínimo db.t3.small)
      const defaultInstance = (isOracle || isSqlServer) ? 'db.t3.small' : 'db.t3.micro';

      const rdsProps: Record<string, unknown> = {
        DBInstanceClass:       (props.instanceType as string) ?? defaultInstance,
        Engine:                mapped.Engine,
        EngineVersion:         mapped.EngineVersion,
        AllocatedStorage:      String(props.storageGb ?? 20),
        MultiAZ:               (props.multiAz as boolean) ?? false,
        MasterUsername:        masterUser,
        MasterUserPassword:    { 'Fn::Sub': '{{resolve:ssm:/iacmp/${AWS::StackName}/db-password}}' },
        StorageEncrypted:      true,
        BackupRetentionPeriod: props.backupRetentionDays ?? 7,
        DeletionProtection:    (props.deletionProtection as boolean) ?? false,
      };
      if (licenseModel) rdsProps['LicenseModel'] = licenseModel;

      return [[logicalId, {
        Type: 'AWS::RDS::DBInstance',
        DeletionPolicy: (props.deletionProtection as boolean) ? 'Retain' : 'Snapshot',
        Properties: rdsProps,
      }]];
    }

    case 'Database.DocumentDB': {
      const instances = (props.instances as number) ?? 1;
      const clusterLogicalId = `${logicalId}Cluster`;
      const entries: Array<[string, CloudFormationResource]> = [[clusterLogicalId, {
        Type: 'AWS::DocDB::DBCluster',
        DeletionPolicy: (props.deletionProtection as boolean) ? 'Retain' : 'Snapshot',
        Properties: {
          DBClusterIdentifier: construct.id.toLowerCase(),
          MasterUsername: 'docdbadmin',
          MasterUserPassword: { 'Fn::Sub': '{{resolve:ssm:/iacmp/${AWS::StackName}/docdb-password}}' },
          StorageEncrypted: true,
          BackupRetentionPeriod: 7,
          DeletionProtection: (props.deletionProtection as boolean) ?? false,
        },
      }]];
      for (let i = 0; i < instances; i++) {
        entries.push([`${logicalId}Instance${i + 1}`, {
          Type: 'AWS::DocDB::DBInstance',
          Properties: {
            DBClusterIdentifier: { Ref: clusterLogicalId },
            DBInstanceClass: (props.instanceType as string) ?? 'db.t3.medium',
            DBInstanceIdentifier: `${construct.id.toLowerCase()}-${i + 1}`,
          },
        }]);
      }
      return entries;
    }

    case 'Database.DynamoDB': {
      const billingMode = (props.billingMode as string) ?? 'PAY_PER_REQUEST';
      const gsis = (props.globalSecondaryIndexes as Array<Record<string, unknown>>) ?? [];
      const attrDefs = [
        { AttributeName: props.partitionKey as string, AttributeType: 'S' },
        ...(props.sortKey ? [{ AttributeName: props.sortKey as string, AttributeType: 'S' }] : []),
        ...gsis.map(g => ({ AttributeName: g.partitionKey as string, AttributeType: 'S' })),
        ...gsis.filter(g => g.sortKey).map(g => ({ AttributeName: g.sortKey as string, AttributeType: 'S' })),
      ].filter((v, i, a) => a.findIndex(x => x.AttributeName === v.AttributeName) === i);

      return [[logicalId, {
        Type: 'AWS::DynamoDB::Table',
        DeletionPolicy: 'Retain',
        Properties: {
          TableName: construct.id,
          BillingMode: billingMode,
          ...(billingMode === 'PROVISIONED' ? {
            ProvisionedThroughput: { ReadCapacityUnits: props.readCapacity ?? 5, WriteCapacityUnits: props.writeCapacity ?? 5 },
          } : {}),
          AttributeDefinitions: attrDefs,
          KeySchema: [
            { AttributeName: props.partitionKey as string, KeyType: 'HASH' },
            ...(props.sortKey ? [{ AttributeName: props.sortKey as string, KeyType: 'RANGE' }] : []),
          ],
          ...(gsis.length > 0 ? {
            GlobalSecondaryIndexes: gsis.map(g => ({
              IndexName: g.name as string,
              KeySchema: [
                { AttributeName: g.partitionKey as string, KeyType: 'HASH' },
                ...(g.sortKey ? [{ AttributeName: g.sortKey as string, KeyType: 'RANGE' }] : []),
              ],
              Projection: { ProjectionType: 'ALL' },
              ...(billingMode === 'PROVISIONED' ? {
                ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
              } : {}),
            })),
          } : {}),
          ...(props.ttlAttribute ? { TimeToLiveSpecification: { AttributeName: props.ttlAttribute, Enabled: true } } : {}),
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: (props.pointInTimeRecovery as boolean) ?? true },
          ...(props.streamEnabled ? { StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' } } : {}),
        },
      }]];
    }

    // ── Cache ─────────────────────────────────────────────────────────────
    case 'Cache.Redis': {
      const numNodes = (props.numCacheNodes as number) ?? 1;
      const autoFailover = (props.automaticFailoverEnabled as boolean) ?? false;
      return [[logicalId, {
        Type: 'AWS::ElastiCache::ReplicationGroup',
        Properties: {
          ReplicationGroupDescription: `Redis ${construct.id}`,
          ReplicationGroupId: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
          CacheNodeType: CACHE_NODE_TYPE_MAP[(props.nodeType as string) ?? 'small'] ?? 'cache.t3.micro',
          Engine: 'redis',
          EngineVersion: (props.version as string) ?? '7.0',
          NumCacheClusters: numNodes,
          AutomaticFailoverEnabled: autoFailover && numNodes > 1,
          AtRestEncryptionEnabled: (props.atRestEncryptionEnabled as boolean) ?? true,
          TransitEncryptionEnabled: (props.transitEncryptionEnabled as boolean) ?? true,
          ...(props.subnetGroupName ? { CacheSubnetGroupName: props.subnetGroupName } : {}),
          ...(props.securityGroupIds ? { SecurityGroupIds: props.securityGroupIds } : {}),
        },
      }]];
    }

    case 'Cache.Memcached': {
      return [[logicalId, {
        Type: 'AWS::ElastiCache::CacheCluster',
        Properties: {
          ClusterName: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
          Engine: 'memcached',
          CacheNodeType: CACHE_NODE_TYPE_MAP[(props.nodeType as string) ?? 'small'] ?? 'cache.t3.micro',
          NumCacheNodes: (props.numCacheNodes as number) ?? 2,
          ...(props.subnetGroupName ? { CacheSubnetGroupName: props.subnetGroupName } : {}),
        },
      }]];
    }

    // ── Function ──────────────────────────────────────────────────────────
    case 'Function.Lambda': {
      const environment = props.environment as Record<string, string> | undefined;
      const runtimeMap: Record<string, string> = {
        'nodejs20': 'nodejs20.x', 'nodejs18': 'nodejs18.x',
        'python3.12': 'python3.12', 'python3.11': 'python3.11',
        'java21': 'java21', 'go1.x': 'go1.x', 'dotnet8': 'dotnet8',
      };
      return [[logicalId, {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: construct.id,
          Runtime: runtimeMap[(props.runtime as string) ?? 'nodejs20'] ?? 'nodejs20.x',
          Handler: props.handler as string,
          Code: { ZipFile: props.code as string },
          MemorySize: (props.memory as number) ?? 128,
          Timeout: (props.timeout as number) ?? 30,
          Role: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/LambdaExecutionRole' },
          ...(props.reservedConcurrency !== undefined ? { ReservedConcurrentExecutions: props.reservedConcurrency } : {}),
          ...(environment && Object.keys(environment).length > 0 ? { Environment: { Variables: environment } } : {}),
          ...(props.vpcId ? {
            VpcConfig: {
              SubnetIds: (props.subnetIds as string[]) ?? [],
              SecurityGroupIds: (props.securityGroupIds as string[]) ?? [],
            },
          } : {}),
        },
      }]];
    }

    case 'Function.ApiGateway': {
      const apigwType = (props.type as string) ?? 'HTTP';
      const routes = (props.routes as Array<Record<string, unknown>>) ?? [];
      const stageName = (props.stageName as string) ?? '$default';

      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: apigwType === 'REST' ? 'AWS::ApiGateway::RestApi' : 'AWS::ApiGatewayV2::Api',
        Properties: {
          Name: props.name as string,
          Description: (props.description as string) ?? '',
          ...(apigwType !== 'REST' ? { ProtocolType: apigwType } : {}),
          ...(props.cors ? { CorsConfiguration: { AllowOrigins: ['*'], AllowMethods: ['*'], AllowHeaders: ['*'] } } : {}),
        },
      }]];

      entries.push([`${logicalId}Stage`, {
        Type: apigwType === 'REST' ? 'AWS::ApiGateway::Stage' : 'AWS::ApiGatewayV2::Stage',
        Properties: {
          ...(apigwType === 'REST' ? { RestApiId: { Ref: logicalId } } : { ApiId: { Ref: logicalId } }),
          StageName: stageName,
          AutoDeploy: apigwType !== 'REST',
          ...(props.throttlingBurstLimit ? {
            DefaultRouteSettings: {
              ThrottlingBurstLimit: props.throttlingBurstLimit,
              ThrottlingRateLimit: props.throttlingRateLimit ?? 1000,
            },
          } : {}),
        },
      }]);

      for (const r of routes) {
        const routeId = `${logicalId}${(r.method as string)}${(r.path as string).replace(/[^a-zA-Z0-9]/g, '')}Route`;
        entries.push([routeId, {
          Type: 'AWS::ApiGatewayV2::Route',
          Properties: {
            ApiId: { Ref: logicalId },
            RouteKey: `${r.method} ${r.path}`,
            ...(r.lambdaId ? { Target: { 'Fn::Sub': `integrations/\${${routeId}Integration}` } } : {}),
          },
        }]);

        if (r.lambdaId) {
          entries.push([`${routeId}Integration`, {
            Type: 'AWS::ApiGatewayV2::Integration',
            Properties: {
              ApiId: { Ref: logicalId },
              IntegrationType: 'AWS_PROXY',
              IntegrationUri: { 'Fn::Sub': `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${${r.lambdaId as string}.Arn}/invocations` },
              PayloadFormatVersion: '2.0',
            },
          }]);
        }
      }

      return entries;
    }

    // ── Policy ────────────────────────────────────────────────────────────
    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachType = props.attachType as string;
      const attachTo = (props.attachTo as string).replace(/[^a-zA-Z0-9]/g, '');
      const principalService = attachType === 'lambda' ? 'lambda.amazonaws.com' : 'ec2.amazonaws.com';
      const managedPolicies: string[] = attachType === 'lambda'
        ? ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
        : attachType === 'compute'
        ? ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore']
        : [];

      const roleLogicalId = `${logicalId}Role`;
      const roleResource: CloudFormationResource = {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { 'Fn::Sub': `${attachTo}-role-\${AWS::StackName}` },
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: principalService }, Action: 'sts:AssumeRole' }],
          },
          ManagedPolicyArns: managedPolicies,
          Policies: [{
            PolicyName: logicalId,
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: statements.map(s => ({
                Effect: s.effect as string,
                Action: s.actions as string[],
                Resource: (s.resources as string[]) ?? ['*'],
                ...(s.conditions ? { Condition: s.conditions } : {}),
              })),
            },
          }],
          Tags: [{ Key: 'Name', Value: roleLogicalId }],
        },
      };

      if (attachType === 'compute') {
        return [[roleLogicalId, roleResource], [`${logicalId}InstanceProfile`, {
          Type: 'AWS::IAM::InstanceProfile',
          Properties: {
            InstanceProfileName: { 'Fn::Sub': `${attachTo}-profile-\${AWS::StackName}` },
            Roles: [{ Ref: roleLogicalId }],
          },
        }]];
      }

      return [[roleLogicalId, roleResource]];
    }

    // ── Events ────────────────────────────────────────────────────────────
    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const busName = (props.busName as string) ?? 'default';
      const entries: Array<[string, CloudFormationResource]> = [];

      if (busName !== 'default') {
        entries.push([`${logicalId}Bus`, { Type: 'AWS::Events::EventBus', Properties: { Name: busName } }]);
      }

      for (const r of rules) {
        const ruleName = ((r.name as string) ?? 'rule').replace(/[^a-zA-Z0-9]/g, '');
        const pattern: Record<string, unknown> = {};
        if (r.source) pattern['source'] = r.source;
        if (r.detailTypes) pattern['detail-type'] = r.detailTypes;

        entries.push([`${logicalId}${ruleName}Rule`, {
          Type: 'AWS::Events::Rule',
          Properties: {
            Name: r.name as string,
            EventBusName: busName,
            EventPattern: pattern,
            State: 'ENABLED',
            ...(r.targetArn ? { Targets: [{ Id: `${ruleName}Target`, Arn: r.targetArn as string }] } : {}),
          },
        }]);
      }

      return entries;
    }

    // ── Workflow ──────────────────────────────────────────────────────────
    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const definition = {
        Comment: (props.description as string) ?? `Workflow ${construct.id}`,
        StartAt: (steps[0]?.name as string) ?? 'Start',
        States: Object.fromEntries(steps.map((s, i) => [s.name as string, {
          Type: (s.type as string) ?? 'Task',
          Resource: (s.resource as string) ?? '',
          ...(s.description ? { Comment: s.description } : {}),
          ...(i < steps.length - 1 ? { Next: steps[i + 1].name as string } : { End: true }),
        }])),
      };
      return [[logicalId, {
        Type: 'AWS::StepFunctions::StateMachine',
        Properties: {
          StateMachineName: construct.id,
          StateMachineType: (props.type as string) ?? 'STANDARD',
          DefinitionString: { 'Fn::Sub': JSON.stringify(definition) },
          RoleArn: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/StepFunctionsExecutionRole' },
          LoggingConfiguration: { Level: 'ERROR', IncludeExecutionData: false },
        },
      }]];
    }

    // ── Messaging ─────────────────────────────────────────────────────────
    case 'Messaging.Queue': {
      const fifo = (props.fifo as boolean) ?? false;
      return [[logicalId, {
        Type: 'AWS::SQS::Queue',
        Properties: {
          QueueName: fifo ? `${construct.id}.fifo` : construct.id,
          VisibilityTimeout: (props.visibilityTimeoutSeconds as number) ?? 30,
          MessageRetentionPeriod: (props.messageRetentionSeconds as number) ?? 345600,
          DelaySeconds: (props.delaySeconds as number) ?? 0,
          FifoQueue: fifo,
          SqsManagedSseEnabled: (props.encrypted as boolean) ?? true,
          ...(props.dlqArn ? { RedrivePolicy: { deadLetterTargetArn: props.dlqArn as string, maxReceiveCount: (props.maxReceiveCount as number) ?? 3 } } : {}),
        },
      }]];
    }

    case 'Messaging.Topic': {
      const fifo = (props.fifo as boolean) ?? false;
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];
      return [[logicalId, {
        Type: 'AWS::SNS::Topic',
        Properties: {
          TopicName: fifo ? `${construct.id}.fifo` : construct.id,
          DisplayName: (props.displayName as string) ?? construct.id,
          FifoTopic: fifo,
          ...(props.encrypted ? { KmsMasterKeyId: 'alias/aws/sns' } : {}),
          Subscription: subscriptions.map(s => ({ Protocol: s.protocol, Endpoint: s.endpoint })),
        },
      }]];
    }

    // ── Secret / Certificate ──────────────────────────────────────────────
    case 'Secret.Vault': {
      return [[logicalId, {
        Type: 'AWS::SecretsManager::Secret',
        Properties: {
          Name: construct.id,
          Description: (props.description as string) ?? `Secret ${construct.id}`,
          ...(props.kmsKeyId ? { KmsKeyId: props.kmsKeyId } : {}),
          ...(props.replicaRegions ? { ReplicaRegions: (props.replicaRegions as string[]).map(r => ({ Region: r })) } : {}),
        },
      }]];
    }

    case 'Certificate.TLS': {
      const sans = (props.subjectAlternativeNames as string[]) ?? [];
      return [[logicalId, {
        Type: 'AWS::CertificateManager::Certificate',
        Properties: {
          DomainName: props.domainName as string,
          ValidationMethod: (props.validationMethod as string) ?? 'DNS',
          ...(sans.length > 0 ? { SubjectAlternativeNames: sans } : {}),
          Tags: [{ Key: 'Name', Value: construct.id }],
        },
      }]];
    }

    // ── Monitoring ────────────────────────────────────────────────────────
    case 'Monitoring.Alarm': {
      const dimensions = props.dimensions as Record<string, string> | undefined;
      return [[logicalId, {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          AlarmName: construct.id,
          MetricName: props.metricName as string,
          Namespace: (props.namespace as string) ?? 'AWS/Lambda',
          Threshold: props.threshold as number,
          EvaluationPeriods: (props.evaluationPeriods as number) ?? 2,
          Period: (props.periodSeconds as number) ?? 60,
          ComparisonOperator: (props.comparisonOperator as string) ?? 'GreaterThanThreshold',
          Statistic: (props.statistic as string) ?? 'Average',
          TreatMissingData: (props.treatMissingData as string) ?? 'notBreaching',
          ...(props.alarmActions ? { AlarmActions: props.alarmActions } : {}),
          ...(props.okActions ? { OKActions: props.okActions } : {}),
          ...(dimensions ? { Dimensions: Object.entries(dimensions).map(([k, v]) => ({ Name: k, Value: v })) } : {}),
        },
      }]];
    }

    case 'Monitoring.Dashboard': {
      const widgets = (props.widgets as Array<Record<string, unknown>>) ?? [];
      const dashBody = {
        widgets: widgets.map((w, i) => ({
          type: w.type === 'text' ? 'text' : 'metric',
          x: (i % 3) * 8,
          y: Math.floor(i / 3) * 6,
          width: 8,
          height: 6,
          properties: w.type === 'text'
            ? { markdown: w.markdown ?? w.title }
            : {
                title: w.title as string,
                metrics: [[
                  (w.namespace as string) ?? 'AWS/Lambda',
                  w.metricName as string,
                  ...(w.dimensions ? Object.entries(w.dimensions as Record<string, string>).flat() : []),
                ]],
                period: (w.period as number) ?? 60,
                stat: (w.stat as string) ?? 'Average',
                view: 'timeSeries',
              },
        })),
      };
      return [[logicalId, {
        Type: 'AWS::CloudWatch::Dashboard',
        Properties: {
          DashboardName: construct.id,
          DashboardBody: JSON.stringify(dashBody),
        },
      }]];
    }

    case 'Logging.Stream': {
      const filters = (props.subscriptionFilters as Array<Record<string, unknown>>) ?? [];
      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::Logs::LogGroup',
        Properties: {
          LogGroupName: `/iacmp/${construct.id}`,
          RetentionInDays: (props.retentionDays as number) ?? 30,
          ...(props.kmsKeyId ? { KmsKeyId: props.kmsKeyId } : {}),
        },
      }]];
      for (const f of filters) {
        entries.push([`${logicalId}${(f.name as string).replace(/[^a-zA-Z0-9]/g, '')}Filter`, {
          Type: 'AWS::Logs::SubscriptionFilter',
          Properties: {
            LogGroupName: { Ref: logicalId },
            FilterName: f.name as string,
            FilterPattern: f.filterPattern as string,
            DestinationArn: f.destinationArn as string,
          },
        }]);
      }
      return entries;
    }

    default:
      return [];
  }
}

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
      const p = construct.props as Record<string, unknown>;
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      synthesizeVPCChildren(logicalId, (p.cidr as string) ?? '10.0.0.0/16', (p.maxAzs as number) ?? 0, resources);
    }
  }

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Stack ${stack.name} — gerada pelo iacmp`,
    Resources: resources,
  };
}
