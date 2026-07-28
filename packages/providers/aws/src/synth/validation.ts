import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BaseConstruct, Stack } from '@iacmp/core';
import { type CloudFormationResource, type SynthContext } from './types';
import { isSamestackS3BucketRef } from './resolvers';

export const CFN_PSEUDO_PARAMETERS = new Set([
  'AWS::Region', 'AWS::AccountId', 'AWS::StackName', 'AWS::StackId',
  'AWS::Partition', 'AWS::URLSuffix', 'AWS::NoValue', 'AWS::NotificationARNs',
]);

export function collectReferencedLogicalIds(node: unknown, found: Set<string>): void {
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
export function validateResourceReferences(resources: Record<string, CloudFormationResource>): void {
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
 * Detecta handlers de CREATE/POST que leem body.id em vez de gerar UUID server-side.
 * IDs gerados pelo cliente não têm unicidade garantida e causam colisões silenciosas
 * ou PutItem com partition key undefined quando o cliente não manda o campo.
 * O guard lê src/*.ts e verifica se create/post handlers contêm body.id sem UUID.
 */
export function validateCreateHandlerUUID(projectDir: string = process.cwd()): void {
  const srcDir = path.join(projectDir, 'src');
  if (!fs.existsSync(srcDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(srcDir)
      .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
      .map(f => path.join(srcDir, f));
  } catch {
    return;
  }

  const CREATE_FILE = /create|insert|post/i;
  const UUID_PRESENT = /randomUUID|uuid\(\)|uuidv4|nanoid|cuid/i;
  const BODY_ID = /body\.id\b|body\["id"\]|body\['id'\]/;

  const errors: string[] = [];
  for (const file of files) {
    if (!CREATE_FILE.test(path.basename(file))) continue;
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (BODY_ID.test(content) && !UUID_PRESENT.test(content)) {
      const rel = path.relative(projectDir, file);
      errors.push(
        `Handler ${rel}: lê body.id sem gerar UUID server-side. ` +
        `IDs DEVEM ser gerados internamente: \`const id = crypto.randomUUID();\`. ` +
        `NUNCA use body.id como chave primária — o cliente pode mandar undefined, duplicado ou vazio.`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Handlers de CREATE com body.id sem UUID detectados:\n- ${errors.join('\n- ')}`);
  }
}

/**
 * Detecta null/undefined em qualquer propriedade dos resources ANTES do deploy.
 * Causa típica: a IA referencia uma propriedade que não existe no construct
 * (ex: `secretArn` em Secret.Vault), que em TS é `undefined` e vira `null` no
 * template — o CloudFormation rejeita com "'null' values are not allowed".
 * Pega na origem, com o caminho exato.
 */
export function validateNoNullValues(resources: Record<string, CloudFormationResource>): void {
  const bad: string[] = [];
  const stringified: string[] = [];
  const placeholderArns: string[] = [];
  const walk = (node: unknown, pathStr: string): void => {
    if (node === null || node === undefined) {
      bad.push(pathStr);
      return;
    }
    if (typeof node === 'string' && node.includes('[object Object]')) {
      // Sinal de um Ref tipado concatenado com string no código da stack
      // (ex: ref('B','Arn') + '/*' → "[object Object]/*"). O deploy falharia
      // com 400 — barrar aqui dá erro que o loop de geração conserta.
      stringified.push(pathStr);
      return;
    }
    if (typeof node === 'string' && node.includes('123456789012')) {
      // Account id placeholder da doc AWS — a IA hardcodou um ARN literal em vez
      // de ref('Recurso','Arn'). O deploy sobe mas a policy aponta pra conta
      // errada (AccessDenied em runtime). Barrar no synth p/ o loop consertar.
      placeholderArns.push(pathStr);
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
  if (stringified.length > 0) {
    throw new Error(
      `"[object Object]" no template em ${stringified.map(p => `"${p}"`).join(', ')}. ` +
      `Causa: um ref(...) tipado foi concatenado com string no código da stack ` +
      `(ex: ref('MeuBucket','Arn') + '/*'). NÃO concatene refs — para "objetos dentro do bucket" ` +
      `num resource de Policy.IAM use a STRING 'MeuBucket/*' (o synth resolve para '<arn>/*').`
    );
  }
  if (placeholderArns.length > 0) {
    throw new Error(
      `Account id placeholder "123456789012" no template em ${placeholderArns.map(p => `"${p}"`).join(', ')}. ` +
      `A IA hardcodou um ARN literal. Use ref('Recurso','Arn') (o synth gera o ARN com a conta real) ` +
      `ou, para um ARN construído à mão, '\${AWS::AccountId}' num Fn::Sub — NUNCA um account id fixo.`
    );
  }
  if (bad.length > 0) {
    throw new Error(
      `Valor null/undefined no template (CloudFormation rejeita): ${bad.map(p => `"${p}"`).join(', ')}. ` +
      `Causa comum: referência a uma propriedade que não existe no construct ` +
      `(ex: Secret.Vault não tem .secretArn; use a env var resolvida pelo synth ou o id do recurso).`
    );
  }
}

/**
 * Detecta handlers TypeScript que usam process.env.<VAR> onde <VAR> foi omitida
 * pelo synth porque referenciava um bucket-trigger (evitar ciclo CFN). O modelo
 * de IA frequentemente gera `const bucket = process.env.RAW_BUCKET_NAME!` no
 * handler, mas essa env var não existe em runtime — a Lambda falha com undefined.
 *
 * Varre src/*.ts no diretório do projeto (process.cwd() = cwd do synth = projectDir)
 * e lança erro claro com instrução de fix antes do deploy.
 */
export function validateHandlerEnvVarAccess(constructs: BaseConstruct[], ctx: SynthContext, projectDir: string = process.cwd()): void {
  const errors: string[] = [];

  for (const construct of constructs) {
    if (construct.type !== 'Function.Lambda') continue;

    const triggerBuckets = ctx.s3TriggerBucketsForLambda.get(construct.id);
    if (!triggerBuckets || triggerBuckets.size === 0) continue;

    const environment = (construct.props as Record<string, unknown>).environment as Record<string, unknown> | undefined;
    if (!environment) continue;

    // Replica a lógica de omissão de synthFunction: env vars que referenciam um
    // trigger bucket da mesma stack são omitidas do template CFN.
    const omittedVars: string[] = [];
    for (const [k, v] of Object.entries(environment)) {
      const bucketId = isSamestackS3BucketRef(v, ctx);
      if (bucketId && triggerBuckets.has(bucketId)) {
        omittedVars.push(k);
      }
    }

    if (omittedVars.length === 0) continue;

    // Verifica src/*.ts do projeto (cwd = projectDir quando synth roda).
    const srcDir = path.join(projectDir, 'src');
    if (!fs.existsSync(srcDir)) continue;

    let tsFiles: string[];
    try {
      tsFiles = fs.readdirSync(srcDir)
        .filter(f => f.endsWith('.ts'))
        .map(f => path.join(srcDir, f));
    } catch {
      continue;
    }

    for (const file of tsFiles) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      for (const varName of omittedVars) {
        if (content.includes(`process.env.${varName}`)) {
          const rel = path.relative(projectDir, file);
          errors.push(
            `Erro: Handler ${rel} usa process.env.${varName} mas essa env var é omitida pelo synth ` +
            `(referencia o bucket-trigger, criaria ciclo CFN).\n` +
            `Fix: use record.s3.bucket.name do evento S3 em vez de process.env.${varName}.`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

// Atributo canônico por tipo de construct — usado quando env var é string literal (ID lógico)
const CONSTRUCT_DEFAULT_ATTR: Record<string, string> = {
  'Database.DynamoDB': 'Name',
  'Storage.Bucket': 'Name',
  'Messaging.Queue': 'QueueUrl',
  'Messaging.Topic': 'TopicArn',
  'Messaging.Stream': 'Name',
  'Cache.Redis': 'Endpoint',
  'Database.SQL': 'Endpoint',
  'Secret.Vault': 'SecretArn',
};

// Regra geral: sufixo do nome da env var → atributo esperado do ref().
// Cobre TODOS os padrões de nomenclatura comuns — sem exceções por caso.
// O atributo 'Arn' é EXCLUSIVO de resources[] em Policy.IAM, nunca em environment{}.
const ENV_SUFFIX_TO_ATTR: Array<{ suffix: RegExp; expected: string[]; suggest: string }> = [
  { suffix: /_NAME$/,             expected: ['Name'],                             suggest: 'Name' },
  { suffix: /_TOPIC_ARN$/,        expected: ['TopicArn', 'Arn'],                  suggest: 'TopicArn' },
  { suffix: /_SECRET_ARN$/,       expected: ['SecretArn', 'Arn'],                 suggest: 'SecretArn' },
  { suffix: /_ARN$/,              expected: ['Arn', 'TopicArn', 'SecretArn'],     suggest: 'Arn' },
  { suffix: /_URL$/,              expected: ['QueueUrl', 'Url', 'Endpoint'],      suggest: 'QueueUrl' },
  { suffix: /_(HOST|ENDPOINT)$/,  expected: ['Endpoint', 'Url'],                  suggest: 'Endpoint' },
  { suffix: /_PORT$/,             expected: ['Port'],                             suggest: 'Port' },
  { suffix: /_PASSWORD$/,         expected: ['Password'],                         suggest: 'Password' },
  { suffix: /_(USERNAME|USER)$/,  expected: ['Username'],                         suggest: 'Username' },
  { suffix: /_(CONNECTION|CONN)_?STRING$/i, expected: ['ConnectionString'],       suggest: 'ConnectionString' },
];

/**
 * Detecta handlers de UPDATE/PUT que usam UpdateExpression sem ExpressionAttributeNames.
 * Qualquer nome de campo pode ser palavra reservada do DynamoDB (item, name, value,
 * status, size, type, data, key, etc.). Sem o alias #f=fieldName, o deploy sobe mas
 * o PUT falha em runtime com ValidationException para qualquer campo reservado.
 */
export function validateUpdateHandlerExpression(projectDir: string = process.cwd()): void {
  const srcDir = path.join(projectDir, 'src');
  if (!fs.existsSync(srcDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(srcDir)
      .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
      .map(f => path.join(srcDir, f));
  } catch {
    return;
  }

  const UPDATE_FILE = /update|put|patch/i;
  const HAS_UPDATE_EXPR = /UpdateExpression/;
  const HAS_EXPR_NAMES = /ExpressionAttributeNames/;

  const errors: string[] = [];
  for (const file of files) {
    if (!UPDATE_FILE.test(path.basename(file))) continue;
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (HAS_UPDATE_EXPR.test(content) && !HAS_EXPR_NAMES.test(content)) {
      const rel = path.relative(projectDir, file);
      errors.push(
        `Handler ${rel}: usa UpdateExpression sem ExpressionAttributeNames. ` +
        `Qualquer campo pode ser palavra reservada do DynamoDB (item, name, value, status...). ` +
        `Use o padrão com alias: UpdateExpression: 'SET #f0 = :v0', ExpressionAttributeNames: { '#f0': fieldName }.`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Handlers de UPDATE sem ExpressionAttributeNames detectados:\n- ${errors.join('\n- ')}`);
  }
}

/**
 * Bloqueia partitionKeyType/sortKeyType 'N' em tabelas DynamoDB.
 * IDs vindos de path params, UUID, slug e hash são sempre strings — 'N' quase
 * nunca é o tipo certo e causa ValidationException em runtime. O modelo 'S'
 * é o default universal; 'N' deve ser explicitamente justificado no prompt.
 */
// partitionKeyType/sortKeyType 'N' é raramente correto (IDs de CRUD são strings),
// mas É uma feature válida do DynamoDB para chaves genuinamente numéricas — por
// isso ALERTA (nudge visível), sem BLOQUEAR o synth. A steering para 'S' vive no
// prompt de geração; um hard-block aqui rejeitaria infra válida.
export function validateDynamoKeyTypes(universe: Stack[]): void {
  for (const stack of universe) {
    for (const construct of stack.constructs) {
      if (construct.type !== 'Database.DynamoDB') continue;
      const props = construct.props as Record<string, unknown>;
      if (props.partitionKeyType === 'N') {
        console.warn(
          `[aws] Database.DynamoDB "${construct.id}": partitionKeyType 'N' (Number) — ` +
          `confirme que a chave é mesmo numérica. IDs de CRUD (UUID, slug, path param) são string ('S').`,
        );
      }
      if (props.sortKeyType === 'N') {
        console.warn(
          `[aws] Database.DynamoDB "${construct.id}": sortKeyType 'N' — use 'S' para sort keys de string/data, se aplicável.`,
        );
      }
    }
  }
}

function expectedAttrForVarName(varName: string): { suggest: string } | null {
  for (const rule of ENV_SUFFIX_TO_ATTR) {
    if (rule.suffix.test(varName)) return rule;
  }
  return null;
}

function attrIsAllowed(varName: string, attribute: string): boolean {
  for (const rule of ENV_SUFFIX_TO_ATTR) {
    if (rule.suffix.test(varName)) return rule.expected.includes(attribute);
  }
  return true; // sem regra para esse sufixo → qualquer atributo é permitido
}

export function validateEnvVarRefs(
  universe: Stack[],
  registry: Map<string, { stackName: string; type: string }>,
): void {
  const stringErrors: string[] = [];
  const attrErrors: string[] = [];
  for (const stack of universe) {
    for (const construct of stack.constructs) {
      if (construct.type !== 'Function.Lambda') continue;
      const env = (construct.props as Record<string, unknown>).environment as Record<string, unknown> | undefined;
      if (!env) continue;
      for (const [varName, value] of Object.entries(env)) {
        // Caso 1: ID lógico como string literal — o modelo esqueceu de usar ref()
        if (typeof value === 'string') {
          const entry = registry.get(value);
          if (!entry) continue;
          const attr = CONSTRUCT_DEFAULT_ATTR[entry.type];
          if (!attr) continue;
          stringErrors.push(
            `Lambda "${construct.id}": environment.${varName} = '${value}' é o ID lógico, não o valor físico. ` +
            `Use ref('${value}', '${attr}').`,
          );
          continue;
        }
        // Caso 2: ref() com atributo que não bate com o sufixo do nome da env var
        if (value && typeof value === 'object' && (value as Record<string, unknown>).kind === 'iacmp:ref') {
          const r = value as { constructId: string; attribute: string };
          if (!attrIsAllowed(varName, r.attribute)) {
            const rule = expectedAttrForVarName(varName)!;
            attrErrors.push(
              `Lambda "${construct.id}": environment.${varName} usa ref('${r.constructId}', '${r.attribute}') ` +
              `mas o sufixo "${varName}" exige atributo '${rule.suggest}'. ` +
              `Corrija para ref('${r.constructId}', '${rule.suggest}').`,
            );
          }
        }
      }
    }
  }
  const allErrors: string[] = [];
  if (stringErrors.length > 0) {
    allErrors.push(`env vars com ID lógico em vez de ref() detectadas:\n- ${stringErrors.join('\n- ')}`);
  }
  if (attrErrors.length > 0) {
    allErrors.push(`env vars com atributo errado em ref() detectadas:\n- ${attrErrors.join('\n- ')}`);
  }
  if (allErrors.length > 0) {
    throw new Error(allErrors.join('\n\n'));
  }
}
