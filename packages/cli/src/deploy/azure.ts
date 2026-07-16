import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeployContext, DeployExecutor, DestroyContext, NativeCommand, StackStatus } from './types';

/** Parâmetros Bicep sem valor default — precisam vir de stacks anteriores. */
// Senha do run: gerada uma vez por processo (mesmo valor em todas as stacks do
// deploy). Prefixo garante as classes de caractere que o flexible server exige.
let runAdminPassword: string | null = null;
function getRunAdminPassword(): string {
  if (!runAdminPassword) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto') as typeof import('crypto');
    runAdminPassword = `Ia1${crypto.randomBytes(18).toString('base64url')}`;
  }
  return runAdminPassword;
}

function getCrossStackParams(templatePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    return []; // template ilegível/inexistente — sem params conhecidos (dry-run/testes)
  }
  const params: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^param\s+(\w+)\s+\w+\s*$/);
    if (m) params.push(m[1]);
  }
  return params;
}

/** Params com default '' (soft) — injetados quando disponíveis, sem erro se ausentes. */
function getSoftCrossStackParams(templatePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    return [];
  }
  const params: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^param\s+(\w+)\s+string\s*=\s*''\s*$/);
    if (m) params.push(m[1]);
  }
  return params;
}

/**
 * Retorna true se o nome do parâmetro (no formato "key=value") corresponde a uma
 * credencial que NÃO deve aparecer na linha de comando (visível em `ps aux`).
 * Regra: qualquer key cujo nome termine em "password" (case-insensitive).
 */
function isSecretParam(paramKv: string): boolean {
  const key = paramKv.split('=')[0];
  return /password$/i.test(key);
}

/** Lê outputs de uma deployment stack do Azure (pós-deploy). */
export function getAzureStackOutputs(stackName: string, resourceGroup: string): Record<string, string> {
  try {
    const raw = execFileSync('az', [
      'stack', 'group', 'show',
      '--name', stackName,
      '--resource-group', resourceGroup,
      '--query', 'outputs',
      '--output', 'json',
    ], { stdio: 'pipe' }).toString().trim();
    if (!raw || raw === 'null') return {};
    const outputs = JSON.parse(raw) as Record<string, { value: string }>;
    return Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v.value]));
  } catch {
    return {};
  }
}

/**
 * APIMs vivos no RG — capturar ANTES do destroy (depois só existe o soft-deleted).
 * O delete de APIM o move para soft-delete (48h): ocupa o NOME (re-deploy do
 * mesmo projeto colide) e segura o ARM por minutos após o RG esvaziar.
 */
export function listApimServices(resourceGroup: string): { name: string; location: string }[] {
  try {
    const raw = execFileSync('az', [
      'apim', 'list', '--resource-group', resourceGroup,
      '--query', '[].{name:name,location:location}', '--output', 'json',
    ], { stdio: 'pipe' }).toString().trim();
    return raw ? (JSON.parse(raw) as { name: string; location: string }[]) : [];
  } catch {
    return [];
  }
}

/**
 * Dispara a purga dos APIMs soft-deleted em processo DESTACADO (fire-and-forget):
 * `az apim deletedservice purge` não tem --no-wait e bloqueia minutos — não vale
 * segurar o destroy por isso. Se a purga falhar, o soft-delete expira em 48h.
 */
export function purgeApimSoftDeleted(services: { name: string; location: string }[]): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawn } = require('child_process') as typeof import('child_process');
  for (const s of services) {
    const child = spawn('az', [
      'apim', 'deletedservice', 'purge',
      '--service-name', s.name, '--location', s.location,
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  }
}

/** `az group exists` — leitura simples, sem efeito colateral. Usado antes do deploy para decidir se precisa criar o resource group. */
export function resourceGroupExists(resourceGroup: string): boolean {
  try {
    const out = execFileSync('az', ['group', 'exists', '--name', resourceGroup], { stdio: 'pipe' }).toString().trim();
    return out === 'true';
  } catch {
    return false;
  }
}

function requireResourceGroup(ctx: { resourceGroup?: string }): string {
  if (!ctx.resourceGroup) {
    throw new Error('Configure "resourceGroup" no iacmp.json para usar --provider azure (ex: "resourceGroup": "meu-rg").');
  }
  return ctx.resourceGroup;
}

interface AzureFunctionMeta {
  constructId: string;
  functionAppName: string;
  handler: string;
  code: string;
  runtime: string;
  routePatterns?: string[];
}

/**
 * Empacota o handler de uma Function.Lambda para Azure Functions (zip deploy).
 *
 * Cria em <buildDir>:
 *   handler.js                 — esbuild bundle do código do usuário
 *   host.json                  — configuração do host Azure Functions v4
 *   HttpTrigger/function.json  — bindings (httpTrigger anônimo + http out)
 *   HttpTrigger/index.js       — adapter Lambda event ↔ Azure Functions context
 *
 * Retorna o path do zip gerado, ou null se não encontrou o fonte do handler.
 */
function buildFunctionBundle(
  cwd: string,
  fn: AzureFunctionMeta,
  templatePath: string,
): string | null {
  const handlerPath = fn.handler;
  const modulePath = handlerPath.replace(/\.[^./]+$/, '');
  const stem = modulePath.replace(/^(\.\/)?(dist|src)\//, '');

  const srcEntry = [
    path.join(cwd, 'src', `${stem}.ts`),
    path.join(cwd, 'src', `${stem}.js`),
    path.join(cwd, 'src', stem, 'index.ts'),
    path.join(cwd, 'src', stem, 'index.js'),
    path.join(cwd, `${stem}.ts`),
    path.join(cwd, `${stem}.js`),
    path.join(cwd, stem, 'index.ts'),
    path.join(cwd, stem, 'index.js'),
  ].find(p => fs.existsSync(p));

  if (!srcEntry) return null;

  const buildDir = path.join(path.dirname(templatePath), '.packaged', fn.functionAppName);
  fs.mkdirSync(path.join(buildDir, 'HttpTrigger'), { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let esbuild: { buildSync: (opts: Record<string, unknown>) => unknown };
  try {
    esbuild = require('esbuild') as typeof esbuild;
  } catch {
    throw new Error('esbuild não encontrado. Rode `npm install` no iacmp.');
  }

  // __dirname em runtime é dist/commands/ (tsup bundla cada command ali)
  // o shim fica em dist/deploy/ — tentamos os dois e usamos o que existe
  const shimCandidates = [
    path.resolve(__dirname, 'azure-dynamo-shim.js'),
    path.resolve(__dirname, '../deploy/azure-dynamo-shim.js'),
    path.resolve(__dirname, 'deploy/azure-dynamo-shim.js'),
  ];
  const shimPath = shimCandidates.find(p => fs.existsSync(p)) ?? shimCandidates[0];
  const s3ShimPath = shimPath.replace('azure-dynamo-shim', 'azure-s3-shim');
  const azureSdkNodePaths: string[] = [];
  for (const pkg of ['@azure/data-tables', '@azure/storage-blob']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkgPath = require.resolve(`${pkg}/package.json`) as string;
      const nm = path.resolve(path.dirname(pkgPath), '..', '..', 'node_modules');
      if (!azureSdkNodePaths.includes(nm)) azureSdkNodePaths.push(nm);
    } catch {
      // pacote não encontrado — esbuild vai falhar se o shim o referenciar
    }
  }

  esbuild.buildSync({
    entryPoints: [srcEntry],
    outfile: path.join(buildDir, 'handler.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: [],
    alias: {
      '@aws-sdk/client-dynamodb': shimPath,
      '@aws-sdk/lib-dynamodb': shimPath,
      '@aws-sdk/client-s3': s3ShimPath,
      '@aws-sdk/s3-request-presigner': s3ShimPath,
    },
    nodePaths: azureSdkNodePaths,
    banner: { js: `const __iacmp_meta_url = require('url').pathToFileURL(__filename).href;` },
    define: { 'import.meta.url': '__iacmp_meta_url' },
    logLevel: 'silent',
  });

  fs.writeFileSync(path.join(buildDir, 'host.json'), JSON.stringify({
    version: '2.0',
    logging: { applicationInsights: { samplingSettings: { isEnabled: true } } },
    extensionBundle: { id: 'Microsoft.Azure.Functions.ExtensionBundle', version: '[4.*, 5.0.0)' },
  }, null, 2));

  fs.writeFileSync(path.join(buildDir, 'HttpTrigger', 'function.json'), JSON.stringify({
    bindings: [
      {
        authLevel: 'anonymous',
        type: 'httpTrigger',
        direction: 'in',
        name: 'req',
        methods: ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'],
        route: '{*path}',
      },
      { type: 'http', direction: 'out', name: 'res' },
    ],
  }, null, 2));

  const routePatternsJson = JSON.stringify(fn.routePatterns ?? []);

  const indexJs = `'use strict';
const { handler } = require('../handler');
const routePatterns = ${routePatternsJson};

function matchRoute(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  for (const pattern of routePatterns) {
    const parts = pattern.split('/').filter(Boolean);
    const lastPart = parts.length > 0 ? parts[parts.length - 1] : '';
    const isGreedy = /^\\{\\w+\\+\\}$/.test(lastPart);
    if (isGreedy ? segs.length < parts.length : segs.length !== parts.length) continue;
    const named = {};
    let match = true;
    for (let i = 0; i < parts.length; i++) {
      const gm = parts[i].match(/^\\{(\\w+)\\+\\}$/);
      if (gm) { named[gm[1]] = segs.slice(i).map(decodeURIComponent).join('/'); break; }
      const nm = parts[i].match(/^\\{(\\w+)\\}$/);
      if (nm) { named[nm[1]] = decodeURIComponent(segs[i]); }
      else if (parts[i] !== segs[i]) { match = false; break; }
    }
    if (match) return named;
  }
  return null;
}

module.exports = async function(context, req) {
  const rawUrl = req.url || '/';
  let pathname, queryString;
  try {
    const u = new URL(rawUrl);
    pathname = u.pathname;
    queryString = u.search ? u.search.slice(1) : '';
  } catch (_) {
    const qIdx = rawUrl.indexOf('?');
    pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    queryString = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';
  }

  // Azure Functions passa o pathname com o prefixo /api/HttpTrigger — remove para
  // que os route patterns e o pathParameters.id correspondam ao path real da API.
  if (pathname.startsWith('/api/HttpTrigger')) {
    pathname = pathname.slice('/api/HttpTrigger'.length) || '/';
  }

  // Event Grid blob trigger
  const aegEventType = req.headers && req.headers['aeg-event-type'];
  if (aegEventType || pathname === '/api/events' || pathname.endsWith('/events')) {
    const bodyStr = req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : '[]';
    let egEvents;
    try { egEvents = JSON.parse(bodyStr || '[]'); } catch (_) { egEvents = []; }
    if (!Array.isArray(egEvents)) egEvents = [egEvents];
    if (egEvents.length > 0 && (egEvents[0].eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent' || egEvents[0].eventType === 'Microsoft.EventGrid.SubscriptionValidation')) {
      const validationCode = egEvents[0].data && egEvents[0].data.validationCode;
      context.res = { status: 200, body: JSON.stringify({ validationResponse: validationCode }), headers: { 'Content-Type': 'application/json' } };
      return;
    }
    const blobRecords = egEvents
      .filter(function(e) { return e.eventType === 'Microsoft.Storage.BlobCreated'; })
      .map(function(e) {
        const subject = e.subject || '';
        const blobIdx = subject.indexOf('/blobs/');
        const key = blobIdx >= 0 ? subject.slice(blobIdx + 7) : '';
        const contIdx = subject.indexOf('/containers/');
        const contEnd = subject.indexOf('/', contIdx + 12);
        const container = contIdx >= 0 ? subject.slice(contIdx + 12, contEnd >= 0 ? contEnd : undefined) : '';
        return { eventSource: 'aws:s3', s3: { bucket: { name: container }, object: { key: decodeURIComponent(key) } } };
      });
    if (blobRecords.length > 0) {
      try {
        await handler({ Records: blobRecords }, {});
        context.res = { status: 200, body: '{}', headers: { 'Content-Type': 'application/json' } };
      } catch (egErr) {
        context.res = { status: 500, body: JSON.stringify({ error: String(egErr) }), headers: { 'Content-Type': 'application/json' } };
      }
    } else {
      context.res = { status: 200, body: '{}', headers: { 'Content-Type': 'application/json' } };
    }
    return;
  }

  // Regular HTTP
  const queryStringParameters = {};
  if (queryString) {
    for (const part of queryString.split('&')) {
      if (!part) continue;
      const eqIdx = part.indexOf('=');
      const k = eqIdx >= 0 ? part.slice(0, eqIdx) : part;
      const v = eqIdx >= 0 ? part.slice(eqIdx + 1) : '';
      queryStringParameters[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    headers[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  const titleCase = function(s) { return s.replace(/(?:^|-)([a-z])/g, function(_, c) { return c.toUpperCase(); }); };
  for (const k of Object.keys(headers)) { const tc = titleCase(k); if (tc !== k) headers[tc] = headers[k]; }

  const segments = pathname.split('/').filter(Boolean);
  const namedParams = routePatterns.length > 0 ? matchRoute(pathname) : null;
  const pathParameters = segments.length >= 2
    ? { id: decodeURIComponent(segments[1]), proxy: segments.slice(1).join('/'), ...(namedParams || {}) }
    : (namedParams && Object.keys(namedParams).length > 0 ? namedParams : null);

  const bodyStr2 = req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : null;

  const event = {
    httpMethod: req.method || 'GET',
    path: pathname,
    pathParameters,
    queryStringParameters,
    headers,
    body: bodyStr2,
    isBase64Encoded: false,
  };

  try {
    const result = await handler(event, {});
    context.res = { status: result.statusCode || 200, headers: result.headers || { 'Content-Type': 'application/json' }, body: result.body || '' };
  } catch (err) {
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(err) }) };
  }
};
`;

  fs.writeFileSync(path.join(buildDir, 'HttpTrigger', 'index.js'), indexJs);

  const zipPath = path.join(path.dirname(templatePath), '.packaged', `${fn.functionAppName}.zip`);
  try { fs.unlinkSync(zipPath); } catch { /* não existe ainda */ }
  execFileSync('zip', ['-r', zipPath, '.'], { cwd: buildDir, stdio: 'pipe' });

  return zipPath;
}

export const azureExecutor: DeployExecutor = {
  provider: 'azure',
  requiredBinary: 'az',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const resourceGroup = requireResourceGroup(ctx);
    const commands: NativeCommand[] = [];

    const metaPath = ctx.templatePath.replace('.bicep', '.iacmp-meta.json');
    const zipCmds: NativeCommand[] = [];

    if (!ctx.dryRun && fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { functions: AzureFunctionMeta[] };
      const functions: AzureFunctionMeta[] = meta.functions ?? [];

      for (const fn of functions) {
        process.stdout.write(`[iacmp] Empacotando ${fn.constructId} para Azure Functions...\n`);
        const zipPath = buildFunctionBundle(ctx.cwd, fn, ctx.templatePath);
        if (!zipPath) {
          process.stdout.write(`[iacmp] Handler não encontrado para ${fn.constructId} — zip ignorado.\n`);
          continue;
        }
        const outputKey = fn.constructId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() + 'functionappname';
        const lazyCmd: NativeCommand = { bin: 'az', args: [] };
        lazyCmd.preRun = () => {
          const outputs = getAzureStackOutputs(ctx.stackName, resourceGroup);
          const appName = outputs[outputKey] ?? outputs[Object.keys(outputs).find(k => k.toLowerCase() === outputKey) ?? ''];
          if (!appName) throw new Error(`Nome da Function App "${fn.constructId}" não encontrado nos outputs da stack "${ctx.stackName}".`);
          process.stdout.write(`[iacmp] Publicando zip na Function App ${appName}...\n`);
          lazyCmd.args = [
            'functionapp', 'deployment', 'source', 'config-zip',
            '--name', appName,
            '--resource-group', resourceGroup,
            '--src', zipPath,
          ];
        };
        zipCmds.push(lazyCmd);
      }
    }

    // Usa "deployment stacks" (az stack group) em vez de `az deployment group
    // create` — dá um objeto rastreável que o destroy consegue remover por
    // completo (todos os recursos que ele criou), igual ao stack do CloudFormation.
    const args = [
      'stack', 'group', 'create',
      '--name', ctx.stackName,
      '--resource-group', resourceGroup,
      '--template-file', ctx.templatePath,
      '--deny-settings-mode', 'none',
      '--action-on-unmanage', 'deleteResources',
      '--yes',
    ];

    const paramValues: string[] = [];
    if (ctx.templatePath) {
      const crossParams = getCrossStackParams(ctx.templatePath);
      // adminPassword (@secure, sem default): o deploy gera UMA senha forte por
      // execução e injeta a MESMA em toda stack que declara o param — o servidor
      // Postgres/MySQL e as envs dos handlers (ref('AppDB','Password')) batem.
      if (crossParams.includes('adminPassword')) {
        paramValues.push(`adminPassword=${getRunAdminPassword()}`);
      }
      // Cross-params de senha (ex: AppDBPassword, vindos de ref('AppDB','Password')
      // em OUTRA stack): senha nunca é output (secure) — injeta a MESMA senha do
      // run, que é a que o servidor recebeu via adminPassword.
      for (const p of crossParams) {
        if (/password$/i.test(p) && p !== 'adminPassword') {
          paramValues.push(`${p}=${getRunAdminPassword()}`);
        }
      }
      const provided = new Set(paramValues.map(p => p.split('=')[0]));
      // A API do Azure devolve as chaves de outputs em camelCase mesmo quando o
      // Bicep declara PascalCase (`output ItemsTableName` → chave `itemsTableName`)
      // — o match do param com o output precisa ser case-insensitive.
      const outputsByLower = new Map(
        Object.entries(ctx.outputParams ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const missing: string[] = [];
      for (const p of crossParams) {
        if (provided.has(p)) continue;
        const value = outputsByLower.get(p.toLowerCase());
        if (value !== undefined) {
          paramValues.push(`${p}=${value}`);
        } else {
          missing.push(p);
        }
      }
      // Sem isso o `az` cai num prompt interativo pedindo o valor — pendura o
      // deploy em vez de falhar. Param cross-stack sem output correspondente
      // significa que a stack exportadora não foi deployada (ou falhou) antes.
      if (missing.length > 0) {
        throw new Error(
          `Stack "${ctx.stackName}" precisa de parâmetro(s) cross-stack sem valor: ${missing.join(', ')}. ` +
          `A stack que exporta esse(s) output(s) precisa ser deployada antes e com sucesso. ` +
          `Rode "iacmp deploy --provider azure" sem --stack para a ordem automática, ou verifique se a stack exportadora falhou.`,
        );
      }
      // Soft params (default ''): injetados quando disponíveis, sem erro se ausentes.
      // Usados pelo mecanismo de 2º passo para Event Grid subscriptions cross-stack —
      // 1º passo deploya sem o FQDN (subscrição não é criada por Bicep if-condition);
      // 2º passo re-deploya com FQDN disponível nos outputs acumulados.
      //
      // EXCEÇÃO sharedCaeId: não injetar se o valor em outputsByLower veio da PRÓPRIA
      // stack (output da 1ª passagem). Injetar o próprio sharedCaeId torna
      // empty(sharedCaeId)=false → CAE sai do template → ARM tenta deletar o env
      // → DeploymentStackDeleteResourcesFailed (CAE tem Container Apps attachados).
      // Para detectar auto-injeção: lê os outputs ATUAIS da stack e compara.
      let ownSharedCaeId: string | undefined;
      if (ctx.stackName && ctx.resourceGroup) {
        const ownOutputs = getAzureStackOutputs(ctx.stackName, ctx.resourceGroup);
        ownSharedCaeId = ownOutputs['sharedCaeId'];
      }
      const softParams = getSoftCrossStackParams(ctx.templatePath!);
      const providedAfterHard = new Set(paramValues.map(p => p.split('=')[0]));
      for (const p of softParams) {
        if (providedAfterHard.has(p)) continue;
        const value = outputsByLower.get(p.toLowerCase());
        if (!value) continue;
        // Pular injeção de sharedCaeId se o valor é o CAE desta própria stack.
        if (p === 'sharedCaeId' && ownSharedCaeId && value === ownSharedCaeId) continue;
        paramValues.push(`${p}=${value}`);
        // Sem erro se ausente — o default '' é válido (subscrição condicional não é criada)
      }
    }
    // Separa parâmetros em plain (podem ir na command line) e secret (jamais na
    // command line — seriam visíveis em `ps aux` para qualquer processo local).
    const plainParams = paramValues.filter(p => !isSecretParam(p));
    const secretParams = paramValues.filter(p => isSecretParam(p));

    // displayArgs: versão mascarada usada em --dry-run e mensagens de erro.
    // Nunca expõe valores reais — substitui o value de cada secret por "***".
    const displayArgs = [...args];
    if (paramValues.length > 0) {
      displayArgs.push(
        '--parameters',
        ...plainParams,
        ...secretParams.map(p => `${p.split('=')[0]}=***`),
      );
    }

    if (secretParams.length > 0 && !ctx.dryRun) {
      // Deploy real com secrets: escreve num arquivo temporário fora do repo,
      // com permissão 0600 (só o processo corrente pode ler), e passa @arquivo
      // para o az. O arquivo é apagado no finally via cleanup(), mesmo se o
      // deploy falhar — nunca fica em disco após o comando.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const crypto = require('crypto') as typeof import('crypto');
      const tmpFile = path.join(
        os.tmpdir(),
        `iacmp-params-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`,
      );
      const armParameters: Record<string, { value: string }> = {};
      for (const p of secretParams) {
        const eqIdx = p.indexOf('=');
        armParameters[p.slice(0, eqIdx)] = { value: p.slice(eqIdx + 1) };
      }
      fs.writeFileSync(
        tmpFile,
        JSON.stringify({
          $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
          contentVersion: '1.0.0.0',
          parameters: armParameters,
        }),
        { mode: 0o600 },
      );
      // args reais: params plain inline + secrets via @arquivo (nunca na command line)
      if (paramValues.length > 0) {
        args.push('--parameters', ...plainParams, `@${tmpFile}`);
      }
      commands.push({
        bin: 'az',
        args,
        displayArgs,
        preRun: () => waitForStackTerminal(ctx.stackName, resourceGroup),
        cleanup: () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } },
        onError: () => recoverFromAzCliCrash(ctx.stackName, resourceGroup),
      });
    } else {
      // dry-run (comando não será executado) ou sem secrets: params inline.
      // Em dry-run, args contém os valores reais mas printPlan usa displayArgs
      // (mascarado) — os secrets nunca chegam ao terminal.
      if (paramValues.length > 0) {
        args.push('--parameters', ...paramValues);
      }
      commands.push({ bin: 'az', args, displayArgs, preRun: () => waitForStackTerminal(ctx.stackName, resourceGroup), onError: () => recoverFromAzCliCrash(ctx.stackName, resourceGroup) });
    }

    commands.push(...zipCmds);
    return commands;
  },

  async planDestroy(ctx: DestroyContext): Promise<NativeCommand[]> {
    const resourceGroup = requireResourceGroup(ctx);
    return [{
      bin: 'az',
      args: [
        'stack', 'group', 'delete',
        '--name', ctx.stackName,
        '--resource-group', resourceGroup,
        '--action-on-unmanage', 'deleteAll',
        '--yes',
      ],
    }];
  },

  describeStatus(stackName: string, ctx: { resourceGroup?: string }): StackStatus {
    if (!ctx.resourceGroup) return { deployed: false };
    return describeStackStatus(stackName, ctx.resourceGroup);
  },

  async pollStatus(stackName: string, ctx: { resourceGroup?: string }): Promise<string | null> {
    if (!ctx.resourceGroup) return null;
    try {
      const out = execFileSync('az', [
        'stack', 'group', 'show',
        '--name', stackName,
        '--resource-group', ctx.resourceGroup,
        '--query', 'provisioningState',
        '--output', 'tsv',
      ], { stdio: 'pipe' }).toString().trim();
      return out || null;
    } catch {
      return null;
    }
  },
};

export function describeStackStatus(stackName: string, resourceGroup: string): StackStatus {
  try {
    const status = execFileSync(
      'az',
      ['stack', 'group', 'show', '--name', stackName, '--resource-group', resourceGroup, '--query', 'provisioningState', '--output', 'tsv'],
      { stdio: 'pipe' }
    ).toString().trim();
    return { deployed: true, status };
  } catch {
    return { deployed: false };
  }
}

// Azure ARM retorna provisioningState em camelCase mas pode ser lowercase dependendo da versão
// da API ou do CLI. Incluímos ambas as formas para garantir.
const NON_TERMINAL_STATES = new Set([
  'Deploying', 'deploying',
  'DeletingResources', 'deletingResources', 'deleting', 'Deleting',
  'Canceling', 'canceling',
  'Validating', 'validating',
]);

/**
 * Bloqueia até que a deployment stack saia de um estado não-terminal.
 * Polling a cada 30s — timeout 30min (60 tentativas).
 * Usado como preRun no az stack group create para evitar DeploymentStackInNonTerminalState.
 */
function waitForStackTerminal(stackName: string, resourceGroup: string): void {
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    const { deployed, status } = describeStackStatus(stackName, resourceGroup);
    if (!deployed) return;
    if (!status || !NON_TERMINAL_STATES.has(status)) return;
    process.stdout.write(`[iacmp] Stack "${stackName}" em estado "${status}" — aguardando... (${i + 1}/${maxAttempts})\n`);
    // Espera síncrona: deployment stacks de Container App Environment levam 15-20min
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  }
  throw new Error(`Stack "${stackName}" continua em estado não-terminal após 30 minutos. Cancele o deploy no portal e tente novamente.`);
}

/**
 * Recuperação de crash do az CLI 2.87.0 com "RuntimeError: content already consumed".
 * O CLI crasha localmente mas o deploy pode ter iniciado no ARM. Espera o stack
 * chegar a um estado terminal e valida se teve sucesso. Se sim, suprime o erro
 * original; se não, lança erro indicando falha real.
 */
function recoverFromAzCliCrash(stackName: string, resourceGroup: string): void {
  const { deployed } = describeStackStatus(stackName, resourceGroup);
  if (!deployed) {
    // Stack não existe no ARM — falha real, não recuperável.
    throw new Error(
      `Stack "${stackName}" não pôde ser criada. Verifique o portal Azure para detalhes.`
    );
  }
  // Stack existe e pode estar deploying — aguarda até estado terminal.
  process.stdout.write(`[iacmp] az CLI crashou localmente mas deploy iniciou no ARM. Aguardando stack "${stackName}"...\n`);
  waitForStackTerminal(stackName, resourceGroup);
  const { status } = describeStackStatus(stackName, resourceGroup);
  if (status && /fail/i.test(status)) {
    throw new Error(
      `Stack "${stackName}" falhou (status: ${status}). Verifique o portal Azure para detalhes do erro.`
    );
  }
  process.stdout.write(`[iacmp] Stack "${stackName}" concluída com sucesso (recuperado de crash do az CLI).\n`);
}
