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
  /** Path patterns das rotas APIM que apontam pra este Function App (ex: "/files/{key}", "/files/{key+}"). */
  routePatterns?: string[];
}

/**
 * Empacota o handler de uma Function.Lambda para Azure Function App (zip deploy).
 *
 * Cria em <buildDir>:
 *   handler.js              — esbuild bundle do código do usuário
 *   host.json               — config do Azure Functions host (v2, routePrefix vazio)
 *   HttpTrigger/
 *     function.json         — binding HTTP catch-all (v3 programming model)
 *     index.js              — adapter que converte Azure Functions request → Lambda event
 *
 * Retorna o path do buildDir (a ser zipado e enviado via az functionapp deployment source config-zip),
 * ou null se não encontrou o fonte do handler.
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
  ].find(p => fs.existsSync(p));

  if (!srcEntry) return null;

  if (!fn.functionAppName) {
    throw new Error(`[${fn.constructId}] functionAppName não encontrado em .iacmp-meta.json — rode 'iacmp synth' novamente`);
  }

  const buildDir = path.join(path.dirname(templatePath), '.packaged', fn.functionAppName);
  fs.mkdirSync(buildDir, { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let esbuild: { buildSync: (opts: Record<string, unknown>) => unknown };
  try {
    esbuild = require('esbuild') as typeof esbuild;
  } catch {
    throw new Error('esbuild não encontrado. Rode `npm install` no iacmp.');
  }

  esbuild.buildSync({
    entryPoints: [srcEntry],
    outfile: path.join(buildDir, 'handler.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: [],
    // @azure/storage-blob e outros SDKs Azure usam createRequire(import.meta.url).
    // Em bundle CJS o esbuild deixa import.meta.url como undefined → crash no boot.
    banner: { js: `const __iacmp_meta_url = require('url').pathToFileURL(__filename).href;` },
    define: { 'import.meta.url': '__iacmp_meta_url' },
    logLevel: 'silent',
  });

  // host.json: Azure Functions v2 runtime com routePrefix vazio para rotas limpas
  fs.writeFileSync(
    path.join(buildDir, 'host.json'),
    JSON.stringify({
      version: '2.0',
      extensions: { http: { routePrefix: '' } },
      extensionBundle: {
        id: 'Microsoft.Azure.Functions.ExtensionBundle',
        version: '[4.*, 5.0.0)',
      },
    }, null, 2),
  );

  // HttpTrigger: função HTTP catch-all (programming model v3, sem deps externas)
  const triggerDir = path.join(buildDir, 'HttpTrigger');
  fs.mkdirSync(triggerDir, { recursive: true });

  fs.writeFileSync(
    path.join(triggerDir, 'function.json'),
    JSON.stringify({
      bindings: [
        {
          authLevel: 'anonymous',
          type: 'httpTrigger',
          direction: 'in',
          name: 'req',
          route: '{*route}',
          methods: ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'],
        },
        { type: 'http', direction: 'out', name: 'res' },
      ],
    }, null, 2),
  );

  // routePatterns injetados como JSON literal — permite extrair path params nomeados.
  const routePatternsJson = JSON.stringify(fn.routePatterns ?? []);

  const adapter = `'use strict';
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

module.exports = async function (context, req) {
  const rawUrl = req.originalUrl || '/';
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

  // Event Grid blob trigger: validação e BlobCreated → Lambda Records format.
  const aegEventType = req.headers && req.headers['aeg-event-type'];
  if (aegEventType || pathname === '/events' || pathname.endsWith('/events')) {
    const rawBody = req.rawBody;
    const bodyStr = rawBody === undefined || rawBody === null ? '[]' : (typeof rawBody === 'string' ? rawBody : String(rawBody));
    let egEvents;
    try { egEvents = JSON.parse(bodyStr || '[]'); } catch (_) { egEvents = []; }
    if (!Array.isArray(egEvents)) egEvents = [egEvents];
    if (egEvents.length > 0 && (egEvents[0].eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent' || egEvents[0].eventType === 'Microsoft.EventGrid.SubscriptionValidation')) {
      const validationCode = egEvents[0].data && egEvents[0].data.validationCode;
      const validationUrl = egEvents[0].data && egEvents[0].data.validationUrl;
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ validationResponse: validationCode }) };
      if (validationUrl) {
        try { require('https').get(validationUrl, function(r) { r.resume(); }); } catch (_) {}
      }
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
        context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' };
      } catch (egErr) {
        context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(egErr) }) };
      }
    } else {
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' };
    }
    return;
  }

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
  const titleCase = (s) => s.replace(/(?:^|-)([a-z])/g, (_, c) => c.toUpperCase());
  for (const k of Object.keys(headers)) { const tc = titleCase(k); if (tc !== k) headers[tc] = headers[k]; }

  const segments = pathname.split('/').filter(Boolean);
  const namedParams = routePatterns.length > 0 ? matchRoute(pathname) : null;
  const pathParameters = segments.length >= 2
    ? { id: decodeURIComponent(segments[1]), proxy: segments.slice(1).join('/'), ...(namedParams || {}) }
    : (namedParams && Object.keys(namedParams).length > 0 ? namedParams : null);

  const rawBodyVal = req.rawBody;
  const bodyStr2 = rawBodyVal === undefined || rawBodyVal === null ? null : (typeof rawBodyVal === 'string' ? rawBodyVal : String(rawBodyVal));

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
    context.res = {
      status: result.statusCode || 200,
      headers: result.headers || { 'Content-Type': 'application/json' },
      body: result.body || '',
    };
  } catch (err) {
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
`;

  fs.writeFileSync(path.join(triggerDir, 'index.js'), adapter);

  return buildDir;
}

export const azureExecutor: DeployExecutor = {
  provider: 'azure',
  requiredBinary: 'az',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const resourceGroup = requireResourceGroup(ctx);
    const commands: NativeCommand[] = [];

    // ── Empacotamento de código para Function.Lambda (zip deploy) ─────────────
    const metaPath = ctx.templatePath.replace('.bicep', '.iacmp-meta.json');
    const extraParams: string[] = [];

    let functions: AzureFunctionMeta[] = [];
    const buildDirsByConstructId = new Map<string, string>();

    if (!ctx.dryRun && fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { functions: AzureFunctionMeta[] };
      functions = meta.functions ?? [];
      // Pré-compila bundles antes do ARM deploy para falhar cedo se o fonte não existe.
      for (const fn of functions) {
        const buildDir = buildFunctionBundle(ctx.cwd, fn, ctx.templatePath);
        if (buildDir) buildDirsByConstructId.set(fn.constructId, buildDir);
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

    const paramValues: string[] = [...extraParams];
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

    // ── Zip deploy pós-ARM para cada Function App ─────────────────────────────
    // Executado APÓS o az stack group create — lê os outputs para obter o nome
    // real do Function App (gerado com uniqueString no Bicep) e faz config-zip.
    if (!ctx.dryRun && functions.length > 0) {
      const stackName = ctx.stackName;
      commands.push({
        bin: 'node',
        args: ['-e', ''],
        preRun: () => {
          const outputs = getAzureStackOutputs(stackName, resourceGroup);
          const outputsByLower = new Map(Object.entries(outputs).map(([k, v]) => [k.toLowerCase(), v]));
          for (const fn of functions) {
            const outputKey = `${fn.constructId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}functionappname`;
            const fnAppName = outputsByLower.get(outputKey);
            if (!fnAppName) {
              process.stdout.write(`[iacmp] Output "${outputKey}" não encontrado. Pulando zip deploy para ${fn.constructId}.\n`);
              continue;
            }
            const buildDir = buildDirsByConstructId.get(fn.constructId);
            if (!buildDir) {
              process.stdout.write(`[iacmp] Bundle não encontrado para ${fn.constructId}. Pulando zip deploy.\n`);
              continue;
            }
            const zipPath = `${buildDir}.zip`;
            process.stdout.write(`[iacmp] Compactando ${fn.constructId} → ${zipPath}\n`);
            execFileSync('zip', ['-r', zipPath, '.'], { cwd: buildDir, stdio: 'pipe' });
            process.stdout.write(`[iacmp] Deployando código de ${fn.constructId} → ${fnAppName}\n`);
            execFileSync('az', [
              'functionapp', 'deployment', 'source', 'config-zip',
              '--resource-group', resourceGroup,
              '--name', fnAppName,
              '--src', zipPath,
            ], { stdio: 'inherit' });
            try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
          }
        },
      });
    }

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
