import {
  Stack,
  BaseConstruct,
  validateSemantics,
  applyEnvironmentDefaults,
  EnvironmentProfile,
  DEFAULT_PROFILE,
  databaseDefaultsForTier,
} from '@iacmp/core';

export interface CloudFormationResource {
  Type: string;
  DeletionPolicy?: string;
  DependsOn?: string[];
  Properties: Record<string, unknown>;
}

export interface CloudFormationTemplate {
  AWSTemplateFormatVersion: string;
  Description: string;
  Resources: Record<string, CloudFormationResource>;
  Outputs?: Record<string, { Value: unknown; Export: { Name: string } }>;
}

/**
 * Contexto opcional com visão de TODAS as stacks do projeto (não só a atual)
 * — usado por Function.ApiGateway pra resolver referências a Function.Lambda
 * que vivem em outra stack/template (Fn::ImportValue) em vez de assumir que
 * estão sempre na mesma stack (Fn::Sub local, que é o que CloudFormation
 * aceita só quando o recurso está no MESMO template).
 */
export interface SynthContext {
  currentStackName: string;
  /** constructId (ex: 'SaveMessageFn') → nome da Stack que o declara. */
  registry: Map<string, string>;
  /**
   * lambdaId (id de uma Function.Lambda) → role IAM criada por um Policy.IAM
   * (attachType: 'lambda', attachTo: lambdaId) que a referencia, se existir.
   */
  lambdaRoles: Map<string, { stackName: string; roleLogicalId: string }>;
  /** constructId de Database → sufixo do nome do secret (ex: 'AppDB' → 'db-password' ou 'aurora-password'). */
  dbSecretSuffix: Map<string, string>;
  /** IDs de Secret.Vault — o próprio logicalId É o secret (Ref retorna o ARN). */
  secretVaults: Set<string>;
  /** IDs de Function.Lambda que têm vpcId definido — precisam de VPCAccessExecutionRole. */
  vpcLambdas: Set<string>;
  /** Perfil de ambiente (tier da conta, região) — fonte dos defaults derivados. */
  profile: EnvironmentProfile;
}

/**
 * Resolve a referência ao ARN de uma Function.Lambda como valor standalone
 * (ex: Lambda Permission's FunctionName) — local usa Fn::GetAtt, cross-stack
 * usa Fn::ImportValue.
 */
function resolveLambdaArnRef(lambdaId: string, ctx: SynthContext): unknown {
  const ownerStack = ctx.registry.get(lambdaId);
  if (!ownerStack) {
    throw new Error(`Lambda "${lambdaId}" referenciada em Function.ApiGateway não foi encontrada em nenhuma stack do projeto.`);
  }
  if (ownerStack === ctx.currentStackName) return { 'Fn::GetAtt': [lambdaId, 'Arn'] };
  return { 'Fn::ImportValue': `${ownerStack}-${lambdaId}-Arn` };
}

/**
 * Monta o `Fn::Sub` da URI de invocação do API Gateway pra uma Lambda (mesmo
 * formato usado por REST v1 e HTTP/v2). Local embute `${lambdaId.Arn}` direto
 * na string (válido só quando o recurso está no mesmo template); cross-stack
 * usa a forma de Fn::Sub com mapa de substituição, injetando um
 * Fn::ImportValue no lugar do atributo local.
 */
function buildInvocationUri(lambdaId: string, ctx: SynthContext): unknown {
  const template = 'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${LambdaArn}/invocations';
  const ownerStack = ctx.registry.get(lambdaId);
  if (!ownerStack) {
    throw new Error(`Lambda "${lambdaId}" referenciada em Function.ApiGateway não foi encontrada em nenhuma stack do projeto.`);
  }
  if (ownerStack === ctx.currentStackName) {
    return { 'Fn::Sub': `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${${lambdaId}.Arn}/invocations` };
  }
  return { 'Fn::Sub': [template, { LambdaArn: { 'Fn::ImportValue': `${ownerStack}-${lambdaId}-Arn` } }] };
}

/**
 * Resolve a Role IAM de uma Function.Lambda. Se existir um Policy.IAM
 * (attachType: 'lambda') apontando pra essa lambda, referencia a role que ele
 * cria (local → Fn::GetAtt, cross-stack → Fn::ImportValue do RoleArn que o
 * Policy.IAM exporta). Sem isso, NENHUMA role seria assumível pela função —
 * antes desta correção o código gerava uma referência fixa a uma role
 * `LambdaExecutionRole` que o iacmp nunca cria, e o deploy falhava com "The
 * role defined for the function cannot be assumed by Lambda." Sem Policy.IAM
 * correspondente, gera uma role mínima padrão (só CloudWatch Logs) inline,
 * pra a Lambda sempre ser deployável.
 */
function resolveLambdaRole(
  lambdaId: string,
  lambdaLogicalId: string,
  ctx: SynthContext,
  isVpc = false,
): { roleRef: unknown; extraResource?: [string, CloudFormationResource] } {
  const owned = ctx.lambdaRoles.get(lambdaId);
  if (owned) {
    if (owned.stackName === ctx.currentStackName) {
      return { roleRef: { 'Fn::GetAtt': [owned.roleLogicalId, 'Arn'] } };
    }
    return { roleRef: { 'Fn::ImportValue': `${owned.stackName}-${owned.roleLogicalId}-RoleArn` } };
  }

  const defaultRoleLogicalId = `${lambdaLogicalId}DefaultRole`;
  const managedPolicies = isVpc
    ? ['arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole']
    : ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'];
  return {
    roleRef: { 'Fn::GetAtt': [defaultRoleLogicalId, 'Arn'] },
    extraResource: [defaultRoleLogicalId, {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
        },
        ManagedPolicyArns: managedPolicies,
      },
    }],
  };
}

/**
 * Role default mínima pra um serviço (EKS cluster/node, ECS task execution,
 * StepFunctions) que precisa assumir um role mas não tem (ainda) um
 * `Policy.IAM` apontando pra ele — mesmo padrão do fallback de
 * `resolveLambdaRole` acima. Sem isso, o synth gerava `Fn::Sub` apontando pra
 * um nome de role (ex: `EKSClusterRole`) que o iacmp nunca cria de verdade, e
 * o deploy falhava ("role does not exist" / "cannot be assumed").
 */
function defaultServiceRole(
  roleLogicalId: string,
  servicePrincipal: string,
  managedPolicyArns: string[],
  inlinePolicy?: { name: string; statements: Array<{ Effect: string; Action: string[]; Resource: string | string[] }> },
): [string, CloudFormationResource] {
  return [roleLogicalId, {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: servicePrincipal }, Action: 'sts:AssumeRole' }],
      },
      ...(managedPolicyArns.length > 0 ? { ManagedPolicyArns: managedPolicyArns } : {}),
      ...(inlinePolicy ? {
        Policies: [{
          PolicyName: inlinePolicy.name,
          PolicyDocument: { Version: '2012-10-17', Statement: inlinePolicy.statements },
        }],
      } : {}),
    },
  }];
}

function resolveVpcId(id: string, ctx: SynthContext): unknown {
  if (/^vpc-[0-9a-z]+$/.test(id)) return id;
  const ownerStack = ctx.registry.get(id);
  if (!ownerStack) return id;
  const logicalId = id.replace(/[^a-zA-Z0-9]/g, '');
  if (ownerStack === ctx.currentStackName) return { Ref: logicalId };
  return { 'Fn::ImportValue': `${ownerStack}-${id}-VpcId` };
}

function resolveSubnetId(id: string, ctx: SynthContext): unknown {
  if (/^subnet-[0-9a-z]+$/.test(id)) return id;
  const ownerStack = ctx.registry.get(id);
  if (!ownerStack) return id;
  const logicalId = id.replace(/[^a-zA-Z0-9]/g, '');
  if (ownerStack === ctx.currentStackName) return { Ref: logicalId };
  return { 'Fn::ImportValue': `${ownerStack}-${id}-SubnetId` };
}

function resolveSecurityGroupId(id: string, ctx: SynthContext): unknown {
  if (/^sg-[0-9a-zA-Z]+$/.test(id)) return id;
  const ownerStack = ctx.registry.get(id);
  if (!ownerStack) return id;
  const logicalId = id.replace(/[^a-zA-Z0-9]/g, '');
  if (ownerStack === ctx.currentStackName) return { 'Fn::GetAtt': [logicalId, 'GroupId'] };
  return { 'Fn::ImportValue': `${ownerStack}-${id}-GroupId` };
}

/**
 * Resolve env var values que referenciam outputs de outros constructs.
 * Padrão: "<constructId>.<field>" onde field = Endpoint | Port | SecretArn | Username
 * Mesmo stack → Fn::GetAtt / Ref. Cross-stack → Fn::ImportValue.
 */
/**
 * Resolve um item de `resources` numa Policy.IAM. Aceita o mesmo padrão
 * "<constructId>.SecretArn"/".Arn" das env vars (ex: 'JwtSecret.SecretArn') →
 * referência real ao recurso. ARNs literais, '*' e qualquer outra string passam
 * inalterados.
 */
function resolvePolicyResource(value: string, ctx: SynthContext): unknown {
  const match = /^([^.]+)\.(SecretArn|Arn)$/.exec(value);
  if (!match) return value;
  const [, constructId] = match;
  if (!ctx.registry.has(constructId)) return value;
  // Reusa a resolução de env var (Ref/ImportValue conforme local vs cross-stack).
  return resolveEnvVarValue(`${constructId}.SecretArn`, ctx);
}

function resolveEnvVarValue(value: string, ctx: SynthContext): unknown {
  const match = /^([^.]+)\.(Endpoint|Port|SecretArn|Username|Password)$/.exec(value);
  if (!match) return value;
  const [, constructId, field] = match;
  const ownerStack = ctx.registry.get(constructId);
  if (!ownerStack) return value;
  const logicalId = constructId.replace(/[^a-zA-Z0-9]/g, '');

  // Secret.Vault standalone: o próprio recurso É o secret — Ref retorna o ARN.
  // (Database tem um sub-recurso `${logicalId}Secret`; Vault não.)
  if (field === 'SecretArn' && ctx.secretVaults.has(constructId)) {
    if (ownerStack === ctx.currentStackName) return { Ref: logicalId };
    return { 'Fn::ImportValue': `${ownerStack}-${constructId}-SecretArn` };
  }

  // Password: CloudFormation dynamic reference — resolvido em deploy time (sem SDK runtime)
  if (field === 'Password') {
    const suffix = ctx.dbSecretSuffix.get(constructId) ?? 'db-password';
    return `{{resolve:secretsmanager:${ownerStack}-${constructId}-${suffix}:SecretString:password}}`;
  }

  if (ownerStack === ctx.currentStackName) {
    if (field === 'Endpoint') return { 'Fn::GetAtt': [logicalId, 'Endpoint.Address'] };
    if (field === 'Port') return { 'Fn::GetAtt': [logicalId, 'Endpoint.Port'] };
    if (field === 'SecretArn') return { Ref: `${logicalId}Secret` };
    if (field === 'Username') return value; // username é estático (dbadmin), retorna as-is
    return value;
  }
  return { 'Fn::ImportValue': `${ownerStack}-${constructId}-${field}` };
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
  'windows-2022': '{{resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base}}',
  'windows-2019': '{{resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2019-English-Full-Base}}',
  'windows-2016': '{{resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2016-English-Full-Base}}',
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

function synthesizeConstruct(construct: BaseConstruct, ctx: SynthContext): Array<[string, CloudFormationResource]> {
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
          ...(props.subnetId ? { SubnetId: resolveSubnetId(props.subnetId as string, ctx) } : {}),
          ...(props.securityGroupIds ? { SecurityGroupIds: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
        },
      }]];

    case 'Compute.AutoScaling': {
      const ltId = `${logicalId}LT`;
      const asgId = `${logicalId}ASG`;
      const spId = `${logicalId}ScalingPolicy`;

      const lt: CloudFormationResource = {
        Type: 'AWS::EC2::LaunchTemplate',
        Properties: {
          LaunchTemplateName: `${logicalId}-lt`,
          LaunchTemplateData: {
            ImageId: AMI_MAP[props.image as string] ?? (props.image as string),
            InstanceType: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 't3.small',
            ...(props.securityGroupIds ? { SecurityGroupIds: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
          },
        },
      };

      const asg: CloudFormationResource = {
        Type: 'AWS::AutoScaling::AutoScalingGroup',
        Properties: {
          LaunchTemplate: {
            LaunchTemplateId: { Ref: ltId },
            Version: { 'Fn::GetAtt': [ltId, 'LatestVersionNumber'] },
          },
          MinSize: String(props.minCapacity ?? 1),
          MaxSize: String(props.maxCapacity ?? 3),
          DesiredCapacity: String(props.desiredCapacity ?? props.minCapacity ?? 1),
          ...(props.subnetIds
            ? { VPCZoneIdentifier: (props.subnetIds as string[]).map(id => resolveSubnetId(id, ctx)) }
            : { AvailabilityZones: { 'Fn::GetAZs': '' } }),
          Tags: [{ Key: 'Name', Value: logicalId, PropagateAtLaunch: true }],
        },
      };

      const entries: Array<[string, CloudFormationResource]> = [[ltId, lt], [asgId, asg]];

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
      const executionRoleLogicalId = `${logicalId}ExecutionRole`;
      const environment = props.environment as Record<string, string> | undefined;
      const subnetIds = (props.subnetIds as string[]) ?? [];

      const entries: Array<[string, CloudFormationResource]> = [
        [clusterLogicalId, {
          Type: 'AWS::ECS::Cluster',
          Properties: { ClusterName: construct.id },
        }],
        defaultServiceRole(
          executionRoleLogicalId,
          'ecs-tasks.amazonaws.com',
          ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
        ),
        [tdLogicalId, {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            Family: construct.id,
            NetworkMode: 'awsvpc',
            RequiresCompatibilities: ['FARGATE'],
            Cpu: String(props.cpu ?? 256),
            Memory: String(props.memory ?? 512),
            ExecutionRoleArn: { 'Fn::GetAtt': [executionRoleLogicalId, 'Arn'] },
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
      ];

      // Só cria o Service se subnets foram fornecidas — sem subnets o Fargate
      // falha com "subnets can not be empty" no CloudFormation.
      if (subnetIds.length > 0) {
        entries.push([svcLogicalId, {
          Type: 'AWS::ECS::Service',
          Properties: {
            Cluster: { Ref: clusterLogicalId },
            TaskDefinition: { Ref: tdLogicalId },
            DesiredCount: props.desiredCount ?? 1,
            LaunchType: 'FARGATE',
            NetworkConfiguration: {
              AwsvpcConfiguration: {
                AssignPublicIp: (props.publicIp as boolean) ? 'ENABLED' : 'DISABLED',
                Subnets: subnetIds.map(id => resolveSubnetId(id, ctx)),
                ...(props.securityGroupIds ? { SecurityGroups: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
              },
            },
          },
        }]);
      }

      return entries;
    }

    case 'Compute.Kubernetes': {
      const clusterRoleLogicalId = `${logicalId}ClusterRole`;
      const nodeRoleLogicalId = `${logicalId}NodeRole`;
      const subnetIds = (props.subnetIds as string[]) ?? [];
      if (subnetIds.length === 0) {
        console.warn(`[aws] Compute.Kubernetes "${construct.id}" sem subnetIds — o EKS rejeita cluster sem pelo menos 2 subnets reais em AZs diferentes.`);
      }

      return [
        defaultServiceRole(
          clusterRoleLogicalId,
          'eks.amazonaws.com',
          ['arn:aws:iam::aws:policy/AmazonEKSClusterPolicy'],
        ),
        defaultServiceRole(
          nodeRoleLogicalId,
          'ec2.amazonaws.com',
          [
            'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
            'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
            'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
          ],
        ),
        [logicalId, {
          Type: 'AWS::EKS::Cluster',
          Properties: {
            Name: construct.id,
            Version: (props.version as string) ?? '1.29',
            ResourcesVpcConfig: {
              SubnetIds: subnetIds.map(id => resolveSubnetId(id, ctx)),
              ...(props.securityGroupIds ? { SecurityGroupIds: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
              EndpointPrivateAccess: (props.privateCluster as boolean) ?? false,
              EndpointPublicAccess: !(props.privateCluster as boolean),
            },
            RoleArn: { 'Fn::GetAtt': [clusterRoleLogicalId, 'Arn'] },
          },
        }],
        [`${logicalId}NodeGroup`, {
          Type: 'AWS::EKS::Nodegroup',
          DependsOn: [logicalId],
          Properties: {
            ClusterName: { Ref: logicalId },
            NodegroupName: `${construct.id}-ng`,
            ScalingConfig: {
              MinSize: props.minNodes ?? 1,
              MaxSize: props.maxNodes ?? 3,
              DesiredSize: props.desiredNodes ?? 2,
            },
            InstanceTypes: [K8S_NODE_TYPE_MAP[(props.nodeInstanceType as string) ?? 'medium'] ?? 'm5.large'],
            NodeRole: { 'Fn::GetAtt': [nodeRoleLogicalId, 'Arn'] },
            Subnets: subnetIds.map(id => resolveSubnetId(id, ctx)),
          },
        }],
      ];
    }

    // ── Storage ───────────────────────────────────────────────────────────
    case 'Storage.Bucket': {
      const lifecycleRules = (props.lifecycleRules as Array<Record<string, unknown>>) ?? [];
      const isWebsite = (props.websiteHosting as boolean) ?? false;
      // websiteHosting implica acesso público — sobrescreve publicAccess
      const isPublic = isWebsite || ((props.publicAccess as boolean) ?? false);

      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::S3::Bucket',
        DeletionPolicy: 'Retain',
        Properties: {
          ...(props.bucketName ? { BucketName: props.bucketName as string } : {}),
          VersioningConfiguration: props.versioning ? { Status: 'Enabled' } : { Status: 'Suspended' },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: !isPublic,
            BlockPublicPolicy: !isPublic,
            IgnorePublicAcls: !isPublic,
            RestrictPublicBuckets: !isPublic,
          },
          ...(isWebsite ? {
            WebsiteConfiguration: { IndexDocument: 'index.html', ErrorDocument: 'index.html' },
          } : {}),
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

      // BucketPolicy de leitura pública para website hosting
      if (isWebsite) {
        entries.push([`${logicalId}Policy`, {
          Type: 'AWS::S3::BucketPolicy',
          Properties: {
            Bucket: { Ref: logicalId },
            PolicyDocument: {
              Statement: [{
                Effect: 'Allow',
                Principal: '*',
                Action: 's3:GetObject',
                Resource: { 'Fn::Sub': `arn:aws:s3:::$\{${logicalId}}/*` },
              }],
            },
          },
        }]);
      }

      return entries;
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
          VpcId: props.vpcId ? resolveVpcId(props.vpcId as string, ctx) : undefined,
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
          VpcId: props.vpcId ? resolveVpcId(props.vpcId as string, ctx) : undefined,
          SecurityGroupIngress: ingress.map((r, i) => {
            if (r.cidr === undefined) {
              console.warn(`[aws] Security group rule sem CIDR; usando 0.0.0.0/0 — defina props.cidr explicitamente (${construct.id} ingress[${i}])`);
            }
            return {
              IpProtocol: r.protocol as string,
              FromPort: r.fromPort as number,
              ToPort: r.toPort as number,
              CidrIp: (r.cidr as string) ?? '0.0.0.0/0',
              ...(r.description ? { Description: r.description } : {}),
            };
          }),
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
          Subnets: ((props.subnetIds as string[]) ?? []).map(id => resolveSubnetId(id, ctx)),
          ...(lbType === 'application' && props.securityGroupIds
            ? { SecurityGroups: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) }
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
            VpcId: props.vpcId ? resolveVpcId(props.vpcId as string, ctx) : undefined,
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

      const entries: Array<[string, CloudFormationResource]> = [];

      // Detecta origins S3 (com bucketRef) para usar OAC em vez de CustomOriginConfig
      const oacRefs: string[] = [];
      for (const o of origins) {
        if (!o.bucketRef) continue;
        const bucketRef = o.bucketRef as string;
        const oacId = `${logicalId}OAC${bucketRef}`;
        if (!oacRefs.includes(oacId)) {
          oacRefs.push(oacId);
          entries.push([oacId, {
            Type: 'AWS::CloudFront::OriginAccessControl',
            Properties: {
              OriginAccessControlConfig: {
                Name: { 'Fn::Sub': `${logicalId}-oac-\${AWS::StackName}` },
                OriginAccessControlOriginType: 's3',
                SigningBehavior: 'always',
                SigningProtocol: 'sigv4',
              },
            },
          }]);
          // BucketPolicy permitindo acesso do CloudFront via OAC
          entries.push([`${bucketRef}PolicyCDN${logicalId}`, {
            Type: 'AWS::S3::BucketPolicy',
            Properties: {
              Bucket: { Ref: bucketRef },
              PolicyDocument: {
                Statement: [{
                  Effect: 'Allow',
                  Principal: { Service: 'cloudfront.amazonaws.com' },
                  Action: 's3:GetObject',
                  Resource: { 'Fn::Sub': `arn:aws:s3:::$\{${bucketRef}}/*` },
                  Condition: {
                    StringEquals: {
                      'AWS:SourceArn': { 'Fn::Sub': `arn:aws:cloudfront::$\{AWS::AccountId}:distribution/$\{${logicalId}}` },
                    },
                  },
                }],
              },
            },
          }]);
        }
      }

      entries.push([logicalId, {
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
            Origins: origins.map(o => {
              const protocol = (o.protocol as string) ?? 'https-only';
              if (o.bucketRef) {
                const bucketRef = o.bucketRef as string;
                return {
                  Id: o.id as string,
                  DomainName: { 'Fn::GetAtt': [bucketRef, 'RegionalDomainName'] },
                  OriginPath: (o.path as string) ?? '',
                  S3OriginConfig: { OriginAccessIdentity: '' },
                  OriginAccessControlId: { Ref: `${logicalId}OAC${bucketRef}` },
                };
              }
              return {
                Id: o.id as string,
                DomainName: o.domainName as string,
                OriginPath: (o.path as string) ?? '',
                CustomOriginConfig: {
                  HTTPPort: 80,
                  HTTPSPort: 443,
                  OriginProtocolPolicy: protocol,
                },
              };
            }),
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
      }]);

      return entries;
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
      const isAurora = engine === 'aurora-mysql' || engine === 'aurora-postgresql';

      // Aurora → DBCluster + DBInstance(s); demais → DBInstance single
      if (isAurora) {
        const auroraEngineMap: Record<string, { Engine: string; EngineVersion: string }> = {
          'aurora-mysql':      { Engine: 'aurora-mysql',      EngineVersion: '8.0.mysql_aurora.3.08.0' },
          'aurora-postgresql': { Engine: 'aurora-postgresql', EngineVersion: '16.6' },
        };
        const auroraEngine = auroraEngineMap[engine];
        const masterUser = 'dbadmin';
        const auroraSecretId = `${logicalId}Secret`;
        const clusterLogicalId = `${logicalId}Cluster`;
        const subnetIds = props.subnetIds as string[] | undefined;
        const instances = (props.instances as number) ?? 1;
        const deletionPolicy = (props.deletionProtection as boolean) ? 'Retain' : 'Snapshot';

        const auroraEntries: Array<[string, CloudFormationResource]> = [];

        auroraEntries.push([auroraSecretId, {
          Type: 'AWS::SecretsManager::Secret',
          Properties: {
            Name: `${ctx.currentStackName}-${construct.id}-aurora-password`,
            GenerateSecretString: {
              SecretStringTemplate: JSON.stringify({ username: masterUser }),
              GenerateStringKey: 'password',
              PasswordLength: 32,
              ExcludeCharacters: '"@/\\\'',
            },
          },
        }]);

        if (subnetIds && subnetIds.length > 0) {
          const subnetGroupId = `${logicalId}SubnetGroup`;
          auroraEntries.push([subnetGroupId, {
            Type: 'AWS::RDS::DBSubnetGroup',
            Properties: {
              DBSubnetGroupDescription: `Subnet group Aurora para ${construct.id}`,
              SubnetIds: subnetIds.map(id => resolveSubnetId(id, ctx)),
            },
          }]);

          const clusterProps: Record<string, unknown> = {
            DBClusterIdentifier: construct.id.toLowerCase(),
            Engine: auroraEngine.Engine,
            EngineVersion: auroraEngine.EngineVersion,
            MasterUsername: masterUser,
            MasterUserPassword: { 'Fn::Sub': `{{resolve:secretsmanager:\${${auroraSecretId}}:SecretString:password}}` },
            DBSubnetGroupName: { Ref: subnetGroupId },
            StorageEncrypted: (props.storageEncrypted as boolean) ?? true,
            BackupRetentionPeriod: (props.backupRetentionDays as number) ?? 7,
            DeletionProtection: (props.deletionProtection as boolean) ?? false,
            ...(props.securityGroupIds ? { VpcSecurityGroupIds: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
          };

          auroraEntries.push([clusterLogicalId, {
            Type: 'AWS::RDS::DBCluster',
            DeletionPolicy: deletionPolicy,
            Properties: clusterProps,
          }]);
        } else {
          // Sem subnets — cria cluster sem SubnetGroup (usa VPC default da conta)
          auroraEntries.push([clusterLogicalId, {
            Type: 'AWS::RDS::DBCluster',
            DeletionPolicy: deletionPolicy,
            Properties: {
              DBClusterIdentifier: construct.id.toLowerCase(),
              Engine: auroraEngine.Engine,
              EngineVersion: auroraEngine.EngineVersion,
              MasterUsername: masterUser,
              MasterUserPassword: { 'Fn::Sub': `{{resolve:secretsmanager:\${${auroraSecretId}}:SecretString:password}}` },
              StorageEncrypted: (props.storageEncrypted as boolean) ?? true,
              BackupRetentionPeriod: (props.backupRetentionDays as number) ?? 7,
              DeletionProtection: (props.deletionProtection as boolean) ?? false,
            },
          }]);
        }

        const instanceClass = (props.instanceType as string) ?? 'db.t3.medium';
        for (let i = 1; i <= instances; i++) {
          const instanceLogicalId = i === 1 ? logicalId : `${logicalId}Instance${i}`;
          auroraEntries.push([instanceLogicalId, {
            Type: 'AWS::RDS::DBInstance',
            DeletionPolicy: deletionPolicy,
            Properties: {
              DBClusterIdentifier: { Ref: clusterLogicalId },
              DBInstanceClass: instanceClass,
              Engine: auroraEngine.Engine,
            },
          }]);
        }

        return auroraEntries;
      }

      // ── RDS single-instance (mysql, postgres, mariadb, oracle, sqlserver) ──
      const engineMap: Record<string, { Engine: string; EngineVersion: string }> = {
        mysql:     { Engine: 'mysql',                                    EngineVersion: '8.0.46' },
        postgres:  { Engine: 'postgres',                                 EngineVersion: '17.10' },
        mariadb:   { Engine: 'mariadb',                                  EngineVersion: '11.8.8' },
        oracle:    { Engine: `oracle-${edition || 'se2'}`,               EngineVersion: '19.0.0.0.ru-2024-01.rur-2024-01.r1' },
        sqlserver: { Engine: `sqlserver-${edition || 'ex'}`,             EngineVersion: '15.00.4365.2.v1' },
      };
      const mapped = engineMap[engine] ?? engineMap['mysql'];

      const isOracle    = engine === 'oracle';
      const isSqlServer = engine === 'sqlserver';
      const licenseModel = (props.licenseModel as string)
        ?? (isOracle || isSqlServer ? 'license-included' : undefined);

      const masterUser = isSqlServer ? 'sqladmin' : 'dbadmin';
      const defaultInstance = (isOracle || isSqlServer) ? 'db.t3.small' : 'db.t3.micro';

      // Defaults DERIVADOS do tier da conta (free vs standard) — o usuário não
      // precisa mais escrever backupRetentionDays/storageEncrypted no .ts. Props
      // explícitas sempre vencem o default do tier.
      const dbDefaults = databaseDefaultsForTier(ctx.profile.accountTier);

      const rdsSecretId = `${logicalId}Secret`;
      const rdsProps: Record<string, unknown> = {
        DBInstanceClass:       (props.instanceType as string) ?? defaultInstance,
        Engine:                mapped.Engine,
        EngineVersion:         mapped.EngineVersion,
        AllocatedStorage:      String(props.storageGb ?? 20),
        MultiAZ:               (props.multiAz as boolean) ?? false,
        MasterUsername:        masterUser,
        MasterUserPassword:    { 'Fn::Sub': `{{resolve:secretsmanager:\${${rdsSecretId}}:SecretString:password}}` },
        StorageEncrypted:      (props.storageEncrypted as boolean) ?? dbDefaults.storageEncrypted,
        BackupRetentionPeriod: props.backupRetentionDays ?? dbDefaults.backupRetentionDays,
        DeletionProtection:    (props.deletionProtection as boolean) ?? false,
      };
      if (licenseModel) rdsProps['LicenseModel'] = licenseModel;

      const sqlSubnetIds = props.subnetIds as string[] | undefined;
      const sqlEntries: Array<[string, CloudFormationResource]> = [];
      sqlEntries.push([rdsSecretId, {
        Type: 'AWS::SecretsManager::Secret',
        Properties: {
          Name: `${ctx.currentStackName}-${construct.id}-db-password`,
          GenerateSecretString: {
            SecretStringTemplate: JSON.stringify({ username: masterUser }),
            GenerateStringKey: 'password',
            PasswordLength: 32,
            ExcludeCharacters: '"@/\\\'',
          },
        },
      }]);
      if (sqlSubnetIds && sqlSubnetIds.length > 0) {
        const subnetGroupId = `${logicalId}SubnetGroup`;
        sqlEntries.push([subnetGroupId, {
          Type: 'AWS::RDS::DBSubnetGroup',
          Properties: {
            DBSubnetGroupDescription: `Subnet group para ${construct.id}`,
            SubnetIds: sqlSubnetIds.map(id => resolveSubnetId(id, ctx)),
          },
        }]);
        rdsProps['DBSubnetGroupName'] = { Ref: subnetGroupId };
        if (props.securityGroupIds) rdsProps['VPCSecurityGroups'] = (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx));
      }

      sqlEntries.push([logicalId, {
        Type: 'AWS::RDS::DBInstance',
        DeletionPolicy: (props.deletionProtection as boolean) ? 'Retain' : ((props.snapshotOnDelete as boolean) ? 'Snapshot' : 'Delete'),
        Properties: rdsProps,
      }]);
      return sqlEntries;
    }

    case 'Database.DocumentDB': {
      const instances = (props.instances as number) ?? 1;
      const clusterLogicalId = `${logicalId}Cluster`;
      const docDbSubnetIds = props.subnetIds as string[] | undefined;
      const entries: Array<[string, CloudFormationResource]> = [];

      const docDbSecretId = `${logicalId}Secret`;
      entries.push([docDbSecretId, {
        Type: 'AWS::SecretsManager::Secret',
        Properties: {
          Name: `${ctx.currentStackName}-${construct.id}-docdb-password`,
          GenerateSecretString: {
            SecretStringTemplate: JSON.stringify({ username: 'docdbadmin' }),
            GenerateStringKey: 'password',
            PasswordLength: 32,
            ExcludeCharacters: '"@/\\\'',
          },
        },
      }]);
      const docDbClusterProps: Record<string, unknown> = {
        DBClusterIdentifier: construct.id.toLowerCase(),
        MasterUsername: 'docdbadmin',
        MasterUserPassword: { 'Fn::Sub': `{{resolve:secretsmanager:\${${docDbSecretId}}:SecretString:password}}` },
        StorageEncrypted: true,
        BackupRetentionPeriod: (props.backupRetentionDays as number) ?? 1,
        DeletionProtection: (props.deletionProtection as boolean) ?? false,
      };
      if (docDbSubnetIds && docDbSubnetIds.length > 0) {
        const subnetGroupId = `${clusterLogicalId}SubnetGroup`;
        entries.push([subnetGroupId, {
          Type: 'AWS::DocDB::DBSubnetGroup',
          Properties: {
            DBSubnetGroupDescription: `Subnet group para ${construct.id}`,
            SubnetIds: docDbSubnetIds.map(id => resolveSubnetId(id, ctx)),
          },
        }]);
        docDbClusterProps['DBSubnetGroupName'] = { Ref: subnetGroupId };
        if (props.securityGroupIds) docDbClusterProps['VpcSecurityGroupIds'] = (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx));
      }

      entries.push([clusterLogicalId, {
        Type: 'AWS::DocDB::DBCluster',
        DeletionPolicy: (props.deletionProtection as boolean) ? 'Retain' : ((props.snapshotOnDelete as boolean) ? 'Snapshot' : 'Delete'),
        Properties: docDbClusterProps,
      }]);
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
        { AttributeName: props.partitionKey as string, AttributeType: (props.partitionKeyType as string) ?? 'S' },
        ...(props.sortKey ? [{ AttributeName: props.sortKey as string, AttributeType: (props.sortKeyType as string) ?? 'S' }] : []),
        ...gsis.map(g => ({ AttributeName: g.partitionKey as string, AttributeType: (g.partitionKeyType as string) ?? 'S' })),
        ...gsis.filter(g => g.sortKey).map(g => ({ AttributeName: g.sortKey as string, AttributeType: (g.sortKeyType as string) ?? 'S' })),
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
          ...(props.securityGroupIds ? { SecurityGroupIds: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
        },
      }]];
    }

    case 'Cache.Memcached': {
      const memSubnetIds = props.subnetIds as string[] | undefined;
      const memEntries: Array<[string, CloudFormationResource]> = [];
      const memProps: Record<string, unknown> = {
        ClusterName: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
        Engine: 'memcached',
        CacheNodeType: CACHE_NODE_TYPE_MAP[(props.nodeType as string) ?? 'small'] ?? 'cache.t3.micro',
        NumCacheNodes: (props.numCacheNodes as number) ?? 2,
      };
      if (memSubnetIds && memSubnetIds.length > 0) {
        const subnetGroupId = `${logicalId}SubnetGroup`;
        memEntries.push([subnetGroupId, {
          Type: 'AWS::ElastiCache::SubnetGroup',
          Properties: {
            Description: `Subnet group para ${construct.id}`,
            SubnetIds: memSubnetIds.map(id => resolveSubnetId(id, ctx)),
          },
        }]);
        memProps['CacheSubnetGroupName'] = { Ref: subnetGroupId };
        if (props.securityGroupIds) memProps['VpcSecurityGroupIds'] = (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx));
      } else {
        if (props.subnetGroupName) memProps['CacheSubnetGroupName'] = props.subnetGroupName;
        if (props.securityGroupIds) memProps['VpcSecurityGroupIds'] = (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx));
      }
      memEntries.push([logicalId, {
        Type: 'AWS::ElastiCache::CacheCluster',
        Properties: memProps,
      }]);
      return memEntries;
    }

    // ── Function ──────────────────────────────────────────────────────────
    case 'Function.Lambda': {
      const environment = props.environment as Record<string, string> | undefined;
      const runtimeMap: Record<string, string> = {
        'nodejs20': 'nodejs20.x', 'nodejs18': 'nodejs18.x',
        'python3.12': 'python3.12', 'python3.11': 'python3.11',
        'java21': 'java21', 'go1.x': 'go1.x', 'dotnet8': 'dotnet8',
      };
      const role = resolveLambdaRole(construct.id, logicalId, ctx, !!props.vpcId);
      const entries: Array<[string, CloudFormationResource]> = [];
      if (role.extraResource) entries.push(role.extraResource);
      entries.push([logicalId, {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: construct.id,
          Runtime: runtimeMap[(props.runtime as string) ?? 'nodejs20'] ?? 'nodejs20.x',
          Handler: props.handler as string,
          // String (não { ZipFile }) — formato local-path que `aws cloudformation
          // package` reconhece e transforma em S3Bucket/S3Key antes do deploy real.
          Code: props.code as string,
          MemorySize: (props.memory as number) ?? 128,
          Timeout: (props.timeout as number) ?? 30,
          Role: role.roleRef,
          ...(props.reservedConcurrency !== undefined ? { ReservedConcurrentExecutions: props.reservedConcurrency } : {}),
          ...(environment && Object.keys(environment).length > 0 ? {
            Environment: {
              Variables: Object.fromEntries(
                Object.entries(environment).map(([k, v]) => [k, resolveEnvVarValue(v, ctx)])
              ),
            },
          } : {}),
          ...(props.vpcId ? {
            VpcConfig: {
              SubnetIds: ((props.subnetIds as string[]) ?? []).map(id => resolveSubnetId(id, ctx)),
              SecurityGroupIds: ((props.securityGroupIds as string[]) ?? []).map(id => resolveSecurityGroupId(id, ctx)),
            },
          } : {}),
        },
      }]);
      return entries;
    }

    case 'Function.ApiGateway': {
      const apigwType = (props.type as string) ?? 'HTTP';
      const routes = (props.routes as Array<Record<string, unknown>>) ?? [];
      const stageName = (props.stageName as string) ?? '$default';
      const authorizerLambdaId = props.authorizerLambdaId as string | undefined;
      const authorizerId = authorizerLambdaId ? `${logicalId}Authorizer` : undefined;
      // Toda Lambda referenciada (rotas + authorizer) precisa de uma
      // AWS::Lambda::Permission liberando o API Gateway a invocá-la —
      // dedupe por par (api, lambda): uma Permission serve pra todas as rotas
      // que chamam a mesma função nesta API.
      const lambdaIdsNeedingPermission = new Set<string>();
      if (authorizerLambdaId) lambdaIdsNeedingPermission.add(authorizerLambdaId);
      for (const r of routes) {
        if (r.lambdaId) lambdaIdsNeedingPermission.add(r.lambdaId as string);
      }

      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: apigwType === 'REST' ? 'AWS::ApiGateway::RestApi' : 'AWS::ApiGatewayV2::Api',
        Properties: {
          Name: props.name as string,
          // ApiGateway (v1) rejeita Description: '' com 400 ("cannot be an
          // empty string") — omitir a propriedade quando não houver
          // descrição, em vez de mandar string vazia como default.
          ...(props.description ? { Description: props.description as string } : {}),
          ...(apigwType !== 'REST' ? { ProtocolType: apigwType } : {}),
          ...(apigwType !== 'REST' && props.cors ? { CorsConfiguration: { AllowOrigins: ['*'], AllowMethods: ['*'], AllowHeaders: ['*'] } } : {}),
        },
      }]];

      if (apigwType === 'REST') {
        // ── REST (API Gateway v1) — Resource/Method/Deployment, incompatível
        // com os recursos ApiGatewayV2 usados no branch HTTP abaixo. ─────────
        const resourceIdByPath = new Map<string, string>(); // caminho cumulativo → logicalId do Resource
        const methodLogicalIds: string[] = [];
        const corsResourceRefs = new Map<string, unknown>(); // logicalId-do-resource-ou-root → ref, deduplicado

        const resolveResourceRef = (path: string): unknown => {
          const segments = path.split('/').filter(Boolean);
          if (segments.length === 0) return { 'Fn::GetAtt': [logicalId, 'RootResourceId'] };

          let parentRef: unknown = { 'Fn::GetAtt': [logicalId, 'RootResourceId'] };
          let cumulative = '';
          for (const seg of segments) {
            cumulative += `/${seg}`;
            let segLogicalId = resourceIdByPath.get(cumulative);
            if (!segLogicalId) {
              segLogicalId = `${logicalId}Resource${cumulative.replace(/[^a-zA-Z0-9]/g, '')}`;
              entries.push([segLogicalId, {
                Type: 'AWS::ApiGateway::Resource',
                Properties: { RestApiId: { Ref: logicalId }, ParentId: parentRef, PathPart: seg },
              }]);
              resourceIdByPath.set(cumulative, segLogicalId);
            }
            parentRef = { Ref: segLogicalId };
          }
          return { Ref: resourceIdByPath.get(cumulative)! };
        };

        if (authorizerLambdaId) {
          entries.push([authorizerId!, {
            Type: 'AWS::ApiGateway::Authorizer',
            Properties: {
              RestApiId: { Ref: logicalId },
              Type: 'REQUEST',
              Name: `${props.name as string}-authorizer`,
              AuthorizerUri: buildInvocationUri(authorizerLambdaId, ctx),
              IdentitySource: 'method.request.header.Authorization',
              AuthorizerResultTtlInSeconds: 0,
            },
          }]);
        }

        for (const r of routes) {
          const path = r.path as string;
          const method = r.method as string;
          const resourceRef = resolveResourceRef(path);
          const methodLogicalId = `${logicalId}${method}${path.replace(/[^a-zA-Z0-9]/g, '')}Method`;

          entries.push([methodLogicalId, {
            Type: 'AWS::ApiGateway::Method',
            Properties: {
              RestApiId: { Ref: logicalId },
              ResourceId: resourceRef,
              HttpMethod: method,
              AuthorizationType: authorizerId ? 'CUSTOM' : 'NONE',
              ...(authorizerId ? { AuthorizerId: { Ref: authorizerId } } : {}),
              ...(r.lambdaId ? {
                Integration: {
                  Type: 'AWS_PROXY',
                  IntegrationHttpMethod: 'POST',
                  Uri: buildInvocationUri(r.lambdaId as string, ctx),
                },
              } : {}),
            },
          }]);
          methodLogicalIds.push(methodLogicalId);

          if (props.cors) {
            const corsKey = path;
            if (!corsResourceRefs.has(corsKey)) corsResourceRefs.set(corsKey, resourceRef);
          }
        }

        // OPTIONS+MOCK por resource único que tenha rota com CORS habilitado.
        for (const [path, resourceRef] of corsResourceRefs) {
          const optionsId = `${logicalId}Options${path.replace(/[^a-zA-Z0-9]/g, '')}Method`;
          entries.push([optionsId, {
            Type: 'AWS::ApiGateway::Method',
            Properties: {
              RestApiId: { Ref: logicalId },
              ResourceId: resourceRef,
              HttpMethod: 'OPTIONS',
              AuthorizationType: 'NONE',
              Integration: {
                Type: 'MOCK',
                RequestTemplates: { 'application/json': '{"statusCode": 200}' },
                IntegrationResponses: [{
                  StatusCode: '200',
                  ResponseParameters: {
                    'method.response.header.Access-Control-Allow-Headers': "'Content-Type,Authorization'",
                    'method.response.header.Access-Control-Allow-Methods': "'OPTIONS,GET,POST,PUT,DELETE,PATCH'",
                    'method.response.header.Access-Control-Allow-Origin': "'*'",
                  },
                }],
              },
              MethodResponses: [{
                StatusCode: '200',
                ResponseParameters: {
                  'method.response.header.Access-Control-Allow-Headers': true,
                  'method.response.header.Access-Control-Allow-Methods': true,
                  'method.response.header.Access-Control-Allow-Origin': true,
                },
              }],
            },
          }]);
          methodLogicalIds.push(optionsId);
        }

        // Hash das rotas no LOGICAL ID do Deployment — quando rotas mudam, o
        // logical ID muda, CloudFormation cria um NOVO Deployment (novo snapshot
        // da API), atualiza o Stage para apontar para ele e deleta o antigo.
        // Usar só a Description não funciona: o CF atualiza em-place sem criar
        // novo snapshot, então o stage continua com as rotas antigas (403).
        const routesHash = routes
          .map(r => `${r.method}:${r.path}:${r.lambdaId}`)
          .sort()
          .join('|');
        let hashVal = 0;
        for (let i = 0; i < routesHash.length; i++) hashVal = (Math.imul(31, hashVal) + routesHash.charCodeAt(i)) >>> 0;
        const deploymentId = `${logicalId}Deployment${hashVal.toString(16)}`;
        entries.push([deploymentId, {
          Type: 'AWS::ApiGateway::Deployment',
          DependsOn: methodLogicalIds,
          Properties: { RestApiId: { Ref: logicalId } },
        }]);

        entries.push([`${logicalId}Stage`, {
          Type: 'AWS::ApiGateway::Stage',
          Properties: {
            RestApiId: { Ref: logicalId },
            DeploymentId: { Ref: deploymentId },
            StageName: stageName,
            ...(props.throttlingBurstLimit ? {
              MethodSettings: [{
                ResourcePath: '/*', HttpMethod: '*',
                ThrottlingBurstLimit: props.throttlingBurstLimit,
                ThrottlingRateLimit: props.throttlingRateLimit ?? 1000,
              }],
            } : {}),
          },
        }]);
      } else {
        // ── HTTP/WEBSOCKET (API Gateway v2) — comportamento existente. ──────
        entries.push([`${logicalId}Stage`, {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: {
            ApiId: { Ref: logicalId },
            StageName: stageName,
            AutoDeploy: true,
            ...(props.throttlingBurstLimit ? {
              DefaultRouteSettings: {
                ThrottlingBurstLimit: props.throttlingBurstLimit,
                ThrottlingRateLimit: props.throttlingRateLimit ?? 1000,
              },
            } : {}),
          },
        }]);

        if (authorizerLambdaId) {
          entries.push([authorizerId!, {
            Type: 'AWS::ApiGatewayV2::Authorizer',
            Properties: {
              ApiId: { Ref: logicalId },
              AuthorizerType: 'REQUEST',
              Name: `${props.name as string}-authorizer`,
              AuthorizerUri: buildInvocationUri(authorizerLambdaId, ctx),
              AuthorizerPayloadFormatVersion: '2.0',
              IdentitySource: ['$request.header.Authorization'],
            },
          }]);
        }

        for (const r of routes) {
          const routeId = `${logicalId}${(r.method as string)}${(r.path as string).replace(/[^a-zA-Z0-9]/g, '')}Route`;
          entries.push([routeId, {
            Type: 'AWS::ApiGatewayV2::Route',
            Properties: {
              ApiId: { Ref: logicalId },
              RouteKey: `${r.method} ${r.path}`,
              ...(r.lambdaId ? { Target: { 'Fn::Sub': `integrations/\${${routeId}Integration}` } } : {}),
              ...(authorizerId ? { AuthorizationType: 'CUSTOM', AuthorizerId: { Ref: authorizerId } } : {}),
            },
          }]);

          if (r.lambdaId) {
            entries.push([`${routeId}Integration`, {
              Type: 'AWS::ApiGatewayV2::Integration',
              Properties: {
                ApiId: { Ref: logicalId },
                IntegrationType: 'AWS_PROXY',
                IntegrationUri: buildInvocationUri(r.lambdaId as string, ctx),
                PayloadFormatVersion: '2.0',
              },
            }]);
          }
        }
      }

      // Permissões de invocação — comuns aos dois tipos (Ref resolve pro ID
      // certo de cada tipo de API automaticamente).
      for (const lambdaId of lambdaIdsNeedingPermission) {
        entries.push([`${lambdaId}${logicalId}Permission`, {
          Type: 'AWS::Lambda::Permission',
          Properties: {
            Action: 'lambda:InvokeFunction',
            FunctionName: resolveLambdaArnRef(lambdaId, ctx),
            Principal: 'apigateway.amazonaws.com',
            SourceArn: { 'Fn::Sub': `arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${${logicalId}}/*/*` },
          },
        }]);
      }

      return entries;
    }

    // ── Policy ────────────────────────────────────────────────────────────
    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachType = props.attachType as string;
      const attachTo = (props.attachTo as string).replace(/[^a-zA-Z0-9]/g, '');
      const principalService = attachType === 'lambda' ? 'lambda.amazonaws.com' : 'ec2.amazonaws.com';
      const lambdaInVpc = attachType === 'lambda' && ctx.vpcLambdas.has(props.attachTo as string);
      const managedPolicies: string[] = attachType === 'lambda'
        ? [lambdaInVpc
            ? 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'
            : 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
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
                Resource: ((s.resources as string[]) ?? ['*']).map(r => resolvePolicyResource(r, ctx)),
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

        // Ref ao bus quando customizado — CloudFormation infere a dependência
        // e garante que o bus existe antes de criar a rule.
        const eventBusName = busName !== 'default' ? { Ref: `${logicalId}Bus` } : 'default';

        entries.push([`${logicalId}${ruleName}Rule`, {
          Type: 'AWS::Events::Rule',
          Properties: {
            Name: r.name as string,
            EventBusName: eventBusName,
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
        States: Object.fromEntries(steps.map((s, i) => {
          const stateType = (s.type as string) ?? 'Task';
          const isTask = stateType === 'Task';
          return [s.name as string, {
            Type: stateType,
            ...(isTask ? { Resource: (s.resource as string) ?? '' } : {}),
            ...(s.description ? { Comment: s.description } : {}),
            ...(i < steps.length - 1 ? { Next: steps[i + 1].name as string } : { End: true }),
          }];
        })),
      };
      const roleLogicalId = `${logicalId}ExecutionRole`;
      // Permissões amplas pros tipos de target mais comuns nos steps de uma
      // state machine — não dá pra saber de antemão quais recursos os `steps`
      // vão invocar. Pra escopo mínimo de verdade, adicione um Policy.IAM
      // (attachType: 'role', attachTo: este id) com os recursos exatos.
      console.warn(`[aws] Workflow.StepFunctions "${construct.id}" usa uma role default com permissões amplas (Lambda/ECS/SNS/SQS/EventBridge) — para produção, escope com Policy.IAM.`);
      return [
        defaultServiceRole(roleLogicalId, 'states.amazonaws.com', [], {
          name: `${logicalId}DefaultPolicy`,
          statements: [{
            Effect: 'Allow',
            Action: [
              'lambda:InvokeFunction',
              'ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks',
              'sns:Publish',
              'sqs:SendMessage',
              'events:PutTargets', 'events:PutRule', 'events:DescribeRule',
              'iam:PassRole',
            ],
            Resource: '*',
          }],
        }),
        [logicalId, {
          Type: 'AWS::StepFunctions::StateMachine',
          Properties: {
            StateMachineName: construct.id,
            StateMachineType: (props.type as string) ?? 'STANDARD',
            DefinitionString: { 'Fn::Sub': JSON.stringify(definition) },
            RoleArn: { 'Fn::GetAtt': [roleLogicalId, 'Arn'] },
          },
        }],
      ];
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
          ...(fifo ? { FifoQueue: true } : {}),
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
          ...(fifo ? { FifoTopic: true } : {}),
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

    case 'Custom.Resource': {
      const cfn = props.cloudformation as { type: string; properties: Record<string, unknown> } | undefined;
      if (!cfn) return [];
      return [[logicalId, { Type: cfn.type, Properties: cfn.properties }]];
    }

    default:
      console.warn(`[aws] Construct type '${construct.type}' nao suportado — descartado.`);
      return [];
  }
}

const CFN_PSEUDO_PARAMETERS = new Set([
  'AWS::Region', 'AWS::AccountId', 'AWS::StackName', 'AWS::StackId',
  'AWS::Partition', 'AWS::URLSuffix', 'AWS::NoValue', 'AWS::NotificationARNs',
]);

function collectReferencedLogicalIds(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectReferencedLogicalIds(item, found);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.Ref === 'string' && !CFN_PSEUDO_PARAMETERS.has(obj.Ref)) {
      found.add(obj.Ref);
    }
    const getAtt = obj['Fn::GetAtt'];
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') {
      found.add(getAtt[0]);
    } else if (typeof getAtt === 'string') {
      found.add(getAtt.split('.')[0]);
    }
    for (const value of Object.values(obj)) {
      collectReferencedLogicalIds(value, found);
    }
  }
}

/**
 * Detecta Ref/Fn::GetAtt pra um logical id que não existe na própria stack —
 * ex: um Custom.Resource (escape hatch de texto livre, sem checagem do
 * compilador) referenciando uma Lambda que nunca foi criada. Sem isso, o
 * erro só aparece no `aws cloudformation deploy`, depois do template já ter
 * sido empacotado/enviado.
 */
function validateResourceReferences(resources: Record<string, CloudFormationResource>): void {
  const referenced = new Set<string>();
  for (const resource of Object.values(resources)) {
    collectReferencedLogicalIds(resource.Properties, referenced);
    if (resource.DependsOn) for (const dep of resource.DependsOn) referenced.add(dep);
  }
  const missing = [...referenced].filter(id => !resources[id]);
  if (missing.length > 0) {
    throw new Error(
      `Ref/Fn::GetAtt para recurso inexistente: ${missing.map(id => `"${id}"`).join(', ')}. ` +
      `Verifique se o recurso foi de fato criado na stack — ex: um Custom.Resource cujo ServiceToken aponta para uma Lambda precisa que essa Lambda exista (como Fn.Lambda ou outro Custom.Resource).`
    );
  }
}

/**
 * Detecta null/undefined em qualquer propriedade dos resources ANTES do deploy.
 * Causa típica: a IA referencia uma propriedade que não existe no construct
 * (ex: `secretArn` em Secret.Vault), que em TS é `undefined` e vira `null` no
 * template — o CloudFormation rejeita com "'null' values are not allowed".
 * Pega na origem, com o caminho exato.
 */
function validateNoNullValues(resources: Record<string, CloudFormationResource>): void {
  const bad: string[] = [];
  const walk = (node: unknown, pathStr: string): void => {
    if (node === null || node === undefined) {
      bad.push(pathStr);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${pathStr}[${i}]`));
    } else if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, `${pathStr}.${k}`);
    }
  };
  for (const [id, resource] of Object.entries(resources)) {
    walk(resource.Properties, id);
  }
  if (bad.length > 0) {
    throw new Error(
      `Valor null/undefined no template (CloudFormation rejeita): ${bad.map(p => `"${p}"`).join(', ')}. ` +
      `Causa comum: referência a uma propriedade que não existe no construct ` +
      `(ex: Secret.Vault não tem .secretArn; use a env var resolvida pelo synth ou o id do recurso).`
    );
  }
}

function synthesizeVPCChildren(
  logicalId: string,
  cidr: string,
  maxAzs: number,
  resources: Record<string, CloudFormationResource>,
  outputs: Record<string, { Value: unknown; Export: { Name: string } }>,
  stackName: string,
  constructId: string,
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
    // Exporta os IDs reais das subnets auto-geradas (maxAzs) — sem isso nada
    // fora da própria stack (ex: harness de teste lendo via describe-stacks)
    // consegue saber o ID real pra usar em outro construct (EKS, RDS, EC2...).
    outputs[`${pubSubnetId}SubnetId`] = {
      Value: { Ref: pubSubnetId },
      Export: { Name: `${stackName}-${constructId}-Public${az.toUpperCase()}-SubnetId` },
    };
    outputs[`${privSubnetId}SubnetId`] = {
      Value: { Ref: privSubnetId },
      Export: { Name: `${stackName}-${constructId}-Private${az.toUpperCase()}-SubnetId` },
    };
  });
}

export function synthesize(stack: Stack, allStacks?: Stack[], profile: EnvironmentProfile = DEFAULT_PROFILE): CloudFormationTemplate {
  const resources: Record<string, CloudFormationResource> = {};
  const outputs: Record<string, { Value: unknown; Export: { Name: string } }> = {};

  // Registry global (constructId → nome da stack que o declara) + roles de
  // Lambda criadas por Policy.IAM — sempre construído a partir de TODAS as
  // stacks quando o chamador tem essa visão (iacmp synth real); sem
  // `allStacks` (testes isolados), usa só a stack atual como universo —
  // mesmo efeito de antes (toda referência resolve local).
  const universe = allStacks ?? [stack];

  // Normalização: preenche defaults derivados do perfil (AZ de subnet, porta do
  // SG do banco) in-place ANTES de validar e emitir — assim os bugs recorrentes
  // deixam de existir na origem, e a validação/synth leem props já consistentes.
  applyEnvironmentDefaults(universe, profile);

  // Validação semântica provider-agnóstica (porta de SG vs engine, cobertura de
  // AZ do RDS, conflito maxAzs/subnets, CIDR, referências quebradas) — roda
  // antes de emitir o template para que esses erros apareçam em synth-time, não
  // no deploy real. O loop do `iacmp ai` captura e reenvia para auto-correção.
  const semanticErrors = validateSemantics(universe, profile);
  if (semanticErrors.length > 0) {
    throw new Error(
      `Validação semântica falhou:\n- ${semanticErrors.join('\n- ')}`,
    );
  }

  const registry = new Map<string, string>();
  const lambdaRoles = new Map<string, { stackName: string; roleLogicalId: string }>();
  const vpcLambdas = new Set<string>();
  const dbSecretSuffix = new Map<string, string>();
  const secretVaults = new Set<string>();
  for (const s of universe) {
    for (const c of s.constructs) {
      registry.set(c.id, s.name);
      if (c.type === 'Secret.Vault') secretVaults.add(c.id);
      if (c.type === 'Policy.IAM') {
        const p = c.props as Record<string, unknown>;
        if (p.attachType === 'lambda' && typeof p.attachTo === 'string') {
          lambdaRoles.set(p.attachTo, {
            stackName: s.name,
            roleLogicalId: `${c.id.replace(/[^a-zA-Z0-9]/g, '')}Role`,
          });
        }
      }
      if (c.type === 'Function.Lambda') {
        const p = c.props as Record<string, unknown>;
        if (p.vpcId) vpcLambdas.add(c.id);
      }
      if (c.type === 'Database.SQL') {
        const p = c.props as Record<string, unknown>;
        const engine = p.engine as string;
        const isAurora = engine === 'aurora-mysql' || engine === 'aurora-postgresql';
        dbSecretSuffix.set(c.id, isAurora ? 'aurora-password' : 'db-password');
      }
      if (c.type === 'Database.DocumentDB') {
        dbSecretSuffix.set(c.id, 'docdb-password');
      }
    }
  }
  const ctx: SynthContext = { currentStackName: stack.name, registry, lambdaRoles, vpcLambdas, dbSecretSuffix, secretVaults, profile };

  for (const construct of stack.constructs) {
    const entries = synthesizeConstruct(construct, ctx);
    for (const [id, resource] of entries) {
      resources[id] = resource;
    }
    if (construct.type === 'Network.VPC') {
      const p = construct.props as Record<string, unknown>;
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      synthesizeVPCChildren(logicalId, (p.cidr as string) ?? '10.0.0.0/16', (p.maxAzs as number) ?? 0, resources, outputs, stack.name, construct.id);
      // Exporta sempre — custo zero, e é o que permite outra stack (ou um
      // harness de teste lendo via describe-stacks) referenciar essa VPC pelo
      // ID real em vez de depender da VPC default da conta.
      outputs[`${logicalId}VpcId`] = {
        Value: { Ref: logicalId },
        Export: { Name: `${stack.name}-${construct.id}-VpcId` },
      };
    }
    if (construct.type === 'Network.Subnet') {
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}SubnetId`] = {
        Value: { Ref: logicalId },
        Export: { Name: `${stack.name}-${construct.id}-SubnetId` },
      };
    }
    if (construct.type === 'Network.SecurityGroup') {
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}GroupId`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'GroupId'] },
        Export: { Name: `${stack.name}-${construct.id}-GroupId` },
      };
    }
    if (construct.type === 'Secret.Vault') {
      // Ref de AWS::SecretsManager::Secret retorna o ARN — exporta para cross-stack.
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}SecretArn`] = {
        Value: { Ref: logicalId },
        Export: { Name: `${stack.name}-${construct.id}-SecretArn` },
      };
    }
    if (construct.type === 'Function.Lambda') {
      // Exporta sempre — custo zero, e é o que permite Function.ApiGateway em
      // OUTRA stack referenciar esta Lambda via Fn::ImportValue.
      const lambdaLogicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${lambdaLogicalId}Arn`] = {
        Value: { 'Fn::GetAtt': [lambdaLogicalId, 'Arn'] },
        Export: { Name: `${stack.name}-${construct.id}-Arn` },
      };
    }
    if (construct.type === 'Policy.IAM') {
      const p = construct.props as Record<string, unknown>;
      if (p.attachType === 'lambda') {
        // Exporta o ARN da role pra Function.Lambda em OUTRA stack poder
        // importá-la (resolveLambdaRole, caso cross-stack).
        const roleLogicalId = `${construct.id.replace(/[^a-zA-Z0-9]/g, '')}Role`;
        outputs[`${roleLogicalId}RoleArn`] = {
          Value: { 'Fn::GetAtt': [roleLogicalId, 'Arn'] },
          Export: { Name: `${stack.name}-${roleLogicalId}-RoleArn` },
        };
      }
    }
    if (construct.type === 'Database.SQL') {
      const p = construct.props as Record<string, unknown>;
      const engine = p.engine as string;
      const isAurora = engine === 'aurora-mysql' || engine === 'aurora-postgresql';
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      const endpointResource = isAurora ? `${logicalId}Cluster` : logicalId;
      outputs[`${logicalId}Endpoint`] = {
        Value: { 'Fn::GetAtt': [endpointResource, 'Endpoint.Address'] },
        Export: { Name: `${stack.name}-${construct.id}-Endpoint` },
      };
      outputs[`${logicalId}Port`] = {
        Value: { 'Fn::GetAtt': [endpointResource, 'Endpoint.Port'] },
        Export: { Name: `${stack.name}-${construct.id}-Port` },
      };
      outputs[`${logicalId}SecretArn`] = {
        Value: { Ref: `${logicalId}Secret` },
        Export: { Name: `${stack.name}-${construct.id}-SecretArn` },
      };
    }
    if (construct.type === 'Database.DocumentDB') {
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Endpoint`] = {
        Value: { 'Fn::GetAtt': [`${logicalId}Cluster`, 'Endpoint'] },
        Export: { Name: `${stack.name}-${construct.id}-Endpoint` },
      };
      outputs[`${logicalId}Port`] = {
        Value: { 'Fn::GetAtt': [`${logicalId}Cluster`, 'Port'] },
        Export: { Name: `${stack.name}-${construct.id}-Port` },
      };
      outputs[`${logicalId}SecretArn`] = {
        Value: { Ref: `${logicalId}Secret` },
        Export: { Name: `${stack.name}-${construct.id}-SecretArn` },
      };
    }
  }

  validateResourceReferences(resources);
  validateNoNullValues(resources);

  const template: CloudFormationTemplate = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Stack ${stack.name} — gerada pelo iacmp`,
    Resources: resources,
  };
  if (Object.keys(outputs).length > 0) template.Outputs = outputs;
  return template;
}
