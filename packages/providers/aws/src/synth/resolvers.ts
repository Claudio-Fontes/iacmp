import { type CloudFormationResource, type SynthContext } from './types';

/**
 * Resolve a referência ao ARN de uma Function.Lambda como valor standalone
 * (ex: Lambda Permission's FunctionName) — local usa Fn::GetAtt, cross-stack
 * usa Fn::ImportValue.
 */
// Helper compartilhado: resolve o ARN de uma referência a um construct (Lambda,
// fila, tópico...) — same-stack GetAtt / cross-stack ImportValue "-Arn". NÃO
// valida o tipo do construct: quem exige uma Fn.Lambda (ex: rota de ApiGateway)
// deve checar ctx.lambdaConstructs no próprio call-site (ver requireLambda).
export function resolveLambdaArnRef(lambdaId: string, ctx: SynthContext): unknown {
  const ownerStack = ctx.registry.get(lambdaId);
  if (!ownerStack) {
    throw new Error(`Referência "${lambdaId}" não foi encontrada em nenhuma stack do projeto.`);
  }
  if (ownerStack === ctx.currentStackName) return { 'Fn::GetAtt': [lambdaId, 'Arn'] };
  return { 'Fn::ImportValue': `${ownerStack}-${lambdaId}-Arn` };
}

/** Exige que `id` seja uma Fn.Lambda (usado por rotas de ApiGateway); lança um
 *  erro claro caso contrário. */
export function requireLambda(id: string, ctx: SynthContext): void {
  if (!ctx.lambdaConstructs.has(id)) {
    throw new Error(`Function.ApiGateway: a rota aponta lambdaId "${id}", que não é uma Fn.Lambda. API Gateway só integra com Lambda — um Compute.Container/ECS deve ser exposto por um Network.LoadBalancer (ALB), não por API Gateway.`);
  }
}

/**
 * Monta o `Fn::Sub` da URI de invocação do API Gateway pra uma Lambda (mesmo
 * formato usado por REST v1 e HTTP/v2). Local embute `${lambdaId.Arn}` direto
 * na string (válido só quando o recurso está no mesmo template); cross-stack
 * usa a forma de Fn::Sub com mapa de substituição, injetando um
 * Fn::ImportValue no lugar do atributo local.
 */
export function buildInvocationUri(lambdaId: string, ctx: SynthContext): unknown {
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
export function resolveLambdaRole(
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
export function defaultServiceRole(
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

export function resolveVpcId(id: string, ctx: SynthContext): unknown {
  if (/^vpc-[0-9a-z]+$/.test(id)) return id;
  const ownerStack = ctx.registry.get(id);
  if (!ownerStack) return id;
  const logicalId = id.replace(/[^a-zA-Z0-9]/g, '');
  if (ownerStack === ctx.currentStackName) return { Ref: logicalId };
  return { 'Fn::ImportValue': `${ownerStack}-${id}-VpcId` };
}

export function resolveSubnetId(id: string, ctx: SynthContext): unknown {
  if (/^subnet-[0-9a-z]+$/.test(id)) return id;
  const ownerStack = ctx.registry.get(id);
  if (!ownerStack) return id;
  const logicalId = id.replace(/[^a-zA-Z0-9]/g, '');
  if (ownerStack === ctx.currentStackName) return { Ref: logicalId };
  return { 'Fn::ImportValue': `${ownerStack}-${id}-SubnetId` };
}

export function resolveSecurityGroupId(id: string, ctx: SynthContext): unknown {
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
export function normalizeRate(rate: string): string {
  const m = /^(\d+)\s+(minute|minutes|hour|hours|day|days)$/i.exec(rate.trim());
  if (!m) return rate;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase().replace(/s$/, '');
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

export function resolveQueueArn(value: string, ctx: SynthContext): unknown {
  if (value.startsWith('arn:')) return value;
  const ownerStack = ctx.registry.get(value);
  if (!ownerStack) return value;
  const logicalId = value.replace(/[^a-zA-Z0-9]/g, '');
  if (ownerStack === ctx.currentStackName) return { 'Fn::GetAtt': [logicalId, 'Arn'] };
  return { 'Fn::ImportValue': `${ownerStack}-${value}-Arn` };
}

export function resolvePolicyResource(value: string, ctx: SynthContext): unknown {
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
    // Qualquer ref a um Secret.Vault (mesmo com sufixo `.Arn`) também vai por aqui —
    // um vault exporta `-SecretArn`, nunca `-Arn`.
    if (match[2] === 'SecretArn' || ctx.secretVaults.has(match[1])) return resolveEnvVarValue(`${match[1]}.SecretArn`, ctx);
    return resolveQueueArn(match[1], ctx); // GetAtt Arn / ImportValue-Arn (fila e tópico exportam "-Arn")
  }
  // Id de construct cru (ex: 'TaskQueue' em resources) → ARN.
  if (ctx.registry.has(value)) {
    if (ctx.secretVaults.has(value)) return resolveEnvVarValue(`${value}.SecretArn`, ctx);
    return resolveQueueArn(value, ctx);
  }
  return value;
}

export function resolveEnvVarValue(value: string, ctx: SynthContext): unknown {
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
 * Resolve uma ação de alarme (AlarmActions/OKActions) que referencia um
 * Messaging.Topic: aceita o id ('AlertsTopic'), 'AlertsTopic.TopicArn'/'.arn'
 * ou um ARN literal. Same-stack → { Ref } (SNS Ref retorna o ARN); cross-stack
 * → ImportValue do export '-Arn'. Entradas não-string (ex: `.arn` undefined que
 * a IA às vezes gera) são descartadas para não virarem null no template.
 */
export function resolveAlarmAction(value: unknown, ctx: SynthContext): unknown | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.startsWith('arn:')) return value;
  const id = value.replace(/\.(TopicArn|arn|Arn)$/, '');
  const ownerStack = ctx.registry.get(id);
  if (!ownerStack) return value; // ref desconhecida — deixa como veio (visível no deploy)
  const logicalId = id.replace(/[^a-zA-Z0-9]/g, '');
  if (ownerStack === ctx.currentStackName) return { Ref: logicalId };
  return { 'Fn::ImportValue': `${ownerStack}-${id}-Arn` };
}

/**
 * Bloco AlarmActions/OKActions resolvido. Normaliza um valor escalar para array
 * (a IA às vezes emite `alarmActions: 'AlertsTopic'` em vez de array — chamar
 * `.map` direto num string quebraria o synth), resolve cada ref e descarta
 * undefined; retorna {} quando vazio (não emite a chave).
 */
export function alarmActionsBlock(key: 'AlarmActions' | 'OKActions', raw: unknown, ctx: SynthContext): Record<string, unknown> {
  const arr = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const acts = arr.map(a => resolveAlarmAction(a, ctx)).filter(a => a !== undefined);
  return acts.length > 0 ? { [key]: acts } : {};
}

/**
 * Resolve o ARN do target group default de um Network.LoadBalancer para registrar
 * tasks de um Compute.Container (ECS Service LoadBalancers). Aceita
 * "<lbId>.TargetGroupArn" ou "<lbId>" cru. Mesma stack → Fn::GetAtt do TG;
 * cross-stack → Fn::ImportValue do export "<stack>-<lbId>-TargetGroupArn".
 * ARN literal passa inalterado.
 */
export function resolveTargetGroupArn(value: string, ctx: SynthContext): unknown {
  if (value.startsWith('arn:')) return value;
  const lbId = value.replace(/\.TargetGroupArn$/, '');
  const tg = ctx.albDefaultTg.get(lbId);
  if (!tg) return value; // LB sem target group declarado — deixa como veio (erro visível no synth/deploy)
  if (tg.stackName === ctx.currentStackName) return { 'Fn::GetAtt': [tg.tgLogicalId, 'TargetGroupArn'] };
  return { 'Fn::ImportValue': `${tg.stackName}-${lbId}-TargetGroupArn` };
}
