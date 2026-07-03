import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DeployContext, DeployExecutor, DestroyContext, NativeCommand, StackStatus } from './types';

/** Parâmetros Bicep sem valor default — precisam vir de stacks anteriores. */
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
  containerAppName: string;
  handler: string;
  code: string;
  runtime: string;
  imageParamName: string;
}

function getSubscriptionId(): string {
  return execFileSync('az', ['account', 'show', '--query', 'id', '-o', 'tsv'], { stdio: 'pipe' }).toString().trim();
}

function acrBootstrapName(subscriptionId: string): string {
  const hash = subscriptionId.replace(/-/g, '').slice(0, 12);
  return `iacmpacr${hash}`;
}

function acrExists(name: string): boolean {
  try {
    execFileSync('az', ['acr', 'show', '--name', name, '--query', 'name', '-o', 'tsv'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Empacota o handler de uma Function.Lambda para Azure Container Apps.
 *
 * Cria em <buildDir>:
 *   handler.js  — esbuild bundle do código do usuário
 *   server.js   — adapter HTTP minimalista (sem deps externas)
 *   Dockerfile  — FROM node:20-alpine, CMD node server.js
 *
 * Retorna o path do buildDir, ou null se não encontrou o fonte do handler.
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

  const buildDir = path.join(path.dirname(templatePath), '.packaged', fn.containerAppName);
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
    logLevel: 'silent',
  });

  const adapter = `'use strict';
const http = require('http');
const { handler } = require('./handler');
const port = parseInt(process.env.PORT || '3000', 10);
http.createServer(async (req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    const rawUrl = req.url || '/';
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    const queryString = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';
    const queryStringParameters = {};
    if (queryString) {
      for (const part of queryString.split('&')) {
        const [k, v] = part.split('=');
        queryStringParameters[decodeURIComponent(k)] = decodeURIComponent(v || '');
      }
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v.join(',') : String(v);
    }
    const event = {
      httpMethod: req.method || 'GET',
      path: pathname,
      queryStringParameters,
      headers,
      body: body || null,
      isBase64Encoded: false,
    };
    try {
      const result = await handler(event, {});
      const respHeaders = result.headers || { 'Content-Type': 'application/json' };
      res.writeHead(result.statusCode || 200, respHeaders);
      res.end(result.body || '');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
}).listen(port);
`;

  fs.writeFileSync(path.join(buildDir, 'server.js'), adapter);
  fs.writeFileSync(
    path.join(buildDir, 'Dockerfile'),
    'FROM node:20-alpine\nWORKDIR /app\nCOPY handler.js server.js .\nEXPOSE 3000\nCMD ["node","server.js"]\n',
  );

  return buildDir;
}

export const azureExecutor: DeployExecutor = {
  provider: 'azure',
  requiredBinary: 'az',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const resourceGroup = requireResourceGroup(ctx);
    const commands: NativeCommand[] = [];

    // ── Empacotamento de código para Function.Lambda ──────────────────────────
    const metaPath = ctx.templatePath.replace('.bicep', '.iacmp-meta.json');
    const extraParams: string[] = [];

    if (!ctx.dryRun && fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { functions: AzureFunctionMeta[] };
      const functions = meta.functions ?? [];

      if (functions.length > 0) {
        const subscriptionId = getSubscriptionId();
        const acrName = acrBootstrapName(subscriptionId);
        const loginServer = `${acrName}.azurecr.io`;

        if (!acrExists(acrName)) {
          execFileSync('az', [
            'acr', 'create',
            '--name', acrName,
            '--resource-group', resourceGroup,
            '--sku', 'Basic',
            '--location', ctx.region,
          ], { stdio: 'inherit' });
        }
        execFileSync('az', ['acr', 'update', '--name', acrName, '--admin-enabled', 'true'], { stdio: 'pipe' });

        const credsRaw = execFileSync('az', ['acr', 'credential', 'show', '--name', acrName], { stdio: 'pipe' }).toString();
        const creds = JSON.parse(credsRaw) as { username: string; passwords: Array<{ value: string }> };
        const acrUser = creds.username;
        const acrPassword = creds.passwords[0].value;

        extraParams.push(`acrServer=${loginServer}`, `acrUser=${acrUser}`, `acrPassword=${acrPassword}`);

        // Login no ACR antes do docker build/push (sincronamente — planDeploy
        // já pode ter efeitos colaterais de leitura; login é prereq do build).
        execFileSync('az', ['acr', 'login', '--name', acrName], { stdio: 'pipe' });

        for (const fn of functions) {
          const buildDir = buildFunctionBundle(ctx.cwd, fn, ctx.templatePath);
          if (buildDir) {
            const fullImage = `${loginServer}/${fn.containerAppName}:latest`;
            // docker build + push localmente (Docker daemon obrigatório).
            // --platform linux/amd64: Azure Container Apps exige amd64;
            // sem isso, build em Apple Silicon gera ARM64 e o deploy rejeita.
            commands.push({ bin: 'docker', args: ['build', '--platform', 'linux/amd64', '-t', fullImage, buildDir] });
            commands.push({ bin: 'docker', args: ['push', fullImage] });
            extraParams.push(`${fn.imageParamName}=${fullImage}`);
          }
        }
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
    }
    if (paramValues.length > 0) {
      args.push('--parameters', ...paramValues);
    }

    commands.push({ bin: 'az', args });
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
