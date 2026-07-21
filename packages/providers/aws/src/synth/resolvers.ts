import { ref, isRef, type Ref } from '@iacmp/core';
import { resourceRef, importRef, type ResourceRef, type ImportRef } from './graph';
import { type CloudFormationResource, type SynthContext } from './types';

// ─── Mapa tipo × atributo → { sameStack, exportSuffix } ─────────────────────
// exportSuffix vazio ('') = sameStack é usada também para cross-stack
// (caso Password que usa dynamic ref independente da stack).
type SameStackFn = (logicalId: string, constructId: string, ownerStack: string, ctx: SynthContext) => ResourceRef | string;

interface ResolutionEntry {
  sameStack: SameStackFn;
  exportSuffix: string;
}

const RESOLVE_MAP: Record<string, Record<string, ResolutionEntry>> = {
  'Secret.Vault': {
    'SecretArn': { sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'SecretArn' },
    'Arn':       { sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'SecretArn' }, // vault só exporta -SecretArn
  },
  'Database.SQL': {
    'Endpoint':  { sameStack: (l) => resourceRef(l, 'Endpoint.Address'), exportSuffix: 'Endpoint' },
    'Port':      { sameStack: (l) => resourceRef(l, 'Endpoint.Port'), exportSuffix: 'Port' },
    'SecretArn': { sameStack: (l) => resourceRef(`${l}Secret`, 'Id'), exportSuffix: 'SecretArn' },
    'Password': {
      sameStack: (_, cid, owner, ctx) => {
        const suffix = ctx.dbSecretSuffix.get(cid) ?? 'db-password';
        return `{{resolve:secretsmanager:${owner}-${cid}-${suffix}:SecretString:password}}`;
      },
      exportSuffix: '', // dynamic ref — usa sameStack para cross-stack também
    },
    'Username': { sameStack: (_, cid, __, ctx) => ctx.dbMasterUsername.get(cid) ?? 'dbadmin', exportSuffix: '' }, // literal — sempre usa sameStack (mesmo padrão do Password)
  },
  'Database.DocumentDB': {
    'Endpoint':  { sameStack: (l) => resourceRef(`${l}Cluster`, 'Endpoint'), exportSuffix: 'Endpoint' },
    'Port':      { sameStack: (l) => resourceRef(`${l}Cluster`, 'Port'), exportSuffix: 'Port' },
    'SecretArn': { sameStack: (l) => resourceRef(`${l}Secret`, 'Id'), exportSuffix: 'SecretArn' },
    'Password': {
      sameStack: (_, cid, owner, ctx) => {
        const suffix = ctx.dbSecretSuffix.get(cid) ?? 'docdb-password';
        return `{{resolve:secretsmanager:${owner}-${cid}-${suffix}:SecretString:password}}`;
      },
      exportSuffix: '',
    },
  },
  'Cache.Redis': {
    'Endpoint': { sameStack: (l) => resourceRef(l, 'PrimaryEndPoint.Address'), exportSuffix: 'Endpoint' },
    'Port':     { sameStack: (l) => resourceRef(l, 'PrimaryEndPoint.Port'), exportSuffix: 'Port' },
  },
  'Messaging.Queue': {
    'Arn':      { sameStack: (l) => resourceRef(l, 'Arn'), exportSuffix: 'Arn' },
    'QueueArn': { sameStack: (l) => resourceRef(l, 'Arn'), exportSuffix: 'Arn' }, // alias
    'QueueUrl': { sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'QueueUrl' },
  },
  'Messaging.Topic': {
    'Arn':      { sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'Arn' }, // Ref retorna ARN para SNS
    'TopicArn': { sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'Arn' }, // alias
  },
  'Messaging.Stream': {
    'Arn':  { sameStack: (l) => resourceRef(l, 'Arn'), exportSuffix: 'Arn' },
    'Name': { sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'Name' },
  },
  'Function.Lambda': {
    'Arn':  { sameStack: (l) => resourceRef(l, 'Arn'), exportSuffix: 'Arn' },
    'Name': { sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'Name' },
  },
  'Network.LoadBalancer': {
    'TargetGroupArn': {
      sameStack: (_, cid, __, ctx) => {
        const tg = ctx.albDefaultTg.get(cid);
        return tg ? resourceRef(tg.tgLogicalId, 'Id') : cid;
      },
      exportSuffix: 'TargetGroupArn',
    },
    'DnsName': { sameStack: (l) => resourceRef(l, 'DNSName'), exportSuffix: 'DnsName' },
  },
  'Network.WAF': {
    'Arn': { sameStack: (l) => resourceRef(l, 'Arn'), exportSuffix: 'Arn' },
  },
  'Workflow.StepFunctions': {
    'Arn':  { sameStack: (l) => resourceRef(l, 'Arn'), exportSuffix: 'Arn' },
    'Name': { sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'Name' },
  },
  'Storage.Bucket': {
    'Arn':  { sameStack: (l) => resourceRef(l, 'Arn'), exportSuffix: 'Arn' },
    'Name': { sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'Name' },
  },
  'Database.DynamoDB': {
    'Arn':  { sameStack: (l) => resourceRef(l, 'Arn'), exportSuffix: 'Arn' },
    'Name': { sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'Name' },
  },
  'Network.VPC':           { 'VpcId':   { sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'VpcId' } },
  'Network.Subnet':        { 'SubnetId':{ sameStack: (l) => resourceRef(l, 'Id'), exportSuffix: 'SubnetId' } },
  'Network.SecurityGroup': { 'GroupId': { sameStack: (l) => resourceRef(l, 'GroupId'), exportSuffix: 'GroupId' } },
};

// Atributo default para bare IDs (construct sem sufixo de atributo).
const DEFAULT_ATTR: Partial<Record<string, string>> = {
  'Secret.Vault':         'SecretArn',
  'Storage.Bucket':       'Arn',
  'Messaging.Queue':      'Arn',
  'Messaging.Topic':      'Arn',
  'Messaging.Stream':     'Arn',
  'Function.Lambda':      'Arn',
  'Network.WAF':              'Arn',
  'Database.DynamoDB':        'Arn',
  'Workflow.StepFunctions':   'Arn',
  'Network.LoadBalancer': 'TargetGroupArn',
};

// Normalização de aliases de atributo na string.
const ATTR_ALIAS: Record<string, string> = {
  'arn':        'Arn',
  'name':       'Name',
  'BucketName': 'Name',
};

/**
 * Converte uma string legada ('AppDB.SecretArn', 'AlertsTopic', 'arn:...') em
 * `Ref` tipado ou `{ literal: string }`. Cobre:
 *  - `'arn:...'` literal
 *  - `'<id>.<attr>'` com attr válido (inclusive aliases arn/name/TopicArn)
 *  - `'<id>'` cru — usa DEFAULT_ATTR para o tipo do construct
 */
export function parseStringRef(value: string, ctx: SynthContext): Ref | { literal: string } {
  if (value.startsWith('arn:')) return { literal: value };

  // Padrão '<id>.<attr>'
  const dot = value.indexOf('.');
  if (dot !== -1) {
    const constructId = value.slice(0, dot);
    const rawAttr = value.slice(dot + 1);
    if (ctx.registry.has(constructId)) {
      const attr = ATTR_ALIAS[rawAttr] ?? rawAttr;
      return ref(constructId, attr);
    }
  }

  // Bare ID
  if (ctx.registry.has(value)) {
    const type = ctx.registry.get(value)!.type;
    const attr = DEFAULT_ATTR[type];
    if (attr) return ref(value, attr);
  }

  return { literal: value };
}

/**
 * ÚNICO ponto de resolução de Ref → expressão CloudFormation.
 * Valida:
 *  1. constructId existe no registry (erro claro se não)
 *  2. attribute válido para o tipo via RESOLVE_MAP
 *  3. opts.expectType → erro de tipo se não bater
 *  4. same-stack → GetAtt/Ref via RESOLVE_MAP.sameStack
 *     cross-stack → ImportValue com exportSuffix (ou sameStack se exportSuffix vazio)
 */
export function resolveRef(r: Ref, ctx: SynthContext, opts?: { expectType?: string }): unknown {
  const entry = ctx.registry.get(r.constructId);
  if (!entry) {
    throw new Error(`Referência "${r.constructId}" não foi encontrada em nenhuma stack do projeto.`);
  }
  const { stackName, type } = entry;

  if (opts?.expectType && type !== opts.expectType) {
    throw new Error(`Referência "${r.constructId}" (tipo: "${type}") não é do tipo esperado "${opts.expectType}".`);
  }

  const attrMap = RESOLVE_MAP[type];
  if (!attrMap) {
    throw new Error(`Tipo "${type}" não tem atributos referenciáveis definidos. constructId: "${r.constructId}".`);
  }

  const resolution = attrMap[r.attribute];
  if (!resolution) {
    const valid = Object.keys(attrMap).join(', ');
    throw new Error(`Atributo "${r.attribute}" não é válido para o tipo "${type}". Atributos válidos: ${valid}. constructId: "${r.constructId}".`);
  }

  const logicalId = r.constructId.replace(/[^a-zA-Z0-9]/g, '');
  const isSameStack = stackName === ctx.currentStackName;

  if (isSameStack || !resolution.exportSuffix) {
    return resolution.sameStack(logicalId, r.constructId, stackName, ctx);
  }
  return importRef(`${stackName}-${r.constructId}-${resolution.exportSuffix}`);
}

/**
 * Resolve a referência ao ARN de uma Function.Lambda como valor standalone
 * (ex: Lambda Permission's FunctionName) — local usa Fn::GetAtt, cross-stack
 * usa Fn::ImportValue.
 */
// Helper compartilhado: resolve o ARN de um construct (Lambda, fila, tópico...)
// — wrapper fino de parseStringRef+resolveRef. same-stack GetAtt / cross-stack ImportValue.
export function resolveLambdaArnRef(lambdaId: string | Ref, ctx: SynthContext): unknown {
  if (isRef(lambdaId)) return resolveRef(lambdaId, ctx);
  const parsed = parseStringRef(lambdaId, ctx);
  if ('literal' in parsed) {
    throw new Error(`Referência "${lambdaId}" não foi encontrada em nenhuma stack do projeto.`);
  }
  return resolveRef(parsed, ctx);
}

/** Exige que `id` seja uma Fn.Lambda (usado por rotas de ApiGateway); lança um
 *  erro claro caso contrário. */
export function requireLambda(id: string, ctx: SynthContext): void {
  if (ctx.registry.get(id)?.type !== 'Function.Lambda') {
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
  const ownerStack = ctx.registry.get(lambdaId)?.stackName;
  if (!ownerStack) {
    throw new Error(`Lambda "${lambdaId}" referenciada em Function.ApiGateway não foi encontrada em nenhuma stack do projeto.`);
  }
  if (ownerStack === ctx.currentStackName) {
    const logicalId = lambdaId.replace(/[^a-zA-Z0-9]/g, '');
    return { 'Fn::Sub': `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${${logicalId}.Arn}/invocations` };
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
  // Auto-inline policies para Lambdas sem Policy.IAM explícito que referenciam
  // AWS services no environment — sem as permissões correspondentes o runtime
  // falha com AccessDeniedException. Usamos Resource:'*' para evitar dependências
  // cross-stack de ARNs (a Lambda::Permission já restringe o invocador correto).
  const autoStatements: Array<{ Effect: string; Action: string[]; Resource: string }> = [];
  if (ctx.sfnInitiatorLambdas.has(lambdaId)) {
    autoStatements.push({ Effect: 'Allow', Action: ['states:StartExecution'], Resource: '*' });
  }
  if (ctx.dynamoRefLambdas.has(lambdaId)) {
    autoStatements.push({ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'], Resource: '*' });
  }
  if (ctx.sqsSenderRefLambdas.has(lambdaId)) {
    autoStatements.push({ Effect: 'Allow', Action: ['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'], Resource: '*' });
  }
  const autoPolicies = autoStatements.length > 0 ? [{
    PolicyName: `${lambdaLogicalId}AutoPolicy`,
    PolicyDocument: { Version: '2012-10-17', Statement: autoStatements },
  }] : undefined;

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
        ...(autoPolicies ? { Policies: autoPolicies } : {}),
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

export function resolveVpcId(id: string | Ref, ctx: SynthContext): unknown {
  if (isRef(id)) return resolveRef(id, ctx);
  if (/^vpc-[0-9a-z]+$/.test(id)) return id;
  const ownerStack = ctx.registry.get(id)?.stackName;
  if (!ownerStack) return id;
  const logicalId = id.replace(/[^a-zA-Z0-9]/g, '');
  if (ownerStack === ctx.currentStackName) return { Ref: logicalId };
  return { 'Fn::ImportValue': `${ownerStack}-${id}-VpcId` };
}

export function resolveSubnetId(id: string | Ref, ctx: SynthContext): unknown {
  if (isRef(id)) return resolveRef(id, ctx);
  if (/^subnet-[0-9a-z]+$/.test(id)) return id;
  const ownerStack = ctx.registry.get(id)?.stackName;
  if (!ownerStack) return id;
  const logicalId = id.replace(/[^a-zA-Z0-9]/g, '');
  if (ownerStack === ctx.currentStackName) return { Ref: logicalId };
  return { 'Fn::ImportValue': `${ownerStack}-${id}-SubnetId` };
}

export function resolveSecurityGroupId(id: string | Ref, ctx: SynthContext): unknown {
  if (isRef(id)) return resolveRef(id, ctx);
  if (/^sg-[0-9a-zA-Z]+$/.test(id)) return id;
  const ownerStack = ctx.registry.get(id)?.stackName;
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

export function resolveQueueArn(value: string | Ref, ctx: SynthContext): unknown {
  if (isRef(value)) return resolveRef(value, ctx);
  if (value.startsWith('arn:')) return value;
  const parsed = parseStringRef(value, ctx);
  if ('literal' in parsed) return value;
  return resolveRef(parsed, ctx);
}

// Atributos que produzem ARNs válidos para uso em Policy.IAM resources.
// Qualquer outro atributo (Endpoint, Port, DnsName, VpcId…) é rejeitado em synth
// pois IAM exige ARN ou '*' — um hostname DNS em Resource causa 400 no deploy.
const ARN_ATTRS = new Set(['Arn', 'SecretArn', 'QueueArn', 'TopicArn', 'TargetGroupArn']);

function assertPolicyResourceIsArn(r: Ref): void {
  if (!ARN_ATTRS.has(r.attribute)) {
    throw new Error(
      `Policy.IAM: ref('${r.constructId}','${r.attribute}') em resources não é um ARN (IAM exige ARN ou '*'). ` +
      `Use ref('${r.constructId}','SecretArn') para o secret do banco, o id do construct para o ARN do recurso, ou '*'.`,
    );
  }
}

/**
 * Retorna o constructId do Storage.Bucket se `value` é uma referência ao ARN (ou
 * path/*) desse bucket na MESMA stack — caso contrário retorna undefined.
 * Usado para detectar o ciclo Bucket→Lambda→PolicyRole→Bucket e substituir por '*'.
 */
export function isSamestackS3BucketRef(value: unknown, ctx: SynthContext): string | undefined {
  let id: string | undefined;
  if (isRef(value)) {
    id = (value as Ref).constructId;
  } else if (typeof value === 'string') {
    const m = /^([^./]+)(?:\.arn)?(\/.*)?$/i.exec(value);
    if (m) id = m[1];
  }
  if (!id) return undefined;
  const entry = ctx.registry.get(id);
  if (!entry || entry.type !== 'Storage.Bucket') return undefined;
  if (entry.stackName !== ctx.currentStackName) return undefined;
  return id;
}

export function resolvePolicyResource(value: unknown, ctx: SynthContext): unknown {
  if (isRef(value)) {
    assertPolicyResourceIsArn(value as Ref);
    return resolveRef(value as Ref, ctx);
  }
  if (typeof value !== 'string') return value; // null/undefined pass through → validateNoNullValues
  if (value.startsWith('arn:') || value === '*') return value;
  // S3 bucket ARN com sufixo de path opcional: 'UploadsBucket.arn/*' ou 'UploadsBucket/*'.
  // parseStringRef não preserva o sufixo, então este caso é tratado antes.
  const s3Match = /^([^./]+)(?:\.arn)?(\/.*)?$/i.exec(value);
  if (s3Match) {
    const id = s3Match[1];
    const suffix = s3Match[2] ?? '';
    if (ctx.registry.get(id)?.type === 'Storage.Bucket') {
      const bucketArn = resolveRef(ref(id, 'Arn'), ctx);
      if (!suffix) return bucketArn;
      return { 'Fn::Sub': [`\${BArn}${suffix}`, { BArn: bucketArn }] };
    }
  }
  const parsed = parseStringRef(value, ctx);
  if ('literal' in parsed) return value;
  assertPolicyResourceIsArn(parsed);
  return resolveRef(parsed, ctx);
}

// Env vars tipicamente recebem nomes (não ARNs) para Storage.Bucket e Database.DynamoDB.
// S3 PutObject/GetObject esperam bucket name; DynamoDB PutItem espera table name.
// O DEFAULT_ATTR global usa Arn (correto para IAM policy resources), mas em env vars
// o default para esses dois tipos deve ser Name.
const ENV_VAR_DEFAULT_ATTR: Partial<Record<string, string>> = {
  ...DEFAULT_ATTR,
  'Storage.Bucket': 'Name',
  'Database.DynamoDB': 'Name',
};

export function resolveEnvVarValue(value: unknown, ctx: SynthContext): unknown {
  if (isRef(value)) return resolveRef(value, ctx);
  if (typeof value !== 'string') return value;
  // Para bare IDs (sem ponto), usa o mapa específico de env var que prefere Name
  // para Storage.Bucket e Database.DynamoDB em vez de Arn.
  if (!value.startsWith('arn:') && !value.includes('.') && ctx.registry.has(value)) {
    const type = ctx.registry.get(value)!.type;
    const attr = ENV_VAR_DEFAULT_ATTR[type];
    if (attr) return resolveRef(ref(value, attr), ctx);
  }
  const parsed = parseStringRef(value, ctx);
  if ('literal' in parsed) return value;
  return resolveRef(parsed, ctx);
}

/**
 * Resolve uma ação de alarme (AlarmActions/OKActions) que referencia um
 * Messaging.Topic: aceita o id ('AlertsTopic'), 'AlertsTopic.TopicArn'/'.arn'
 * ou um ARN literal. Same-stack → { Ref } (SNS Ref retorna o ARN); cross-stack
 * → ImportValue do export '-Arn'. Entradas não-string (ex: `.arn` undefined que
 * a IA às vezes gera) são descartadas para não virarem null no template.
 */
export function resolveAlarmAction(value: unknown, ctx: SynthContext): unknown | undefined {
  if (isRef(value)) return resolveRef(value, ctx);
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.startsWith('arn:')) return value;
  const parsed = parseStringRef(value, ctx);
  if ('literal' in parsed) return value; // ref desconhecida — deixa como veio (visível no deploy)
  return resolveRef(parsed, ctx);
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
export function resolveTargetGroupArn(value: unknown, ctx: SynthContext): unknown {
  if (isRef(value)) return resolveRef(value, ctx);
  if (typeof value !== 'string') return value;
  if (value.startsWith('arn:')) return value;
  const parsed = parseStringRef(value, ctx);
  if ('literal' in parsed) return value;
  return resolveRef(parsed, ctx);
}
