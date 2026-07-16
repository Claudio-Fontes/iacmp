import * as fs from 'fs';
import * as path from 'path';
import { Stack } from '@iacmp/core';

export interface LoadedStack {
  stackName: string;
  stack: Stack;
}

/**
 * Para cada Fn.Lambda com runtime Node, confirma que existe um arquivo de
 * origem correspondente ao `handler`. Convenção: `handler: '<dir>/<arquivo>.<export>'`
 * (ou `'<arquivo>.<export>'`) → o código vem de `src/<arquivo>.ts`, que compila
 * para `dist/<arquivo>.js`. Se nem o fonte nem o compilado existem, o deploy
 * falharia em runtime com "Cannot find module".
 */
export function validateHandlerFiles(loaded: LoadedStack[], cwd: string): string[] {
  const errors: string[] = [];
  const CONVENTION_CODE = new Set(['.', './', 'dist', 'dist/', './dist', './dist/', 'src', 'src/', './src', './src/']);

  for (const { stack } of loaded) {
    for (const c of stack.constructs) {
      if (c.type !== 'Function.Lambda') continue;
      const props = c.props as Record<string, unknown>;
      const runtime = (props.runtime as string) ?? 'nodejs20';
      if (!runtime.startsWith('nodejs')) continue;
      const handler = props.handler as string | undefined;
      const code = props.code as string | undefined;
      if (!handler || typeof code !== 'string') continue;
      if (!CONVENTION_CODE.has(code)) continue;

      const modulePath = handler.replace(/\.[^./]+$/, '');
      const stem = modulePath.replace(/^(\.\/)?(dist|src)\//, '');

      const candidates = [
        path.join(cwd, 'src', `${stem}.ts`),
        path.join(cwd, 'src', `${stem}.js`),
        path.join(cwd, 'dist', `${stem}.js`),
        path.join(cwd, `${modulePath}.js`),
        path.join(cwd, `${modulePath}.ts`),
      ];
      if (!candidates.some(p => fs.existsSync(p))) {
        errors.push(
          `Fn.Lambda "${c.id}": handler '${handler}' não tem arquivo de origem — esperado src/${stem}.ts. ` +
          `AÇÃO CORRETA: CRIE o arquivo src/${stem}.ts exportando a função do handler. ` +
          `NÃO altere o campo handler na stack — o path está correto; o que falta é o arquivo src/${stem}.ts.`,
        );
      }
    }
  }
  return errors;
}

/**
 * Varre src/**.ts por INSERTs com contagem de colunas != valores — bug comum
 * em handlers gerados (ex: INSERT INTO items (a,b,c) VALUES ($1,$2)). Só sinaliza
 * o caso single-line inequívoco para não gerar falso positivo (multi-row,
 * subquery, multi-linha são ignorados).
 */
export function validateHandlerSql(cwd: string): string[] {
  const errors: string[] = [];
  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) return errors;

  const tsFiles: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) tsFiles.push(full);
    }
  };
  walk(srcDir);

  const re = /INSERT\s+INTO\s+\w+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi;
  for (const file of tsFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const cols = m[1].split(',').map(x => x.trim()).filter(Boolean);
      const vals = m[2].split(',').map(x => x.trim()).filter(Boolean);
      const simpleVals = vals.every(v => /^(\$\d+|\?)$/.test(v));
      if (simpleVals && cols.length !== vals.length) {
        errors.push(
          `${path.relative(cwd, file)}: INSERT com ${cols.length} coluna(s) (${cols.join(', ')}) ` +
          `mas ${vals.length} valor(es) (${vals.join(', ')}). A contagem deve bater.`,
        );
      }
    }
  }
  return errors;
}

/**
 * Dois mundos separados em SYNTH-TIME: handler com SDK da cloud errada.
 * Um projeto gerado para AWS tem handlers @aws-sdk — deployá-lo na Azure
 * empacota esses handlers nas Functions e falha só em RUNTIME ("Region is
 * missing", 500 opaco). O espelho vale para @azure/* num deploy AWS.
 * O guard de geração não cobre isso (na geração o SDK era o certo para o
 * provider original) — aqui barra o deploy CRUZADO, em 2s, com orientação.
 */
// Pacotes @aws-sdk que o deploy Azure TRADUZ via shim no empacotamento
// (esbuild alias → azure-dynamo-shim): projeto AWS com DynamoDB deployado na
// Azure FUNCIONA. Fora desta lista não há shim — quebra só em runtime.
const AZURE_SHIMMED_AWS_SDK = new Set(['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb']);

export function validateHandlerCloudSdk(cwd: string, provider: string): string[] {
  const errors: string[] = [];
  if (provider !== 'aws' && provider !== 'azure') return errors;
  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) return errors;

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) files.push(full);
    }
  };
  walk(srcDir);

  const offenders = new Map<string, Set<string>>(); // pacote → arquivos
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf-8');
    const pkgRe = provider === 'azure' ? /@aws-sdk\/[\w-]+/g : /@azure\/[\w-]+/g;
    for (const m of content.match(pkgRe) ?? []) {
      if (provider === 'azure' && AZURE_SHIMMED_AWS_SDK.has(m)) continue; // shim cobre
      if (!offenders.has(m)) offenders.set(m, new Set());
      offenders.get(m)!.add(path.relative(cwd, f));
    }
  }
  if (offenders.size > 0) {
    const detail = [...offenders.entries()]
      .map(([pkg, fls]) => `${pkg} (${[...fls].join(', ')})`)
      .join('; ');
    const otherCloud = provider === 'azure' ? 'AWS' : 'Azure';
    errors.push(
      `handlers usam SDK sem tradução para ${provider.toUpperCase()}: ${detail}. ` +
      (provider === 'azure'
        ? `O deploy Azure só traduz DynamoDB via shim (@aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb) — ` +
          `os demais pacotes @aws-sdk quebram em runtime (ex: S3 presigner → "Region is missing"). `
        : `O deploy AWS não traduz pacotes @azure/*. `) +
      `Para este cenário em ${provider.toUpperCase()}, gere o projeto para essa cloud (iacmp ai --provider ${provider}) — ` +
      `os handlers virão com o SDK nativo de ${provider === 'azure' ? 'Azure' : 'AWS'} (projeto gerado para ${otherCloud} continua funcionando lá).`,
    );
  }
  return errors;
}

/**
 * Bloqueia handler de Lambda-em-VPC que acessa Secrets Manager em runtime.
 * Cruza cada Fn.Lambda com vpcId ao seu arquivo de handler (src/<stem>.ts) e
 * detecta uso de SecretsManager/getSecretValue/@aws-sdk/client-secrets-manager.
 * No iacmp (sem NAT gerado), isso trava a função — a senha do banco já é
 * injetada resolvida na env DB_PASSWORD (via {{resolve:secretsmanager}}).
 */
export function validateHandlerVpcSecrets(loaded: LoadedStack[], cwd: string): string[] {
  const errors: string[] = [];
  const SECRET_USE = /SecretsManager|getSecretValue|@aws-sdk\/client-secrets-manager|from ['"]aws-sdk['"]/;

  for (const { stack } of loaded) {
    for (const c of stack.constructs) {
      if (c.type !== 'Function.Lambda') continue;
      const props = c.props as Record<string, unknown>;
      if (!props.vpcId) continue;
      const handler = props.handler as string | undefined;
      if (!handler) continue;
      const stem = handler.replace(/\.[^./]+$/, '').replace(/^(\.\/)?(dist|src)\//, '');
      const srcFile = [path.join(cwd, 'src', `${stem}.ts`), path.join(cwd, 'src', `${stem}.js`)]
        .find(p => fs.existsSync(p));
      if (!srcFile) continue;
      const content = fs.readFileSync(srcFile, 'utf-8');
      if (SECRET_USE.test(content)) {
        errors.push(
          `Fn.Lambda "${c.id}" (em VPC) → ${path.relative(cwd, srcFile)} usa Secrets Manager em runtime. ` +
          `A senha já vem resolvida na env: use process.env.DB_PASSWORD direto (padrão iacmp), sem @aws-sdk/client-secrets-manager.`,
        );
      }
    }
  }
  return errors;
}

/**
 * Bloqueia handler que acessa DynamoDB como se fosse um banco SQL. A IA
 * recorrentemente gera `pg`/`mysql` + `SELECT/INSERT ... FROM <tabela>` para
 * um projeto cujo único datastore é Database.DynamoDB — DynamoDB não fala SQL,
 * então `pg.Client.connect()` num host de DynamoDB trava e a query falha em
 * runtime. Só dispara quando NÃO há nenhum Database.SQL/DocumentDB no projeto
 * (aí o driver SQL não faz sentido) e há ao menos um Database.DynamoDB.
 */
export function validateHandlerDynamoNoSql(loaded: LoadedStack[], cwd: string): string[] {
  const errors: string[] = [];
  let hasDynamo = false;
  let hasSql = false;
  for (const { stack } of loaded) {
    for (const c of stack.constructs) {
      if (c.type === 'Database.DynamoDB') hasDynamo = true;
      if (c.type === 'Database.SQL' || c.type === 'Database.DocumentDB') hasSql = true;
    }
  }
  if (!hasDynamo || hasSql) return errors;

  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) return errors;
  const tsFiles: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) tsFiles.push(full);
    }
  };
  walk(srcDir);

  const SQL_DRIVER = /from\s+['"](pg|mysql|mysql2|pg-promise|knex|sqlite3|better-sqlite3)['"]|require\(\s*['"](pg|mysql|mysql2|pg-promise|knex|sqlite3|better-sqlite3)['"]\s*\)/;
  for (const file of tsFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    if (SQL_DRIVER.test(content)) {
      errors.push(
        `${path.relative(cwd, file)}: importa um driver SQL (pg/mysql/...) mas o projeto usa DynamoDB, que NÃO é SQL. ` +
        `Use o DocumentClient (@aws-sdk/lib-dynamodb: DynamoDBDocumentClient + GetCommand/PutCommand/QueryCommand/ScanCommand) — sem SELECT/INSERT nem pg.Client.`,
      );
    }
  }
  return errors;
}

/**
 * Bloqueia handler que consulta um GSI (`IndexName: 'X'`) que nenhuma
 * Database.DynamoDB do projeto declara em `globalSecondaryIndexes`. A IA gera
 * QueryCommand num índice (típico: 'TTLIndex' pra limpeza por TTL) sem provisionar
 * o GSI na tabela → deploya, mas a query estoura `ValidationException: The table
 * does not have the specified index` em runtime. Cruza os IndexName usados nos
 * handlers com os nomes de GSI declarados; nome inexistente → erro.
 */
export function validateHandlerDynamoGsi(loaded: LoadedStack[], cwd: string): string[] {
  const errors: string[] = [];
  const declaredIndexes = new Set<string>();
  for (const { stack } of loaded) {
    for (const c of stack.constructs) {
      if (c.type !== 'Database.DynamoDB') continue;
      const gsis = ((c.props as Record<string, unknown>).globalSecondaryIndexes as Array<Record<string, unknown>>) ?? [];
      for (const g of gsis) if (typeof g.name === 'string') declaredIndexes.add(g.name);
    }
  }
  const hasDynamo = loaded.some(({ stack }) => stack.constructs.some(c => c.type === 'Database.DynamoDB'));
  if (!hasDynamo) return errors;

  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) return errors;
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.ts') || e.name.endsWith('.js')) ? [full] : [];
  });
  for (const file of walk(srcDir)) {
    const content = fs.readFileSync(file, 'utf-8');
    const used = new Set<string>();
    for (const m of content.matchAll(/IndexName\s*:\s*['"]([^'"]+)['"]/g)) used.add(m[1]);
    const missing = [...used].filter(name => !declaredIndexes.has(name)).sort();
    if (missing.length > 0) {
      errors.push(
        `${path.relative(cwd, file)}: consulta o(s) índice(s) ${missing.map(n => `'${n}'`).join(', ')} ` +
        `mas nenhuma Database.DynamoDB declara em globalSecondaryIndexes. ` +
        `Ou declare o GSI na tabela (globalSecondaryIndexes: [{ name, partitionKey, ... }]) e libere ` +
        `\`<TableArn>/index/*\` na Policy.IAM, ou — para limpeza por TTL — troque QueryCommand(IndexName) ` +
        `por ScanCommand + FilterExpression 'attr < :now' (sem índice).`,
      );
    }
  }
  return errors;
}

/**
 * Bloqueia Fn.Lambda que define DB_USER (ou PGUSER/DB_USERNAME) como STRING
 * literal quando há um Database.SQL no projeto. O admin real varia por cloud
 * (AWS RDS e Azure flexible = 'dbadmin'), então um valor cravado como 'postgres'
 * deploya mas quebra a autenticação em runtime. Só `ref('<Db>','Username')` (que
 * o synth carrega como objeto Ref, não string) resolve pro admin certo de cada
 * cloud. Detecta o valor literal e manda trocar pelo ref.
 */
export function validateDbUserRef(loaded: LoadedStack[]): string[] {
  const errors: string[] = [];
  const hasSql = loaded.some(({ stack }) => stack.constructs.some(c => c.type === 'Database.SQL'));
  if (!hasSql) return errors;
  for (const { stack } of loaded) {
    for (const c of stack.constructs) {
      if (c.type !== 'Function.Lambda') continue;
      const env = (c.props as Record<string, unknown>).environment as Record<string, unknown> | undefined;
      if (!env) continue;
      for (const key of ['DB_USER', 'PGUSER', 'DB_USERNAME']) {
        const v = env[key];
        if (typeof v === 'string') {
          errors.push(
            `Fn.Lambda "${c.id}": ${key} está hardcoded como '${v}'. Use ref('<DbId>','Username') — ` +
            `o admin do Database.SQL varia por cloud (AWS/Azure = 'dbadmin'); um valor cravado quebra a auth em runtime.`,
          );
        }
      }
    }
  }
  return errors;
}

export function validateRedisPortRef(loaded: LoadedStack[]): string[] {
  const errors: string[] = [];
  const hasRedis = loaded.some(({ stack }) => stack.constructs.some(c => c.type === 'Cache.Redis'));
  if (!hasRedis) return errors;
  for (const { stack } of loaded) {
    for (const c of stack.constructs) {
      if (c.type !== 'Function.Lambda') continue;
      const env = (c.props as Record<string, unknown>).environment as Record<string, unknown> | undefined;
      if (!env) continue;
      for (const key of ['REDIS_PORT', 'CACHE_PORT']) {
        const v = env[key];
        if (typeof v === 'string' && v.trim() === '6379') {
          errors.push(
            `Fn.Lambda "${c.id}": ${key} hardcoded como '6379'. Redis Enterprise usa TLS na porta 10000 — ` +
            `use ref('<CacheId>','Port') que resolve para '10000'.`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Bloqueia handler que usa um nome de atributo RESERVADO do DynamoDB cru numa
 * expressão (FilterExpression/KeyConditionExpression/ConditionExpression/
 * ProjectionExpression) sem aliasar com `#`. Ex: `FilterExpression: 'ttl < :now'`
 * — `ttl` é palavra reservada → `ValidationException: Attribute name is a
 * reserved keyword` em runtime. Só considera palavras reservadas de alta
 * confiança que colidem com nomes de atributo comuns; ignora `#alias`,
 * `:placeholder` e chamadas de função (`attribute_exists(...)`, `size(...)`).
 */
export function validateHandlerDynamoReservedWords(loaded: LoadedStack[], cwd: string): string[] {
  const errors: string[] = [];
  const hasDynamo = loaded.some(({ stack }) => stack.constructs.some(c => c.type === 'Database.DynamoDB'));
  if (!hasDynamo) return errors;
  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) return errors;
  const RESERVED = new Set([
    'ttl', 'name', 'status', 'date', 'timestamp', 'type', 'data', 'value', 'count', 'size',
    'order', 'user', 'source', 'region', 'hash', 'range', 'year', 'month', 'day', 'hour',
    'minute', 'second', 'state', 'group', 'role', 'action', 'time', 'token', 'level', 'owner',
    'comment', 'connection', 'filter', 'language', 'location', 'password', 'position', 'percent',
    'view', 'zone', 'target', 'tag', 'duration', 'period', 'capacity', 'bytes', 'timezone', 'key',
  ]);
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.ts') || e.name.endsWith('.js')) ? [full] : [];
  });
  const EXPR = /(?:FilterExpression|KeyConditionExpression|ConditionExpression|ProjectionExpression)\s*:\s*(['"`])([^'"`]*)\1/g;
  const WORD = /(^|[^A-Za-z0-9_#:])([A-Za-z_][A-Za-z0-9_]*)\s*(\(?)/g;
  for (const file of walk(srcDir)) {
    const content = fs.readFileSync(file, 'utf-8');
    const flagged = new Set<string>();
    for (const m of content.matchAll(EXPR)) {
      for (const t of m[2].matchAll(WORD)) {
        if (t[3] === '(') continue;
        const word = t[2].toLowerCase();
        if (RESERVED.has(word)) flagged.add(t[2]);
      }
    }
    if (flagged.size > 0) {
      const list = [...flagged].sort();
      errors.push(
        `${path.relative(cwd, file)}: a(s) expressão(ões) DynamoDB usam nome(s) reservado(s) ${list.map(w => `'${w}'`).join(', ')} sem alias. ` +
        `Aliase com ExpressionAttributeNames (${list.map(w => `{ '#${w.toLowerCase()}': '${w}' }`).join(', ')}) e use '#${list[0].toLowerCase()}' na expressão — ` +
        `nome reservado cru estoura ValidationException: Attribute name is a reserved keyword em runtime.`,
      );
    }
  }
  return errors;
}

/**
 * Bloqueia handler que usa o driver `pg` sem `ssl` quando o projeto tem um
 * Database.SQL postgres. RDS PostgreSQL moderno recusa conexão sem TLS —
 * o erro só aparece em runtime ("no pg_hba.conf entry ... no encryption").
 * Heurística: importa 'pg' e o fonte não contém `ssl:`.
 */
export function validateHandlerPgSsl(loaded: LoadedStack[], cwd: string): string[] {
  const errors: string[] = [];
  const hasPostgres = loaded.some(({ stack }) =>
    stack.constructs.some(c => c.type === 'Database.SQL' && ((c.props as Record<string, unknown>).engine ?? 'postgres') === 'postgres'));
  if (!hasPostgres) return errors;
  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) return errors;
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.ts') || e.name.endsWith('.js')) ? [full] : [];
  });
  for (const file of walk(srcDir)) {
    const content = fs.readFileSync(file, 'utf-8');
    const usesPg = /from\s+['"]pg['"]|require\(\s*['"]pg['"]\s*\)/.test(content);
    if (usesPg && !/\bssl\s*:/.test(content)) {
      errors.push(
        `${path.relative(cwd, file)}: usa o driver pg sem \`ssl\` na config do Client. ` +
        `Adicione \`ssl: { rejectUnauthorized: false }\` — RDS PostgreSQL exige conexão encriptada.`,
      );
    }
  }
  return errors;
}

/**
 * Bloqueia Fn.Lambda cujo handler lê `process.env.X` sem que o construct
 * declare a chave em `environment`. Padrão recorrente da geração: o handler
 * usa TABLE_NAME/QUEUE_URL e o construct sai sem environment — deploya, mas
 * TODO request falha em runtime (ex: ValidationException: tableName null).
 * Ignora envs injetadas pelo runtime (AWS_*, _HANDLER etc) e NODE_ENV.
 */
export function validateHandlerEnvVars(loaded: LoadedStack[], cwd: string): string[] {
  const errors: string[] = [];
  const RUNTIME_PROVIDED = /^(AWS_|_|LAMBDA_|NODE_ENV$|TZ$)/;
  for (const { stack } of loaded) {
    for (const c of stack.constructs) {
      if (c.type !== 'Function.Lambda') continue;
      const props = c.props as Record<string, unknown>;
      const handler = props.handler as string | undefined;
      if (!handler) continue;
      const stem = handler.replace(/\.[^./]+$/, '').replace(/^(\.\/)?(dist|src)\//, '');
      const srcFile = [path.join(cwd, 'src', `${stem}.ts`), path.join(cwd, 'src', `${stem}.js`)]
        .find(p => fs.existsSync(p));
      if (!srcFile) continue;
      const content = fs.readFileSync(srcFile, 'utf-8');
      const used = new Set<string>();
      for (const m of content.matchAll(/process\.env[.[]['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\]?/g)) {
        if (!RUNTIME_PROVIDED.test(m[1])) used.add(m[1]);
      }
      if (used.size === 0) continue;
      const declared = new Set(Object.keys((props.environment as Record<string, unknown>) ?? {}));
      const missing = [...used].filter(k => !declared.has(k)).sort();
      if (missing.length > 0) {
        errors.push(
          `Fn.Lambda "${c.id}" → ${path.relative(cwd, srcFile)} lê process.env.${missing.join('/')} ` +
          `mas o construct não declara essa(s) chave(s). Adicione environment: { ${missing.map(k => `${k}: <valor ou ref(...)>`).join(', ')} } no Fn.Lambda.`,
        );
      }
    }
  }
  return errors;
}

/**
 * Bloqueia Lambda-em-VPC (subnet privada) que acessa DynamoDB/S3 sem um
 * Gateway VPC Endpoint do serviço. Sem NAT nem endpoint, a subnet privada não
 * alcança serviços da AWS fora da VPC — o SDK pendura e a Lambda dá timeout.
 * Gateway Endpoints (dynamodb/s3) são grátis e resolvem isso. Cruza cada
 * Fn.Lambda com vpcId ao seu handler; se usa o SDK do serviço, exige um
 * Network.VpcEndpoint com aquele serviço em alguma das stacks carregadas.
 */
export function validateLambdaVpcGatewayEndpoint(loaded: LoadedStack[], cwd: string): string[] {
  const errors: string[] = [];
  const endpointServices = new Set<string>();
  for (const { stack } of loaded) {
    for (const c of stack.constructs) {
      if (c.type !== 'Network.VpcEndpoint') continue;
      for (const s of ((c.props as Record<string, unknown>).services as string[]) ?? []) {
        endpointServices.add(s);
      }
    }
  }

  const SDK_BY_SERVICE: Array<{ service: string; re: RegExp }> = [
    { service: 'dynamodb', re: /@aws-sdk\/(client|lib)-dynamodb/ },
    { service: 's3', re: /@aws-sdk\/client-s3/ },
  ];

  for (const { stack } of loaded) {
    for (const c of stack.constructs) {
      if (c.type !== 'Function.Lambda') continue;
      const props = c.props as Record<string, unknown>;
      if (!props.vpcId) continue;
      const handler = props.handler as string | undefined;
      if (!handler) continue;
      const stem = handler.replace(/\.[^./]+$/, '').replace(/^(\.\/)?(dist|src)\//, '');
      const srcFile = [path.join(cwd, 'src', `${stem}.ts`), path.join(cwd, 'src', `${stem}.js`)]
        .find(p => fs.existsSync(p));
      if (!srcFile) continue;
      const content = fs.readFileSync(srcFile, 'utf-8');
      for (const { service, re } of SDK_BY_SERVICE) {
        if (re.test(content) && !endpointServices.has(service)) {
          errors.push(
            `Fn.Lambda "${c.id}" (em VPC) → ${path.relative(cwd, srcFile)} acessa ${service.toUpperCase()}, ` +
            `mas não há Gateway VPC Endpoint para '${service}'. Sem NAT, a Lambda em subnet privada não alcança o serviço e dá timeout. ` +
            `Adicione um Network.VpcEndpoint com services: ['${service}'] e os subnetIds das subnets privadas, na mesma stack da VPC.`,
          );
        }
      }
    }
  }
  return errors;
}
