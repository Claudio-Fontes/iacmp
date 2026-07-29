import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../../i18n';
import { renderHttpTriggerWrapper } from './http-trigger-wrapper';

export interface AzureFunctionMeta {
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
export function buildFunctionBundle(
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
    throw new Error(t('esbuild não encontrado. Rode `npm install` no iacmp.', 'esbuild not found. Run `npm install` in iacmp.'));
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

  fs.writeFileSync(path.join(buildDir, 'HttpTrigger', 'index.js'), renderHttpTriggerWrapper(fn.routePatterns ?? []));

  const zipPath = path.join(path.dirname(templatePath), '.packaged', `${fn.functionAppName}.zip`);
  try { fs.unlinkSync(zipPath); } catch { /* não existe ainda */ }
  execFileSync('zip', ['-r', zipPath, '.'], { cwd: buildDir, stdio: 'pipe' });

  return zipPath;
}
