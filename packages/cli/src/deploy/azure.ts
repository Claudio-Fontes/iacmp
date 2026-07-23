import { execFileSync, spawnSync } from 'child_process';
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

/** Nomes dos outputs que sinalizam storage accounts com static website a ativar pós-deploy. */
function getStaticWebsiteOutputKeys(templatePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    return [];
  }
  const keys: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^output\s+(\w+StaticWebsiteAccount)\s+/);
    if (m) keys.push(m[1]);
  }
  return keys;
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

interface AzureContainerBuildMeta {
  constructId: string;
  imageParamName: string;
  repository: string;
  tag: string;
  context: string;
  dockerfile?: string;
}

/** Resource group compartilhado entre projetos — guarda o ACR de bootstrap. Nunca é destruído por `iacmp destroy` de um projeto individual. */
const ACR_BOOTSTRAP_RESOURCE_GROUP = 'iacmp-bootstrap-rg';

function getSubscriptionId(): string {
  return execFileSync('az', ['account', 'show', '--query', 'id', '--output', 'tsv'], { stdio: 'pipe' }).toString().trim();
}

/** Nome do ACR de bootstrap — 1 por subscription, compartilhado entre projetos (nomes de ACR são globalmente únicos no Azure). */
function acrBootstrapName(subscriptionId: string): string {
  return `iacmpacr${subscriptionId.replace(/-/g, '').slice(0, 12)}`;
}

function acrExists(name: string, resourceGroup: string): boolean {
  try {
    execFileSync('az', ['acr', 'show', '--name', name, '--resource-group', resourceGroup, '--query', 'name', '--output', 'tsv'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * `az acr check-name`: o namespace de nomes de ACR é GLOBAL (azurecr.io) — um
 * nome pode estar em uso por outra subscription/tenant inteiramente fora da
 * nossa visão. `acrExists` (show no nosso resource group) não detecta isso;
 * só o check-name diz se dá pra CRIAR com esse nome.
 */
function acrNameAvailable(name: string): boolean {
  try {
    const out = execFileSync('az', ['acr', 'check-name', '--name', name, '--query', 'nameAvailable', '--output', 'tsv'], { stdio: 'pipe' }).toString().trim();
    return out === 'true';
  } catch {
    // check-name falhou (az indisponível, etc.) — trata como indisponível: mais
    // seguro tentar um nome alternativo do que insistir num create que pode falhar.
    return false;
  }
}

function randomAcrSuffix(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.randomBytes(3).toString('hex'); // 6 chars alfanuméricos
}

interface BootstrapAcr {
  name: string;
  loginServer: string;
  username: string;
  password: string;
}

/** Estado persistido do bootstrap Azure — sobrevive entre execuções do `iacmp deploy` (inclusive processos concorrentes). */
interface AzureBootstrapState {
  acrName?: string;
}

function bootstrapStatePath(): string {
  // `$HOME` é a fonte documentada do os.homedir() no POSIX — checar direto aqui
  // primeiro (em vez de só os.homedir()) mantém o comportamento idêntico em uso
  // real e permite override determinístico em teste (alguns runners não repassam
  // mutações de process.env.HOME até a chamada nativa de os.homedir()).
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.iacmp', 'azure-bootstrap.json');
}

function readBootstrapState(): AzureBootstrapState {
  try {
    return JSON.parse(fs.readFileSync(bootstrapStatePath(), 'utf-8')) as AzureBootstrapState;
  } catch {
    return {};
  }
}

function writeBootstrapState(state: AzureBootstrapState): void {
  const file = bootstrapStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function fetchAcrCredentials(acrName: string): BootstrapAcr {
  const loginServer = execFileSync('az', [
    'acr', 'show', '--name', acrName, '--resource-group', ACR_BOOTSTRAP_RESOURCE_GROUP,
    '--query', 'loginServer', '--output', 'tsv',
  ], { stdio: 'pipe' }).toString().trim();
  const credsRaw = execFileSync('az', [
    'acr', 'credential', 'show', '--name', acrName, '--resource-group', ACR_BOOTSTRAP_RESOURCE_GROUP,
    '--query', '{username:username,password:passwords[0].value}', '--output', 'json',
  ], { stdio: 'pipe' }).toString();
  const creds = JSON.parse(credsRaw) as { username: string; password: string };
  return { name: acrName, loginServer, username: creds.username, password: creds.password };
}

/**
 * Garante o ACR de bootstrap (Basic, admin habilitado) num resource group próprio,
 * compartilhado entre projetos — sobrevive ao `iacmp destroy` de qualquer projeto
 * individual.
 *
 * O nome de ACR é GLOBALMENTE único (namespace azurecr.io) — o nome determinístico
 * `iacmpacr<subId[:12]>` pode estar reservado fora da nossa visão (outra subscription,
 * um registro já purgado, etc.), caso em que `az acr create` falha pra sempre com
 * `RegistryNameAlreadyInUse` mesmo o nosso resource group nunca tendo tido esse ACR.
 * Por isso: (1) show-before-create (reusa se já é nosso), (2) nome persistido em
 * `~/.iacmp/azure-bootstrap.json` tem prioridade sobre o determinístico, (3) se o
 * determinístico não estiver disponível, cai pra um nome com sufixo aleatório e
 * PERSISTE a escolha pra próximas execuções, (4) corrida entre processos (dois
 * deploys concorrentes chamando o bootstrap ao mesmo tempo): se o create falhar com
 * RegistryNameAlreadyInUse, refaz o show no nosso RG antes de desistir — se o outro
 * processo venceu a corrida, reusa o resultado dele em vez de falhar.
 */
function ensureBootstrapAcr(location: string): BootstrapAcr {
  const subscriptionId = getSubscriptionId();
  if (!resourceGroupExists(ACR_BOOTSTRAP_RESOURCE_GROUP)) {
    process.stdout.write(`[iacmp] Criando resource group de bootstrap "${ACR_BOOTSTRAP_RESOURCE_GROUP}" (compartilhado entre projetos)...\n`);
    execFileSync('az', ['group', 'create', '--name', ACR_BOOTSTRAP_RESOURCE_GROUP, '--location', location], { stdio: 'pipe' });
  }

  const state = readBootstrapState();
  const deterministicName = acrBootstrapName(subscriptionId);
  const candidates: Array<{ name: string; reason: 'persistido' | 'determinístico' | 'fallback' }> = state.acrName
    ? [{ name: state.acrName, reason: 'persistido' }]
    : [{ name: deterministicName, reason: 'determinístico' }];

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { name: acrName, reason } = candidates[candidates.length - 1];

    // 1. Show-before-create: já é nosso? Reusa sem tentar criar de novo.
    if (acrExists(acrName, ACR_BOOTSTRAP_RESOURCE_GROUP)) {
      process.stdout.write(`[iacmp] ACR de bootstrap "${acrName}" já existe (nome ${reason}) — reaproveitando.\n`);
      execFileSync('az', ['acr', 'update', '--name', acrName, '--resource-group', ACR_BOOTSTRAP_RESOURCE_GROUP, '--admin-enabled', 'true'], { stdio: 'pipe' });
      if (state.acrName !== acrName) writeBootstrapState({ acrName });
      return fetchAcrCredentials(acrName);
    }

    // 2. Não é nosso ainda — o nome está livre pra CRIAR (namespace global)?
    if (!acrNameAvailable(acrName)) {
      process.stdout.write(`[iacmp] Nome de ACR "${acrName}" (${reason}) está em uso fora do nosso resource group (namespace global azurecr.io) — gerando nome alternativo...\n`);
      candidates.push({ name: `${deterministicName}${randomAcrSuffix()}`.slice(0, 50), reason: 'fallback' });
      continue;
    }

    process.stdout.write(`[iacmp] Criando Azure Container Registry de bootstrap "${acrName}" (nome ${reason})...\n`);
    try {
      execFileSync('az', [
        'acr', 'create',
        '--name', acrName,
        '--resource-group', ACR_BOOTSTRAP_RESOURCE_GROUP,
        '--sku', 'Basic',
        '--admin-enabled', 'true',
        '--location', location,
      ], { stdio: 'pipe' });
      writeBootstrapState({ acrName });
      return fetchAcrCredentials(acrName);
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? (err as Error).message;
      if (!/RegistryNameAlreadyInUse/i.test(stderr)) {
        throw new Error(`Falha ao criar o ACR de bootstrap "${acrName}": ${stderr}`);
      }
      // 3. Corrida entre processos: outro deploy concorrente pode ter criado
      // esse MESMO nome entre o check-name e o create — se foi no NOSSO
      // resource group, a corrida terminou em sucesso; reusa.
      if (acrExists(acrName, ACR_BOOTSTRAP_RESOURCE_GROUP)) {
        process.stdout.write(`[iacmp] ACR "${acrName}" foi criado por um deploy concorrente entre o check e o create — reaproveitando.\n`);
        execFileSync('az', ['acr', 'update', '--name', acrName, '--resource-group', ACR_BOOTSTRAP_RESOURCE_GROUP, '--admin-enabled', 'true'], { stdio: 'pipe' });
        writeBootstrapState({ acrName });
        return fetchAcrCredentials(acrName);
      }
      // Não é nosso — o nome é de terceiros mesmo (reservado fora da nossa visão). Fallback.
      process.stdout.write(`[iacmp] "${acrName}" já está em uso (RegistryNameAlreadyInUse) e não é nosso — gerando nome alternativo...\n`);
      candidates.push({ name: `${deterministicName}${randomAcrSuffix()}`.slice(0, 50), reason: 'fallback' });
    }
  }
  throw new Error(
    `Não foi possível encontrar um nome disponível para o ACR de bootstrap após ${MAX_ATTEMPTS} tentativas ` +
    `(subscription ${subscriptionId}). Verifique "az acr check-name" manualmente ou limpe ~/.iacmp/azure-bootstrap.json.`,
  );
}

/**
 * Distingue "Docker não instalado" de "daemon parado" — nunca cai silenciosamente
 * no fallback ACR Tasks quando o usuário só esqueceu de abrir o Docker Desktop
 * (ACR Tasks é sabidamente bloqueado com TasksOperationsNotAllowed em subscriptions
 * free-trial — cair nele "por acidente" só troca um erro claro por um confuso).
 */
function checkDockerAvailability(): 'available' | 'daemon-down' | 'not-installed' {
  try {
    execFileSync('docker', ['version', '--format', '{{.Client.Version}}'], { stdio: 'pipe' });
    return 'available';
  } catch {
    const cliCheck = spawnSync('docker', ['--version'], { encoding: 'utf-8' });
    return cliCheck.status === 0 ? 'daemon-down' : 'not-installed';
  }
}

/**
 * Builda e publica a imagem de um Compute.Container com `build` no ACR de bootstrap.
 * Precedência (decisão registrada — ver docs/plano-p4-migracao-grafo-gcp-azure.md):
 *   1. Docker local disponível → `docker build --platform linux/amd64` + `docker push` (rota validada em produção, commit 607292a).
 *   2. Docker ausente → `az acr build` (ACR Tasks), best-effort — conhecido por falhar com
 *      `TasksOperationsNotAllowed` em subscriptions free-trial; erro explícito nesse caso.
 *   3. Docker instalado mas daemon parado → erro direto pedindo pra iniciar o Docker Desktop
 *      (NUNCA cai silenciosamente no ACR Tasks, que pode estar bloqueado).
 */
function buildAndPushContainerImage(build: AzureContainerBuildMeta, cwd: string, acr: BootstrapAcr): string {
  const contextPath = path.resolve(cwd, build.context);
  if (!fs.existsSync(contextPath)) {
    throw new Error(
      `Compute.Container "${build.constructId}": contexto de build "${build.context}" não encontrado ` +
      `(resolvido para "${contextPath}").`,
    );
  }
  const fullImage = `${acr.loginServer}/${build.repository}:${build.tag}`;
  const dockerState = checkDockerAvailability();

  if (dockerState === 'available') {
    process.stdout.write(`[iacmp] Compute.Container "${build.constructId}": build via Docker local -> ${fullImage}\n`);
    const buildArgs = ['build', '--platform', 'linux/amd64', '-t', fullImage];
    if (build.dockerfile) buildArgs.push('-f', path.resolve(cwd, build.dockerfile));
    buildArgs.push(contextPath);
    execFileSync('docker', buildArgs, { stdio: 'inherit' });
    execFileSync('az', ['acr', 'login', '--name', acr.name], { stdio: 'pipe' });
    execFileSync('docker', ['push', fullImage], { stdio: 'inherit' });
    return fullImage;
  }

  if (dockerState === 'daemon-down') {
    throw new Error(
      `Compute.Container "${build.constructId}": Docker está instalado mas o daemon não está rodando.\n` +
      `Inicie o Docker Desktop e tente novamente.\n` +
      `(Alternativa best-effort: ACR Tasks — mas é conhecida por falhar com "TasksOperationsNotAllowed" ` +
      `em subscriptions free-trial; Docker local é a rota suportada.)`,
    );
  }

  process.stdout.write(`[iacmp] Compute.Container "${build.constructId}": Docker não encontrado — tentando ACR Tasks (best-effort) -> ${fullImage}\n`);
  const acrBuildArgs = ['acr', 'build', '--registry', acr.name, '--image', `${build.repository}:${build.tag}`, '--platform', 'linux/amd64'];
  if (build.dockerfile) acrBuildArgs.push('--file', build.dockerfile);
  acrBuildArgs.push(contextPath);
  try {
    execFileSync('az', acrBuildArgs, { stdio: ['ignore', 'inherit', 'pipe'] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    if (stderr) process.stderr.write(stderr);
    if (/TasksOperationsNotAllowed/i.test(stderr)) {
      throw new Error(
        `Compute.Container "${build.constructId}": ACR Tasks ("az acr build") não está disponível nesta ` +
        `subscription (bloqueio conhecido em contas free-trial: TasksOperationsNotAllowed). Instale e inicie ` +
        `o Docker Desktop e rode o deploy novamente — é a rota de build suportada nesta subscription.`,
      );
    }
    throw new Error(`Compute.Container "${build.constructId}": az acr build falhou. ${stderr || (err as Error).message}`);
  }
  return fullImage;
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

  // fn.code (ex: 'src/handlers/itens') aponta direto para a pasta do handler
  const codeStem = fn.code ? fn.code.replace(/^(\.\/)?(dist|src)\//, '') : null;

  const srcEntry = [
    // preferência: usar fn.code como diretório base
    ...(codeStem ? [
      path.join(cwd, 'src', codeStem, 'index.ts'),
      path.join(cwd, 'src', codeStem, 'index.js'),
      path.join(cwd, codeStem, 'index.ts'),
      path.join(cwd, codeStem, 'index.js'),
    ] : []),
    // fallback: derivar o caminho pelo handler
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

  // @iacmp/runtime é dependência real do cli (não inlinada — ver tsup.config.ts),
  // então `require.resolve` a acha via node_modules tanto no monorepo (symlink do
  // workspace) quanto no pacote publicado. Handler que importa `@iacmp/runtime`
  // é bundlado direto com o adaptador Azure — sem passar pelo seletor de
  // IACMP_CLOUD em runtime/src/index.ts (que só existe como fallback).
  let iacmpRuntimeAzurePath: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    iacmpRuntimeAzurePath = require.resolve('@iacmp/runtime/azure');
  } catch {
    // @iacmp/runtime não instalado/linkado — handlers legados (só @aws-sdk/*) seguem via shim acima
  }

  const azureSdkNodePaths: string[] = [];
  for (const pkg of ['@azure/data-tables', '@azure/storage-blob', 'mongodb']) {
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
      ...(iacmpRuntimeAzurePath ? { '@iacmp/runtime': iacmpRuntimeAzurePath } : {}),
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
    // Parâmetros produzidos pelo pipeline de build de imagem (acrServer/acrUser/acrPassword
    // + <imageParamName>=<imagem final> por Compute.Container com `build`) — injetados
    // ANTES do cálculo de `paramValues` abaixo para que entrem no `provided` set e não
    // sejam pisados pela lógica de soft/hard cross-stack params.
    const containerBuildParamValues: string[] = [];

    if (!ctx.dryRun && fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
        functions: AzureFunctionMeta[];
        containerBuilds?: AzureContainerBuildMeta[];
      };
      const functions: AzureFunctionMeta[] = meta.functions ?? [];
      const containerBuilds: AzureContainerBuildMeta[] = meta.containerBuilds ?? [];

      if (containerBuilds.length > 0) {
        const acr = ensureBootstrapAcr(ctx.region);
        containerBuildParamValues.push(`acrServer=${acr.loginServer}`, `acrUser=${acr.username}`, `acrPassword=${acr.password}`);
        for (const build of containerBuilds) {
          const fullImage = buildAndPushContainerImage(build, ctx.cwd, acr);
          containerBuildParamValues.push(`${build.imageParamName}=${fullImage}`);
        }
      }

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
        lazyCmd.retries = 2;
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

    const paramValues: string[] = [...containerBuildParamValues];
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

    // Ativação de static website — data-plane, não configurável via ARM/Bicep.
    // Para cada output *StaticWebsiteAccount emitido pelo synth, roda pós-deploy:
    //   az storage blob service-properties update --static-website ...
    // O preRun lê os outputs da stack recém-deployada para obter o nome da conta.
    if (!ctx.dryRun) {
      const staticWebKeys = getStaticWebsiteOutputKeys(ctx.templatePath);
      for (const accKey of staticWebKeys) {
        const idxKey = accKey.replace(/StaticWebsiteAccount$/, 'StaticWebsiteIndex');
        const errKey = accKey.replace(/StaticWebsiteAccount$/, 'StaticWebsite404');
        const lazyCmd: NativeCommand = { bin: 'az', args: ['version', '--output', 'none'] };
        lazyCmd.preRun = () => {
          const outputs = getAzureStackOutputs(ctx.stackName, resourceGroup);
          const byLow = new Map(Object.entries(outputs).map(([k, v]) => [k.toLowerCase(), v]));
          const accountName = byLow.get(accKey.toLowerCase());
          if (!accountName) {
            process.stdout.write(`[iacmp] Output "${accKey}" não encontrado — static website não ativado.\n`);
            return;
          }
          const indexDoc = byLow.get(idxKey.toLowerCase()) ?? 'index.html';
          const errorDoc = byLow.get(errKey.toLowerCase()) ?? '404.html';
          process.stdout.write(`[iacmp] Ativando static website em "${accountName}" (index: ${indexDoc}, 404: ${errorDoc})...\n`);
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { execFileSync } = require('child_process') as typeof import('child_process');
          execFileSync('az', [
            'storage', 'blob', 'service-properties', 'update',
            '--account-name', accountName,
            '--static-website',
            '--index-document', indexDoc,
            '--404-document', errorDoc,
            '--auth-mode', 'login',
          ], { stdio: 'inherit' });
          process.stdout.write(`[iacmp] Static website ativado em "${accountName}".\n`);
          // O comando principal (az version) passa a ser no-op — todo o trabalho
          // foi feito no preRun via execFileSync.
        };
        commands.push(lazyCmd);
      }
    }

    return commands;
  },

  async planDestroy(ctx: DestroyContext): Promise<NativeCommand[]> {
    const resourceGroup = requireResourceGroup(ctx);
    const commands: NativeCommand[] = [{
      bin: 'az',
      args: [
        'stack', 'group', 'delete',
        '--name', ctx.stackName,
        '--resource-group', resourceGroup,
        '--action-on-unmanage', 'deleteAll',
        '--yes',
      ],
    }];

    // Limpa só o repositório de imagem do projeto no ACR de bootstrap — o ACR em
    // si é compartilhado entre projetos (resource group próprio) e nunca é
    // destruído por aqui. Tolerante à ausência (repo/ACR já não existir).
    if (ctx.templatePath) {
      const metaPath = ctx.templatePath.replace(/\.bicep$/, '.iacmp-meta.json');
      const containerBuilds: AzureContainerBuildMeta[] = fs.existsSync(metaPath)
        ? ((JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { containerBuilds?: AzureContainerBuildMeta[] }).containerBuilds ?? [])
        : [];
      for (const build of containerBuilds) {
        // Placeholder no-op — o trabalho real acontece no preRun (lazy), pra não
        // rodar `az account show` durante --dry-run (planDestroy não tem ctx.dryRun).
        const lazyCmd: NativeCommand = { bin: 'az', args: ['version', '--output', 'none'] };
        lazyCmd.preRun = () => {
          // O nome real do ACR pode ter sido um fallback persistido (ver ensureBootstrapAcr) —
          // nunca assume o determinístico sem checar o estado primeiro.
          const acrName = readBootstrapState().acrName ?? acrBootstrapName(getSubscriptionId());
          process.stdout.write(`[iacmp] Removendo repositório ACR "${build.repository}" (imagem de "${build.constructId}")...\n`);
          try {
            execFileSync('az', [
              'acr', 'repository', 'delete',
              '--name', acrName,
              '--repository', build.repository,
              '--yes',
            ], { stdio: 'pipe' });
            process.stdout.write(`[iacmp] Repositório "${build.repository}" removido.\n`);
          } catch {
            process.stdout.write(`[iacmp] Repositório "${build.repository}" não encontrado no ACR (ok, nada a limpar).\n`);
          }
        };
        commands.push(lazyCmd);
      }
    }

    return commands;
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
