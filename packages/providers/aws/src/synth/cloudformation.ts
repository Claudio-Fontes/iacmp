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
  /** IDs de Storage.Bucket — para resolver ARN/nome em policies e env vars. */
  s3Buckets: Set<string>;
  /** IDs de Fn.Lambda com eventSources SQS — a role precisa da SQSQueueExecutionRole. */
  sqsEventSourceLambdas: Set<string>;
  /** IDs de Fn.Lambda com eventSources Kinesis — a role precisa da KinesisExecutionRole. */
  kinesisEventSourceLambdas: Set<string>;
  /** IDs de Function.Lambda que têm vpcId definido — precisam de VPCAccessExecutionRole. */
  vpcLambdas: Set<string>;
  /** constructId de Network.LoadBalancer → target group default (1º) para registro de tasks ECS. */
  albDefaultTg: Map<string, { stackName: string; tgLogicalId: string }>;
  /** IDs de Function.Lambda — alvos válidos de rotas de Function.ApiGateway. */
  lambdaConstructs: Set<string>;
  /** vpcId (construct id) → Network.Subnet com public:true que o referenciam (para IGW + rota pública). */
  publicSubnetsByVpc: Map<string, Array<{ id: string; stackName: string }>>;
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
  // O alvo de uma rota TEM que ser uma Function.Lambda. Apontar para um
  // Compute.Container/ECS (ou outro construct) é inválido — API Gateway só
  // integra com Lambda; um container é exposto por Network.LoadBalancer (ALB).
  if (!ctx.lambdaConstructs.has(lambdaId)) {
    throw new Error(`Function.ApiGateway: a rota aponta lambdaId "${lambdaId}", que não é uma Fn.Lambda. API Gateway só integra com Lambda — um Compute.Container/ECS deve ser exposto por um Network.LoadBalancer (ALB), não por API Gateway.`);
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
  // Lambda acionada por SQS precisa de ReceiveMessage/DeleteMessage/GetQueueAttributes
  // — a managed policy do serviço concede exatamente isso (exigido pelo EventSourceMapping).
  if (ctx.sqsEventSourceLambdas.has(lambdaId)) {
    managedPolicies.push('arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole');
  }
  if (ctx.kinesisEventSourceLambdas.has(lambdaId)) {
    managedPolicies.push('arn:aws:iam::aws:policy/service-role/AWSLambdaKinesisExecutionRole');
  }
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
/**
 * Resolve o ARN de uma fila SQS referenciada por id de construct (Messaging.Queue)
 * → Fn::GetAtt local / Fn::ImportValue cross-stack. ARN literal passa inalterado.
 */
/** Normaliza o valor de um rate() do EventBridge: '1 hours'→'1 hour', '5 minute'→'5 minutes'.
 *  A AWS exige singular quando o valor é 1 e plural caso contrário. */
function normalizeRate(rate: string): string {
  const m = /^(\d+)\s+(minute|minutes|hour|hours|day|days)$/i.exec(rate.trim());
  if (!m) return rate;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase().replace(/s$/, '');
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function resolveQueueArn(value: string, ctx: SynthContext): unknown {
  if (value.startsWith('arn:')) return value;
  const ownerStack = ctx.registry.get(value);
  if (!ownerStack) return value;
  const logicalId = value.replace(/[^a-zA-Z0-9]/g, '');
  if (ownerStack === ctx.currentStackName) return { 'Fn::GetAtt': [logicalId, 'Arn'] };
  return { 'Fn::ImportValue': `${ownerStack}-${value}-Arn` };
}

function resolvePolicyResource(value: string, ctx: SynthContext): unknown {
  // Referência a ARN de bucket S3, aceitando sufixo de path e ".arn" opcional:
  // "UploadsBucket.arn/*", "UploadsBucket/*", "UploadsBucket.arn", "UploadsBucket".
  const s3Match = /^([^./]+)(?:\.arn)?(\/.*)?$/i.exec(value);
  if (s3Match) {
    const id = s3Match[1];
    const suffix = s3Match[2] ?? '';
    const reg = ctx.registry.get(id);
    if (reg && ctx.s3Buckets.has(id)) {
      const logicalId = id.replace(/[^a-zA-Z0-9]/g, '');
      const bucketArn = reg === ctx.currentStackName
        ? { 'Fn::GetAtt': [logicalId, 'Arn'] }
        : { 'Fn::ImportValue': `${reg}-${id}-Arn` };
      // Sem sufixo → o próprio ARN; com sufixo (ex: /*) → Fn::Sub concatenando.
      if (!suffix) return bucketArn;
      return { 'Fn::Sub': [`\${BArn}${suffix}`, { BArn: bucketArn }] };
    }
  }
  // Padrão "<id>.SecretArn"/".Arn"/".QueueArn"/".TopicArn" (Secret.Vault, filas, tópicos).
  const match = /^([^.]+)\.(SecretArn|Arn|QueueArn|TopicArn)$/.exec(value);
  if (match && ctx.registry.has(match[1])) {
    // SecretArn resolve pelo mesmo caminho das env vars — cobre tanto Secret.Vault
    // (o recurso É o secret) quanto Database.SQL (sub-recurso `${id}Secret`, export
    // `-SecretArn`). resolveQueueArn produziria `-Arn`, que não existe para o DB.
    if (match[2] === 'SecretArn') return resolveEnvVarValue(`${match[1]}.SecretArn`, ctx);
    return resolveQueueArn(match[1], ctx); // GetAtt Arn / ImportValue-Arn (fila e tópico exportam "-Arn")
  }
  // Id de construct cru (ex: 'TaskQueue' em resources) → ARN.
  if (ctx.registry.has(value)) {
    if (ctx.secretVaults.has(value)) return resolveEnvVarValue(`${value}.SecretArn`, ctx);
    return resolveQueueArn(value, ctx);
  }
  return value;
}

function resolveEnvVarValue(value: string, ctx: SynthContext): unknown {
  const match = /^([^.]+)\.(Endpoint|Port|SecretArn|Username|Password|QueueUrl|QueueArn|Arn|arn|TopicArn|BucketName|Name|name)$/.exec(value);
  if (!match) return value;
  const [, constructId, fieldRaw] = match;
  const field = fieldRaw === 'arn' ? 'Arn' : fieldRaw === 'name' ? 'Name' : fieldRaw;
  const ownerStack = ctx.registry.get(constructId);
  if (!ownerStack) return value;
  const logicalId = constructId.replace(/[^a-zA-Z0-9]/g, '');

  // BucketName/Name: Ref de AWS::S3::Bucket retorna o nome real (com sufixo CFN).
  if (field === 'BucketName' || field === 'Name') {
    if (ownerStack === ctx.currentStackName) return { Ref: logicalId };
    return { 'Fn::ImportValue': `${ownerStack}-${constructId}-Name` };
  }

  // SQS/SNS: QueueUrl = Ref (a URL da fila); QueueArn/Arn/TopicArn = GetAtt Arn.
  if (field === 'QueueUrl') {
    if (ownerStack === ctx.currentStackName) return { Ref: logicalId };
    return { 'Fn::ImportValue': `${ownerStack}-${constructId}-QueueUrl` };
  }
  if (field === 'QueueArn' || field === 'Arn' || field === 'TopicArn') {
    if (ownerStack === ctx.currentStackName) return { 'Fn::GetAtt': [logicalId, field === 'TopicArn' ? 'TopicArn' : 'Arn'] };
    return { 'Fn::ImportValue': `${ownerStack}-${constructId}-Arn` };
  }

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

/**
 * Resolve o ARN do target group default de um Network.LoadBalancer para registrar
 * tasks de um Compute.Container (ECS Service LoadBalancers). Aceita
 * "<lbId>.TargetGroupArn" ou "<lbId>" cru. Mesma stack → Fn::GetAtt do TG;
 * cross-stack → Fn::ImportValue do export "<stack>-<lbId>-TargetGroupArn".
 * ARN literal passa inalterado.
 */
/**
 * Resolve uma ação de alarme (AlarmActions/OKActions) que referencia um
 * Messaging.Topic: aceita o id ('AlertsTopic'), 'AlertsTopic.TopicArn'/'.arn'
 * ou um ARN literal. Same-stack → { Ref } (SNS Ref retorna o ARN); cross-stack
 * → ImportValue do export '-Arn'. Entradas não-string (ex: `.arn` undefined que
 * a IA às vezes gera) são descartadas para não virarem null no template.
 */
function resolveAlarmAction(value: unknown, ctx: SynthContext): unknown | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.startsWith('arn:')) return value;
  const id = value.replace(/\.(TopicArn|arn|Arn)$/, '');
  const ownerStack = ctx.registry.get(id);
  if (!ownerStack) return value; // ref desconhecida — deixa como veio (visível no deploy)
  const logicalId = id.replace(/[^a-zA-Z0-9]/g, '');
  if (ownerStack === ctx.currentStackName) return { Ref: logicalId };
  return { 'Fn::ImportValue': `${ownerStack}-${id}-Arn` };
}

function resolveTargetGroupArn(value: string, ctx: SynthContext): unknown {
  if (value.startsWith('arn:')) return value;
  const lbId = value.replace(/\.TargetGroupArn$/, '');
  const tg = ctx.albDefaultTg.get(lbId);
  if (!tg) return value; // LB sem target group declarado — deixa como veio (erro visível no synth/deploy)
  if (tg.stackName === ctx.currentStackName) return { 'Fn::GetAtt': [tg.tgLogicalId, 'TargetGroupArn'] };
  return { 'Fn::ImportValue': `${tg.stackName}-${lbId}-TargetGroupArn` };
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
      const logGroupLogicalId = `${logicalId}LogGroup`;
      const environment = props.environment as Record<string, string> | undefined;
      const subnetIds = (props.subnetIds as string[]) ?? [];

      const entries: Array<[string, CloudFormationResource]> = [
        // Log group do awslogs: o driver do Fargate NÃO cria o grupo (a execution
        // role padrão só tem CreateLogStream/PutLogEvents, não CreateLogGroup) — sem
        // ele a task falha em "log group does not exist" e o serviço nunca estabiliza.
        [logGroupLogicalId, {
          Type: 'AWS::Logs::LogGroup',
          Properties: { LogGroupName: `/ecs/${construct.id}`, RetentionInDays: 7 },
        }],
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
        const hasLb = typeof props.targetGroupArn === 'string';
        const serviceProps: Record<string, unknown> = {
          ServiceName: construct.id,
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
        };
        // O Service depende do log group existir antes de iniciar as tasks.
        const serviceDependsOn: string[] = [logGroupLogicalId];
        // Registra as tasks no target group do ALB (só faz sentido com um container port).
        if (hasLb && props.port) {
          const lbId = (props.targetGroupArn as string).replace(/\.TargetGroupArn$/, '');
          serviceProps.LoadBalancers = [{
            TargetGroupArn: resolveTargetGroupArn(props.targetGroupArn as string, ctx),
            ContainerName: construct.id,
            ContainerPort: props.port,
          }];
          // Dá tempo do container passar no health check do ALB antes do ECS matar a task.
          serviceProps.HealthCheckGracePeriodSeconds = 60;
          // O ECS exige o target group JÁ associado a um listener do ALB. Same-stack,
          // força a ordem: o Service depende do 1º listener do LB (cross-stack o
          // ImportValue do TG já garante que a stack do ALB subiu antes).
          const tg = ctx.albDefaultTg.get(lbId);
          if (tg && tg.stackName === ctx.currentStackName) {
            serviceDependsOn.push(`${lbId.replace(/[^a-zA-Z0-9]/g, '')}Listener1`);
          }
        }
        entries.push([svcLogicalId, {
          Type: 'AWS::ECS::Service',
          DependsOn: serviceDependsOn,
          Properties: serviceProps,
        }]);

        // Autoscaling de tasks Fargate (ApplicationAutoScaling) — min/maxCapacity.
        if (typeof props.minCapacity === 'number' && typeof props.maxCapacity === 'number') {
          const targetLogicalId = `${logicalId}ScalableTarget`;
          entries.push([targetLogicalId, {
            Type: 'AWS::ApplicationAutoScaling::ScalableTarget',
            DependsOn: [svcLogicalId],
            Properties: {
              MinCapacity: props.minCapacity as number,
              MaxCapacity: props.maxCapacity as number,
              // ResourceId = service/<clusterName>/<serviceName>; ambos = construct.id.
              ResourceId: `service/${construct.id}/${construct.id}`,
              ScalableDimension: 'ecs:service:DesiredCount',
              ServiceNamespace: 'ecs',
              RoleARN: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/AWSServiceRoleForApplicationAutoScaling_ECSService' },
            },
          }]);
          entries.push([`${logicalId}ScalingPolicy`, {
            Type: 'AWS::ApplicationAutoScaling::ScalingPolicy',
            Properties: {
              PolicyName: `${construct.id}-cpu-scaling`,
              PolicyType: 'TargetTrackingScaling',
              ScalingTargetId: { Ref: targetLogicalId },
              TargetTrackingScalingPolicyConfiguration: {
                PredefinedMetricSpecification: { PredefinedMetricType: 'ECSServiceAverageCPUUtilization' },
                TargetValue: (props.cpuTargetPercent as number) ?? 50,
              },
            },
          }]);
        }
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
          ...((props.cors as Array<Record<string, unknown>> | undefined)?.length ? {
            CorsConfiguration: {
              CorsRules: (props.cors as Array<Record<string, unknown>>).map(c => ({
                AllowedMethods: c.allowedMethods,
                AllowedOrigins: (c.allowedOrigins as string[]) ?? ['*'],
                AllowedHeaders: (c.allowedHeaders as string[]) ?? ['*'],
                ...(c.maxAgeSeconds !== undefined ? { MaxAge: c.maxAgeSeconds } : {}),
              })),
            },
          } : {}),
        },
      }]];

      // Notificações S3 → Lambda (ObjectCreated etc). Gera a NotificationConfiguration
      // no bucket + uma Lambda::Permission por Lambda. Usa SourceAccount (não SourceArn)
      // na permission pra NÃO referenciar o bucket e evitar a dependência circular
      // clássica do S3; o bucket faz DependsOn das permissions pra S3 aceitar a config.
      const notifications = (props.eventNotifications as Array<Record<string, unknown>> | undefined) ?? [];
      if (notifications.length > 0) {
        const lambdaConfigs: Array<Record<string, unknown>> = [];
        const dependsOn: string[] = [];
        notifications.forEach((n, ni) => {
          const lambdaId = n.lambdaId as string;
          const fnArn = resolveLambdaArnRef(lambdaId, ctx);
          const events = (n.events as string[] | undefined) ?? ['s3:ObjectCreated:*'];
          const filterRules: Array<Record<string, string>> = [];
          if (n.prefix) filterRules.push({ Name: 'prefix', Value: n.prefix as string });
          if (n.suffix) filterRules.push({ Name: 'suffix', Value: n.suffix as string });
          for (const ev of events) {
            lambdaConfigs.push({
              Event: ev,
              Function: fnArn,
              ...(filterRules.length > 0 ? { Filter: { S3Key: { Rules: filterRules } } } : {}),
            });
          }
          const permId = `${logicalId}InvokePermission${ni}`;
          entries.push([permId, {
            Type: 'AWS::Lambda::Permission',
            Properties: {
              Action: 'lambda:InvokeFunction',
              FunctionName: fnArn,
              Principal: 's3.amazonaws.com',
              SourceAccount: { Ref: 'AWS::AccountId' },
            },
          }]);
          dependsOn.push(permId);
        });
        const bucketRes = entries[0][1];
        (bucketRes.Properties as Record<string, unknown>).NotificationConfiguration = { LambdaConfigurations: lambdaConfigs };
        bucketRes.DependsOn = dependsOn;
      }

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
    case 'Network.VPC': {
      const vpcEntries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::EC2::VPC',
        Properties: {
          CidrBlock: (props.cidr as string) ?? '10.0.0.0/16',
          EnableDnsHostnames: true,
          EnableDnsSupport: true,
          Tags: [{ Key: 'Name', Value: logicalId }],
        },
      }]];

      // Subnets públicas explícitas (Network.Subnet public:true) na MESMA stack
      // precisam de Internet Gateway + route table pública com rota 0.0.0.0/0,
      // senão não têm saída pra internet (ALB internet-facing falha com "VPC has
      // no internet gateway" e tasks/instâncias com IP público não alcançam nada).
      const publicSubnets = (ctx.publicSubnetsByVpc.get(construct.id) ?? [])
        .filter(s => s.stackName === ctx.currentStackName);
      if (publicSubnets.length > 0) {
        const igwId = `${logicalId}IGW`;
        vpcEntries.push([igwId, { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: [{ Key: 'Name', Value: igwId }] } }]);
        vpcEntries.push([`${igwId}Attachment`, {
          Type: 'AWS::EC2::VPCGatewayAttachment',
          Properties: { VpcId: { Ref: logicalId }, InternetGatewayId: { Ref: igwId } },
        }]);
        const pubRTId = `${logicalId}PublicRT`;
        vpcEntries.push([pubRTId, { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: { Ref: logicalId }, Tags: [{ Key: 'Name', Value: pubRTId }] } }]);
        vpcEntries.push([`${pubRTId}DefaultRoute`, {
          Type: 'AWS::EC2::Route',
          DependsOn: [`${igwId}Attachment`],
          Properties: { RouteTableId: { Ref: pubRTId }, DestinationCidrBlock: '0.0.0.0/0', GatewayId: { Ref: igwId } },
        }]);
        publicSubnets.forEach((s, i) => {
          vpcEntries.push([`${logicalId}PublicRTAssoc${i}`, {
            Type: 'AWS::EC2::SubnetRouteTableAssociation',
            Properties: { SubnetId: { Ref: s.id.replace(/[^a-zA-Z0-9]/g, '') }, RouteTableId: { Ref: pubRTId } },
          }]);
        });
      }
      return vpcEntries;
    }

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

    case 'Network.VpcEndpoint': {
      // Gateway VPC Endpoint (DynamoDB/S3): dá a uma Lambda em subnet privada
      // acesso ao serviço SEM NAT (grátis). Cria uma route table, associa as
      // subnets privadas a ela e pendura um endpoint Gateway por serviço.
      const services = (props.services as string[]) ?? [];
      const subnetIds = (props.subnetIds as string[]) ?? [];
      const entries: Array<[string, CloudFormationResource]> = [];
      const rtId = `${logicalId}RouteTable`;
      entries.push([rtId, {
        Type: 'AWS::EC2::RouteTable',
        Properties: {
          VpcId: resolveVpcId(props.vpcId as string, ctx),
          Tags: [{ Key: 'Name', Value: rtId }],
        },
      }]);
      subnetIds.forEach((sid, i) => {
        entries.push([`${logicalId}RTAssoc${i}`, {
          Type: 'AWS::EC2::SubnetRouteTableAssociation',
          Properties: {
            SubnetId: resolveSubnetId(sid, ctx),
            RouteTableId: { Ref: rtId },
          },
        }]);
      });
      for (const svc of services) {
        const epId = `${logicalId}${svc.charAt(0).toUpperCase()}${svc.slice(1)}Endpoint`;
        entries.push([epId, {
          Type: 'AWS::EC2::VPCEndpoint',
          Properties: {
            ServiceName: { 'Fn::Sub': `com.amazonaws.\${AWS::Region}.${svc}` },
            VpcId: resolveVpcId(props.vpcId as string, ctx),
            VpcEndpointType: 'Gateway',
            RouteTableIds: [{ Ref: rtId }],
          },
        }]);
      }
      return entries;
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
            const base = {
              IpProtocol: r.protocol as string,
              FromPort: r.fromPort as number,
              ToPort: r.toPort as number,
              ...(r.description ? { Description: r.description } : {}),
            };
            // Fonte = outro SG (padrão correto p/ "acesso só do SG X") tem
            // precedência sobre CIDR — CloudFormation exige um OU outro.
            if (r.sourceSecurityGroupId) {
              return { ...base, SourceSecurityGroupId: resolveSecurityGroupId(r.sourceSecurityGroupId as string, ctx) };
            }
            if (r.cidr === undefined) {
              console.warn(`[aws] Security group rule sem CIDR nem sourceSecurityGroupId; usando 0.0.0.0/0 (${construct.id} ingress[${i}])`);
            }
            return { ...base, CidrIp: (r.cidr as string) ?? '0.0.0.0/0' };
          }),
          SecurityGroupEgress: egress.length > 0
            ? egress.map(r => {
                const base = {
                  IpProtocol: r.protocol as string,
                  FromPort: r.fromPort as number,
                  ToPort: r.toPort as number,
                  ...(r.description ? { Description: r.description } : {}),
                };
                if (r.destinationSecurityGroupId) {
                  return { ...base, DestinationSecurityGroupId: resolveSecurityGroupId(r.destinationSecurityGroupId as string, ctx) };
                }
                return { ...base, CidrIp: (r.cidr as string) ?? '0.0.0.0/0' };
              })
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
          Rules: rules.map((r, i) => {
            const actionKey = (r.action as string) === 'block' ? 'Block' : (r.action as string) === 'count' ? 'Count' : 'Allow';
            // Managed rule group → OverrideAction (NÃO Action; o WAFv2 rejeita Action
            // num ManagedRuleGroupStatement). Rate-based/ByteMatch → Action normal.
            const statement = r.managedGroup
              ? { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: r.managedGroup as string } }
              : r.rateLimit
                ? { RateBasedStatement: { Limit: r.rateLimit as number, AggregateKeyType: 'IP' } }
                : {
                    ByteMatchStatement: {
                      SearchString: ((r.matchValues as string[]) ?? ['BadBot'])[0],
                      FieldToMatch: { SingleHeader: { Name: 'user-agent' } },
                      TextTransformations: [{ Priority: 0, Type: 'NONE' }],
                      PositionalConstraint: 'CONTAINS',
                    },
                  };
            return {
              Name: (r.name as string) ?? `rule-${i}`,
              Priority: (r.priority as number) ?? (i + 1),
              ...(r.managedGroup
                ? { OverrideAction: { None: {} } }
                : { Action: { [r.rateLimit ? (actionKey === 'Allow' ? 'Block' : actionKey) : actionKey]: {} } }),
              VisibilityConfig: {
                SampledRequestsEnabled: true,
                CloudWatchMetricsEnabled: true,
                MetricName: ((r.name as string) ?? `rule${i}`).replace(/[^a-zA-Z0-9]/g, ''),
              },
              Statement: statement,
            };
          }),
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

      // O 1º target group é o "default": listeners não-redirect fazem forward
      // pra ele e o ECS Service registra as tasks nele (ver resolveTargetGroupArn).
      let defaultTgId: string | undefined;
      for (const tg of targetGroups) {
        const tgId = `${logicalId}TG${(tg.name as string).replace(/[^a-zA-Z0-9]/g, '')}`;
        if (!defaultTgId) defaultTgId = tgId;
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

      let listenerIdx = 0;
      for (const l of listeners) {
        // HTTPS/TLS sem certificado não sobe (CFN exige Certificates) — pula com aviso
        // em vez de derrubar o deploy inteiro. Use certificateArn (ACM) para HTTPS.
        if ((l.protocol === 'HTTPS' || l.protocol === 'TLS') && !l.certificateArn) {
          console.warn(`[aws] LoadBalancer "${construct.id}": listener ${l.protocol}:${l.port} sem certificateArn — ignorado (HTTPS exige um certificado ACM).`);
          continue;
        }
        listenerIdx++;
        // forward → target group default quando existe; senão redirect ou 404.
        const defaultActions = (l.redirectToHttps as boolean)
          ? [{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } }]
          : defaultTgId
            ? [{ Type: 'forward', TargetGroupArn: { Ref: defaultTgId } }]
            : [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404', MessageBody: 'Not found', ContentType: 'text/plain' } }];
        entries.push([`${logicalId}Listener${listenerIdx}`, {
          Type: 'AWS::ElasticLoadBalancingV2::Listener',
          Properties: {
            LoadBalancerArn: { Ref: logicalId },
            Port: l.port as number,
            Protocol: l.protocol as string,
            ...(l.certificateArn ? { Certificates: [{ CertificateArn: l.certificateArn }] } : {}),
            DefaultActions: defaultActions,
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
      const redisSubnetIds = props.subnetIds as string[] | undefined;
      const redisEntries: Array<[string, CloudFormationResource]> = [];

      // Cria o CacheSubnetGroup a partir de subnetIds (como Memcached). Sem isso,
      // passar um id de subnet direto em CacheSubnetGroupName falha no deploy —
      // ElastiCache exige um SubnetGroup, não uma subnet.
      let cacheSubnetGroupName: unknown;
      if (redisSubnetIds && redisSubnetIds.length > 0) {
        const subnetGroupId = `${logicalId}SubnetGroup`;
        redisEntries.push([subnetGroupId, {
          Type: 'AWS::ElastiCache::SubnetGroup',
          Properties: {
            Description: `Subnet group para ${construct.id}`,
            SubnetIds: redisSubnetIds.map(id => resolveSubnetId(id, ctx)),
          },
        }]);
        cacheSubnetGroupName = { Ref: subnetGroupId };
      } else if (props.subnetGroupName) {
        cacheSubnetGroupName = props.subnetGroupName;
      }

      redisEntries.push([logicalId, {
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
          ...(cacheSubnetGroupName ? { CacheSubnetGroupName: cacheSubnetGroupName } : {}),
          ...(props.securityGroupIds ? { SecurityGroupIds: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
        },
      }]);
      return redisEntries;
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

      // Event source mappings: aciona a Lambda a partir de filas SQS ou streams Kinesis.
      const eventSources = (props.eventSources as Array<Record<string, unknown>> | undefined) ?? [];
      eventSources.forEach((es, i) => {
        const esmId = `${logicalId}EventSource${i + 1}`;
        if (es.streamId) {
          // Kinesis: exige StartingPosition; suporta BisectBatchOnFunctionError e
          // batchSize maior (até 10000). O ARN do stream resolve como os demais (-Arn).
          entries.push([esmId, {
            Type: 'AWS::Lambda::EventSourceMapping',
            Properties: {
              EventSourceArn: resolveQueueArn(es.streamId as string, ctx),
              FunctionName: { Ref: logicalId },
              BatchSize: (es.batchSize as number) ?? 100,
              StartingPosition: (es.startingPosition as string) ?? 'LATEST',
              ...(es.bisectBatchOnFunctionError !== undefined ? { BisectBatchOnFunctionError: es.bisectBatchOnFunctionError } : {}),
              ...(es.maxBatchingWindowSeconds !== undefined ? { MaximumBatchingWindowInSeconds: es.maxBatchingWindowSeconds } : {}),
            },
          }]);
          return;
        }
        entries.push([esmId, {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            EventSourceArn: resolveQueueArn(es.queueId as string, ctx),
            FunctionName: { Ref: logicalId },
            BatchSize: (es.batchSize as number) ?? 10,
            // BisectBatchOnFunctionError NÃO é suportado para SQS (só Kinesis/DynamoDB
            // streams) — ignorado de propósito para não quebrar o deploy.
            ...(es.maxBatchingWindowSeconds !== undefined ? { MaximumBatchingWindowInSeconds: es.maxBatchingWindowSeconds } : {}),
          },
        }]);
      });
      return entries;
    }

    case 'Function.ApiGateway': {
      const apigwType = (props.type as string) ?? 'HTTP';
      const routes = (props.routes as Array<Record<string, unknown>>) ?? [];
      // REST (v1) só aceita nome de stage [a-zA-Z0-9_] — '$default' é exclusivo do
      // HTTP API (v2). Default por tipo pra não quebrar o deploy do REST.
      const stageName = (props.stageName as string) ?? (apigwType === 'REST' ? 'prod' : '$default');
      const authorizerLambdaId = props.authorizerLambdaId as string | undefined;
      const authorizerId = authorizerLambdaId ? `${logicalId}Authorizer` : undefined;
      // Authorizer por rota (route.authorizerLambdaId) — cada Lambda authorizer
      // distinta vira um AWS::Gateway::Authorizer. Combinado com o do gateway.
      // Uma rota com authType 'NONE' fica pública mesmo se o gateway tem authorizer.
      const routeAuthorizerIds = new Map<string, string>(); // lambdaId → authorizerLogicalId
      if (authorizerLambdaId) routeAuthorizerIds.set(authorizerLambdaId, authorizerId!);
      for (const r of routes) {
        const ra = r.authorizerLambdaId as string | undefined;
        if (ra && !routeAuthorizerIds.has(ra)) {
          routeAuthorizerIds.set(ra, `${logicalId}${ra.replace(/[^a-zA-Z0-9]/g, '')}Authorizer`);
        }
      }
      // Toda Lambda referenciada (rotas + authorizers) precisa de uma
      // AWS::Lambda::Permission liberando o API Gateway a invocá-la.
      const lambdaIdsNeedingPermission = new Set<string>();
      for (const la of routeAuthorizerIds.keys()) lambdaIdsNeedingPermission.add(la);
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

        // Um AWS::ApiGateway::Authorizer por Lambda authorizer distinta.
        for (const [la, authLogicalId] of routeAuthorizerIds) {
          entries.push([authLogicalId, {
            Type: 'AWS::ApiGateway::Authorizer',
            Properties: {
              RestApiId: { Ref: logicalId },
              Type: 'REQUEST',
              Name: `${props.name as string}-${la}`,
              AuthorizerUri: buildInvocationUri(la, ctx),
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
          // Auth por rota (mesma lógica do HTTP): 'NONE' força pública.
          const routeAuthLambda = (r.authType === 'NONE')
            ? undefined
            : (r.authorizerLambdaId as string | undefined) ?? authorizerLambdaId;
          const routeAuthId = routeAuthLambda ? routeAuthorizerIds.get(routeAuthLambda) : undefined;

          entries.push([methodLogicalId, {
            Type: 'AWS::ApiGateway::Method',
            Properties: {
              RestApiId: { Ref: logicalId },
              ResourceId: resourceRef,
              HttpMethod: method,
              AuthorizationType: routeAuthId ? 'CUSTOM' : 'NONE',
              ...(routeAuthId ? { AuthorizerId: { Ref: routeAuthId } } : {}),
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

        // Associa um Network.WAF (REGIONAL) ao stage do REST API via WAFv2
        // WebACLAssociation (o WAF não é uma prop do stage; é um recurso à parte).
        if (props.wafAclId) {
          const wafId = props.wafAclId as string;
          const wafStack = ctx.registry.get(wafId);
          const wafArn = wafStack
            ? (wafStack === ctx.currentStackName
                ? { 'Fn::GetAtt': [wafId.replace(/[^a-zA-Z0-9]/g, ''), 'Arn'] }
                : { 'Fn::ImportValue': `${wafStack}-${wafId}-Arn` })
            : wafId; // ARN literal
          entries.push([`${logicalId}WafAssociation`, {
            Type: 'AWS::WAFv2::WebACLAssociation',
            DependsOn: [`${logicalId}Stage`],
            Properties: {
              ResourceArn: { 'Fn::Sub': [`arn:aws:apigateway:\${AWS::Region}::/restapis/\${ApiId}/stages/${stageName}`, { ApiId: { Ref: logicalId } }] },
              WebACLArn: wafArn,
            },
          }]);
        }
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

        // Um AWS::ApiGatewayV2::Authorizer por Lambda authorizer distinta.
        for (const [la, authLogicalId] of routeAuthorizerIds) {
          entries.push([authLogicalId, {
            Type: 'AWS::ApiGatewayV2::Authorizer',
            Properties: {
              ApiId: { Ref: logicalId },
              AuthorizerType: 'REQUEST',
              Name: `${props.name as string}-${la}`,
              AuthorizerUri: buildInvocationUri(la, ctx),
              AuthorizerPayloadFormatVersion: '2.0',
              IdentitySource: ['$request.header.Authorization'],
              EnableSimpleResponses: true,
            },
          }]);
        }

        for (const r of routes) {
          const routeId = `${logicalId}${(r.method as string)}${(r.path as string).replace(/[^a-zA-Z0-9]/g, '')}Route`;
          // Auth por rota: authType 'NONE' força pública; senão usa o authorizer
          // da rota (route.authorizerLambdaId) ou o do gateway como fallback.
          const routeAuthLambda = (r.authType === 'NONE')
            ? undefined
            : (r.authorizerLambdaId as string | undefined) ?? authorizerLambdaId;
          const routeAuthId = routeAuthLambda ? routeAuthorizerIds.get(routeAuthLambda) : undefined;
          entries.push([routeId, {
            Type: 'AWS::ApiGatewayV2::Route',
            Properties: {
              ApiId: { Ref: logicalId },
              RouteKey: `${r.method} ${r.path}`,
              ...(r.lambdaId ? { Target: { 'Fn::Sub': `integrations/\${${routeId}Integration}` } } : {}),
              ...(routeAuthId ? { AuthorizationType: 'CUSTOM', AuthorizerId: { Ref: routeAuthId } } : {}),
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
      // Lambda acionada por SQS: garante as permissões do EventSourceMapping
      // (ReceiveMessage/DeleteMessage/GetQueueAttributes) via managed policy.
      if (attachType === 'lambda' && ctx.sqsEventSourceLambdas.has(props.attachTo as string)) {
        managedPolicies.push('arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole');
      }
      if (attachType === 'lambda' && ctx.kinesisEventSourceLambdas.has(props.attachTo as string)) {
        managedPolicies.push('arn:aws:iam::aws:policy/service-role/AWSLambdaKinesisExecutionRole');
      }

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
        const ruleLogicalId = `${logicalId}${ruleName}Rule`;
        const pattern: Record<string, unknown> = {};
        if (r.source) pattern['source'] = r.source;
        if (r.detailTypes) pattern['detail-type'] = r.detailTypes;

        // Agendamento: cron('...') ou rate('...'). CloudFormation exige o wrapper.
        const scheduleExpression = r.cron
          ? `cron(${r.cron})`
          : r.rate
          ? `rate(${normalizeRate(r.rate as string)})`
          : undefined;

        // Target: resolve targetLambdaId (ou targetArn com id) → ARN da Lambda.
        const targetLambdaId = (r.targetLambdaId as string | undefined)
          ?? (typeof r.targetArn === 'string' && ctx.registry.has(r.targetArn) ? (r.targetArn as string) : undefined);
        const targetArnValue = targetLambdaId
          ? resolveLambdaArnRef(targetLambdaId, ctx)
          : (r.targetArn as string | undefined);

        const eventBusName = busName !== 'default' ? { Ref: `${logicalId}Bus` } : 'default';

        entries.push([ruleLogicalId, {
          Type: 'AWS::Events::Rule',
          Properties: {
            Name: r.name as string,
            // ScheduleExpression e EventBusName custom são mutuamente exclusivos
            // com EventPattern só quando faz sentido: agendada não usa pattern.
            ...(scheduleExpression ? { ScheduleExpression: scheduleExpression } : { EventBusName: eventBusName, EventPattern: pattern }),
            State: 'ENABLED',
            ...(targetArnValue ? { Targets: [{ Id: `${ruleName}Target`, Arn: targetArnValue }] } : {}),
          },
        }]);

        // Permissão para o EventBridge invocar a Lambda alvo.
        if (targetLambdaId) {
          entries.push([`${ruleLogicalId}Permission`, {
            Type: 'AWS::Lambda::Permission',
            Properties: {
              Action: 'lambda:InvokeFunction',
              FunctionName: resolveLambdaArnRef(targetLambdaId, ctx),
              Principal: 'events.amazonaws.com',
              SourceArn: { 'Fn::GetAtt': [ruleLogicalId, 'Arn'] },
            },
          }]);
        }
      }

      return entries;
    }

    // ── Workflow ──────────────────────────────────────────────────────────
    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      // Um Task cujo `resource` é o id de uma Fn.Lambda precisa do ARN real no
      // Resource (Step Functions rejeita um id cru). Como a DefinitionString usa
      // Fn::Sub, cada ARN vira uma variável ${...} resolvida no 2º arg do Sub.
      const subVars: Record<string, unknown> = {};
      const definition = {
        Comment: (props.description as string) ?? `Workflow ${construct.id}`,
        StartAt: (steps[0]?.name as string) ?? 'Start',
        States: Object.fromEntries(steps.map((s, i) => {
          const stateType = (s.type as string) ?? 'Task';
          const isTask = stateType === 'Task';
          const isWait = stateType === 'Wait';
          const rawResource = (s.resource as string) ?? '';
          // Resolve o id de uma Fn.Lambda pro ARN via variável do Fn::Sub.
          let arnRef = rawResource;
          if (isTask && rawResource && !rawResource.startsWith('arn:') && ctx.lambdaConstructs.has(rawResource)) {
            const varName = `${(s.name as string).replace(/[^a-zA-Z0-9]/g, '')}Arn`;
            subVars[varName] = resolveLambdaArnRef(rawResource, ctx);
            arnRef = `\${${varName}}`;
          }
          // waitForToken: Task de callback — invoca a Lambda passando o task token
          // e PAUSA até SendTaskSuccess/Failure. Usa a integração otimizada
          // lambda:invoke.waitForTaskToken.
          const taskProps = isTask
            ? (s.waitForToken
                ? {
                    Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
                    Parameters: {
                      FunctionName: arnRef,
                      'Payload': { 'taskToken.$': '$$.Task.Token', 'input.$': '$' },
                    },
                  }
                : { Resource: arnRef })
            : {};
          return [s.name as string, {
            Type: stateType,
            ...taskProps,
            // Wait exige Seconds/Timestamp — sem isso a definição é inválida.
            ...(isWait ? { Seconds: (s.seconds as number) ?? 30 } : {}),
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
            DefinitionString: Object.keys(subVars).length > 0
              ? { 'Fn::Sub': [JSON.stringify(definition), subVars] }
              : { 'Fn::Sub': JSON.stringify(definition) },
            RoleArn: { 'Fn::GetAtt': [roleLogicalId, 'Arn'] },
          },
        }],
      ];
    }

    // ── Messaging ─────────────────────────────────────────────────────────
    case 'Messaging.Stream': {
      return [[logicalId, {
        Type: 'AWS::Kinesis::Stream',
        Properties: {
          Name: construct.id,
          ShardCount: (props.shards as number) ?? 1,
          RetentionPeriodHours: (props.retentionHours as number) ?? 24,
          ...(props.encrypted ? { StreamEncryption: { EncryptionType: 'KMS', KeyId: 'alias/aws/kinesis' } } : {}),
        },
      }]];
    }

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
          ...(props.dlqArn ? { RedrivePolicy: { deadLetterTargetArn: resolveQueueArn(props.dlqArn as string, ctx), maxReceiveCount: (props.maxReceiveCount as number) ?? 3 } } : {}),
        },
      }]];
    }

    case 'Messaging.Topic': {
      const fifo = (props.fifo as boolean) ?? false;
      const subscriptions = (props.subscriptions as Array<Record<string, unknown>>) ?? [];
      const topicEntries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::SNS::Topic',
        Properties: {
          TopicName: fifo ? `${construct.id}.fifo` : construct.id,
          DisplayName: (props.displayName as string) ?? construct.id,
          ...(fifo ? { FifoTopic: true } : {}),
          ...(props.encrypted ? { KmsMasterKeyId: 'alias/aws/sns' } : {}),
        },
      }]];

      // Cada subscription vira um AWS::SNS::Subscription. Para SQS, resolve o
      // ARN da fila (por id de construct), aplica filterPolicy e cria a
      // SQS::QueuePolicy que autoriza o SNS a publicar na fila (fan-out).
      const subscribedQueues: string[] = [];
      subscriptions.forEach((s, i) => {
        const protocol = s.protocol as string;
        const endpointRaw = s.endpoint as string;
        // sqs/lambda: endpoint pode ser id de construct → resolve ARN.
        const isConstructId = (protocol === 'sqs' || protocol === 'lambda') && ctx.registry.has(endpointRaw);
        const endpoint = isConstructId
          ? (protocol === 'sqs' ? resolveQueueArn(endpointRaw, ctx) : resolveLambdaArnRef(endpointRaw, ctx))
          : endpointRaw;
        const subId = `${logicalId}Sub${i + 1}`;
        topicEntries.push([subId, {
          Type: 'AWS::SNS::Subscription',
          Properties: {
            TopicArn: { Ref: logicalId },
            Protocol: protocol,
            Endpoint: endpoint,
            ...(protocol === 'sqs' ? { RawMessageDelivery: true } : {}),
            ...(s.filterPolicy ? { FilterPolicy: s.filterPolicy } : {}),
          },
        }]);
        if (protocol === 'sqs' && isConstructId) subscribedQueues.push(endpointRaw);
        // SNS → Lambda: a Subscription só entrega se a Lambda autorizar o SNS a
        // invocá-la. Sem essa permission a assinatura não confirma / não dispara.
        if (protocol === 'lambda' && isConstructId) {
          topicEntries.push([`${logicalId}InvokeLambda${i + 1}`, {
            Type: 'AWS::Lambda::Permission',
            Properties: {
              Action: 'lambda:InvokeFunction',
              FunctionName: endpoint,
              Principal: 'sns.amazonaws.com',
              SourceArn: { Ref: logicalId },
            },
          }]);
        }
      });

      // SQS::QueuePolicy: autoriza o SNS a enviar mensagens para cada fila inscrita.
      subscribedQueues.forEach(qId => {
        const qLogical = qId.replace(/[^a-zA-Z0-9]/g, '');
        topicEntries.push([`${qLogical}SnsPolicy`, {
          Type: 'AWS::SQS::QueuePolicy',
          Properties: {
            Queues: [{ Ref: qLogical }],
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [{
                Effect: 'Allow',
                Principal: { Service: 'sns.amazonaws.com' },
                Action: 'sqs:SendMessage',
                Resource: resolveQueueArn(qId, ctx),
                Condition: { ArnEquals: { 'aws:SourceArn': { Ref: logicalId } } },
              }],
            },
          },
        }]);
      });

      return topicEntries;
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
          ...((() => {
            const acts = ((props.alarmActions as unknown[]) ?? []).map(a => resolveAlarmAction(a, ctx)).filter(a => a !== undefined);
            return acts.length > 0 ? { AlarmActions: acts } : {};
          })()),
          ...((() => {
            const acts = ((props.okActions as unknown[]) ?? []).map(a => resolveAlarmAction(a, ctx)).filter(a => a !== undefined);
            return acts.length > 0 ? { OKActions: acts } : {};
          })()),
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
  const s3Buckets = new Set<string>();
  const sqsEventSourceLambdas = new Set<string>();
  const kinesisEventSourceLambdas = new Set<string>();
  const albDefaultTg = new Map<string, { stackName: string; tgLogicalId: string }>();
  const lambdaConstructs = new Set<string>();
  const publicSubnetsByVpc = new Map<string, Array<{ id: string; stackName: string }>>();
  for (const s of universe) {
    for (const c of s.constructs) {
      registry.set(c.id, s.name);
      if (c.type === 'Function.Lambda') lambdaConstructs.add(c.id);
      if (c.type === 'Secret.Vault') secretVaults.add(c.id);
      if (c.type === 'Storage.Bucket') s3Buckets.add(c.id);
      if (c.type === 'Network.Subnet') {
        const p = c.props as Record<string, unknown>;
        if (p.public && typeof p.vpcId === 'string') {
          const arr = publicSubnetsByVpc.get(p.vpcId) ?? [];
          arr.push({ id: c.id, stackName: s.name });
          publicSubnetsByVpc.set(p.vpcId, arr);
        }
      }
      if (c.type === 'Network.LoadBalancer') {
        const tgs = (c.props as Record<string, unknown>).targetGroups as Array<{ name: string }> | undefined;
        if (tgs && tgs.length > 0) {
          const lbLogicalId = c.id.replace(/[^a-zA-Z0-9]/g, '');
          albDefaultTg.set(c.id, { stackName: s.name, tgLogicalId: `${lbLogicalId}TG${tgs[0].name.replace(/[^a-zA-Z0-9]/g, '')}` });
        }
      }
      if (c.type === 'Function.Lambda' && Array.isArray((c.props as Record<string, unknown>).eventSources)) {
        const es = (c.props as Record<string, unknown>).eventSources as Array<Record<string, unknown>>;
        if (es.some(e => e.queueId)) sqsEventSourceLambdas.add(c.id);
        if (es.some(e => e.streamId)) kinesisEventSourceLambdas.add(c.id);
      }
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
  const ctx: SynthContext = { currentStackName: stack.name, registry, lambdaRoles, vpcLambdas, dbSecretSuffix, secretVaults, s3Buckets, sqsEventSourceLambdas, kinesisEventSourceLambdas, albDefaultTg, lambdaConstructs, publicSubnetsByVpc, profile };

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
    if (construct.type === 'Storage.Bucket') {
      // Nome (Ref) e ARN — para cross-stack (env var BUCKET, policy resources).
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Name`] = {
        Value: { Ref: logicalId },
        Export: { Name: `${stack.name}-${construct.id}-Name` },
      };
      outputs[`${logicalId}Arn`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'Arn'] },
        Export: { Name: `${stack.name}-${construct.id}-Arn` },
      };
    }
    if (construct.type === 'Messaging.Queue' || construct.type === 'Messaging.Topic') {
      // ARN (+ URL para fila) — para cross-stack (eventSources, subscriptions, policies).
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Arn`] = {
        Value: { 'Fn::GetAtt': [logicalId, construct.type === 'Messaging.Topic' ? 'TopicArn' : 'Arn'] },
        Export: { Name: `${stack.name}-${construct.id}-Arn` },
      };
      if (construct.type === 'Messaging.Queue') {
        outputs[`${logicalId}QueueUrl`] = {
          Value: { Ref: logicalId },
          Export: { Name: `${stack.name}-${construct.id}-QueueUrl` },
        };
      }
    }
    if (construct.type === 'Messaging.Stream') {
      // ARN do Kinesis stream — para eventSources e policies (kinesis:PutRecord) cross-stack.
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Arn`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'Arn'] },
        Export: { Name: `${stack.name}-${construct.id}-Arn` },
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
    if (construct.type === 'Cache.Redis') {
      // Exporta Endpoint/Port pra Lambda/ECS em OUTRA stack conectar via
      // Fn::ImportValue (REDIS_HOST/REDIS_PORT). ReplicationGroup expõe o
      // primary endpoint em PrimaryEndPoint.Address/Port.
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Endpoint`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'PrimaryEndPoint.Address'] },
        Export: { Name: `${stack.name}-${construct.id}-Endpoint` },
      };
      outputs[`${logicalId}Port`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'PrimaryEndPoint.Port'] },
        Export: { Name: `${stack.name}-${construct.id}-Port` },
      };
    }
    if (construct.type === 'Network.WAF') {
      // Exporta o ARN do WebACL pra um Fn.ApiGateway em OUTRA stack associar (wafAclId).
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Arn`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'Arn'] },
        Export: { Name: `${stack.name}-${construct.id}-Arn` },
      };
    }
    if (construct.type === 'Network.LoadBalancer') {
      // Exporta o ARN do target group default pra um Compute.Container em OUTRA
      // stack registrar suas tasks (ECS Service LoadBalancers). Ver resolveTargetGroupArn.
      const tgs = (construct.props as Record<string, unknown>).targetGroups as Array<{ name: string }> | undefined;
      if (tgs && tgs.length > 0) {
        const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
        const tgLogicalId = `${logicalId}TG${tgs[0].name.replace(/[^a-zA-Z0-9]/g, '')}`;
        outputs[`${logicalId}TargetGroupArn`] = {
          Value: { Ref: tgLogicalId },
          Export: { Name: `${stack.name}-${construct.id}-TargetGroupArn` },
        };
      }
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
