import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DeployContext, NativeCommand } from '../types';
import { toTfId } from '@iacmp/provider-gcp';
import type { GCPFunctionMeta } from '@iacmp/provider-gcp';
import { renderGcpFunctionWrapper, renderGcpEventWrapper } from './wrappers';

/** Bucket de artefatos onde o Terraform (build_config.source.storage_source) espera achar o zip de cada Fn.Lambda. */
function artifactsBucketName(projectId: string): string {
  return `${projectId}-artifacts`;
}

/** Garante que o bucket de artefatos exista — cria com o mesmo nome que o synth já referencia em `${var.project_id}-artifacts` (ver constructs/function.ts). Idempotente: `describe` primeiro, `create` só se ausente. */
function ensureArtifactsBucket(projectId: string, region: string): string {
  const bucket = artifactsBucketName(projectId);
  try {
    execFileSync('gcloud', ['storage', 'buckets', 'describe', `gs://${bucket}`], { stdio: 'pipe' });
  } catch {
    execFileSync('gcloud', ['storage', 'buckets', 'create', `gs://${bucket}`, '--location', region, '--project', projectId], { stdio: 'pipe' });
  }
  return bucket;
}

/**
 * Empacota o handler de uma Function.Lambda para Cloud Functions gen2
 * (`google_cloudfunctions2_function`, ver packages/providers/gcp/src/synth/constructs/function.ts).
 *
 * Cria em <buildDir>:
 *   handler.js    — esbuild bundle self-contained do código do usuário (o
 *                    arquivo original já exporta a função nomeada em
 *                    `fn.entryPoint` — ver gcpEntryPoint; o bundle preserva
 *                    esse export)
 *   index.js      — adapter do functions-framework — é o módulo de entrada
 *                    REAL (GCF chama o export/registro de `entryPoint` deste
 *                    arquivo, não de handler.js diretamente). `fn.trigger`
 *                    (ver GCPFunctionMeta) escolhe QUAL adapter: 'http' usa
 *                    renderGcpFunctionWrapper (adapter `(req,res)` ↔ evento
 *                    Lambda); 'event' usa renderGcpEventWrapper
 *                    (`functions.cloudEvent`, repassa o CloudEvent direto —
 *                    Pub/Sub trigger não é HTTP, ver renderGcpEventWrapper).
 *   package.json  — `main: 'index.js'`, obrigatório pro buildpack Node do
 *                    Cloud Functions gen2 localizar o arquivo de entrada.
 *                    Funções 'event' também declaram `@google-cloud/
 *                    functions-framework` em dependencies — index.js requer
 *                    o pacote pra chamar `functions.cloudEvent` (o buildpack
 *                    instala durante o build remoto).
 *
 * Retorna o path do zip gerado, ou null se não encontrou o fonte do handler.
 */
function buildFunctionBundle(cwd: string, fn: GCPFunctionMeta, outDir: string): string | null {
  const modulePath = fn.handler.replace(/\.[^./]+$/, '');
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

  const buildDir = path.join(outDir, '.packaged', fn.constructId);
  fs.mkdirSync(buildDir, { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let esbuild: { buildSync: (opts: Record<string, unknown>) => unknown };
  try {
    esbuild = require('esbuild') as typeof esbuild;
  } catch {
    throw new Error('esbuild não encontrado. Rode `npm install` no iacmp.');
  }

  // @iacmp/runtime é dependência real do cli (ver package.json), então
  // `require.resolve` a acha via node_modules tanto no monorepo (symlink do
  // workspace) quanto no pacote publicado. Handler que importa `@iacmp/runtime`
  // é bundlado direto com o adaptador GCP — sem passar pelo seletor de
  // IACMP_CLOUD em runtime/src/index.ts (que só existe como fallback, ver
  // env var injetada em service_config.environment_variables no synth).
  let iacmpRuntimeGcpPath: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    iacmpRuntimeGcpPath = require.resolve('@iacmp/runtime/gcp');
  } catch {
    // @iacmp/runtime não instalado/linkado — handlers legados seguem sem o alias
  }

  const gcpSdkNodePaths: string[] = [];
  for (const pkg of ['@google-cloud/firestore', '@google-cloud/secret-manager', '@google-cloud/storage']) {
    try {
      // `${pkg}/package.json` (a técnica usada pelo deploy Azure p/ @azure/*) não
      // funciona aqui: o `exports` map de @google-cloud/storage NÃO
      // allowlista `./package.json` (ERR_PACKAGE_PATH_NOT_EXPORTED) —
      // resolve o entrypoint real do pacote e sobe até o `node_modules`
      // ancestral mais próximo, que funciona com ou sem `exports` restrito.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const entryPath = require.resolve(pkg) as string;
      let dir = path.dirname(entryPath);
      while (path.basename(dir) !== 'node_modules' && dir !== path.dirname(dir)) {
        dir = path.dirname(dir);
      }
      if (path.basename(dir) === 'node_modules' && !gcpSdkNodePaths.includes(dir)) {
        gcpSdkNodePaths.push(dir);
      }
    } catch {
      // pacote não encontrado — esbuild vai falhar se o handler o referenciar
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
      ...(iacmpRuntimeGcpPath ? { '@iacmp/runtime': iacmpRuntimeGcpPath } : {}),
    },
    nodePaths: gcpSdkNodePaths,
    banner: { js: `const __iacmp_meta_url = require('url').pathToFileURL(__filename).href;` },
    define: { 'import.meta.url': '__iacmp_meta_url' },
    logLevel: 'silent',
  });

  const isEventTriggered = fn.trigger === 'event';
  fs.writeFileSync(
    path.join(buildDir, 'index.js'),
    isEventTriggered ? renderGcpEventWrapper(fn.entryPoint) : renderGcpFunctionWrapper(fn.entryPoint),
  );

  fs.writeFileSync(path.join(buildDir, 'package.json'), JSON.stringify({
    name: fn.constructId.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'handler',
    version: '1.0.0',
    main: 'index.js',
    engines: { node: '20' },
    // functions.cloudEvent() (renderGcpEventWrapper) chama require('@google-cloud/functions-framework')
    // — precisa estar em dependencies pro buildpack do Cloud Functions instalá-lo no build remoto.
    ...(isEventTriggered ? { dependencies: { '@google-cloud/functions-framework': '^3.0.0' } } : {}),
  }, null, 2));

  // Versiona o object do zip pelo HASH do conteúdo do bundle (não dos bytes
  // do .zip em si — o utilitário `zip` grava mtime por arquivo, então o MESMO
  // conteúdo produziria .zip bytes diferentes a cada build e o hash mudaria à
  // toa). `fn.zipObject` chega aqui com o placeholder emitido pelo synth
  // (`gcpFunctionZipObject`, ex: `myfn.zip`) — sem o hash, o Terraform vê
  // sempre o MESMO `storage_source.object` (string fixa) e nunca detecta que
  // o handler mudou, então a Cloud Function nunca é atualizada (bug provado
  // em deploy real: só um destroy+recreate pegava o novo código). Mutar
  // `fn.zipObject` aqui propaga o nome versionado tanto para o upload
  // (buildAndUploadFunctions usa esta mesma referência) quanto para o patch
  // do tf.json (patchFunctionZipObjects).
  fn.zipObject = versionedZipObject(fn.zipObject, hashFunctionBundle(buildDir));

  const zipPath = path.join(outDir, '.packaged', fn.zipObject);
  try { fs.unlinkSync(zipPath); } catch { /* não existe ainda */ }
  execFileSync('zip', ['-r', zipPath, '.'], { cwd: buildDir, stdio: 'pipe' });

  return zipPath;
}

/**
 * Hash determinístico do bundle de uma Fn.Lambda — sha256 do CONTEÚDO de
 * handler.js + index.js + package.json (sempre nesta ordem), truncado a 10
 * hex chars. Mesmo código-fonte (mesmo handler, mesmo entryPoint, mesmo
 * trigger) produz sempre os mesmos 3 arquivos byte-a-byte (esbuild é
 * determinístico para a mesma entrada/config) e portanto o MESMO hash —
 * requisito de idempotência: sem mudança de handler, o object no bucket e no
 * tf.json não muda, e o `terraform apply` não vê diff.
 */
export function hashFunctionBundle(buildDir: string): string {
  const hash = crypto.createHash('sha256');
  for (const name of ['handler.js', 'index.js', 'package.json']) {
    hash.update(fs.readFileSync(path.join(buildDir, name)));
  }
  return hash.digest('hex').slice(0, 10);
}

/** `<id>.zip` → `<id>-<hash>.zip` — mantém o id legível, versiona pelo conteúdo. */
export function versionedZipObject(zipObject: string, hash: string): string {
  return zipObject.replace(/\.zip$/, `-${hash}.zip`);
}

/**
 * Lê TODOS os sidecars `*.iacmp-meta.json` do diretório de synth GCP (um por
 * stack, ver synth.ts) — não só o da stack corrente: o Terraform combina
 * todo `*.tf.json` do diretório num state único e `apply` é chamado sem
 * `-target`, então a PRIMEIRA chamada de planDeploy do projeto já cria as
 * Cloud Functions de TODAS as stacks — o zip de cada uma precisa estar no
 * bucket de artefatos antes dessa primeira apply, não só o da stack sendo
 * iterada no momento.
 */
function collectAllFunctionMeta(dir: string): GCPFunctionMeta[] {
  if (!fs.existsSync(dir)) return [];
  const out: GCPFunctionMeta[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.iacmp-meta.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as { functions?: GCPFunctionMeta[] };
      out.push(...(meta.functions ?? []));
    } catch {
      /* meta ilegível/corrompido — ignora essa stack, synth de novo resolve */
    }
  }
  return out;
}

/** Builda+empacota+sobe (gcloud storage cp) o zip de cada Fn.Lambda do projeto — chamado ANTES do terraform apply para o storage_source existir quando a Cloud Function for criada. */
export function buildAndUploadFunctions(ctx: DeployContext, projectId: string, region: string, dir: string): NativeCommand[] {
  const functions = collectAllFunctionMeta(dir);
  if (functions.length === 0) return [];

  const bucket = ensureArtifactsBucket(projectId, region);
  const cmds: NativeCommand[] = [];
  const built: GCPFunctionMeta[] = [];
  for (const fn of functions) {
    process.stdout.write(`[iacmp] Empacotando ${fn.constructId} para Cloud Functions...\n`);
    const zipPath = buildFunctionBundle(ctx.cwd, fn, dir);
    if (!zipPath) {
      process.stdout.write(`[iacmp] Handler não encontrado para ${fn.constructId} — zip ignorado (a Cloud Function falhará no apply sem o storage_source).\n`);
      continue;
    }
    built.push(fn); // fn.zipObject já foi versionado por hash dentro de buildFunctionBundle
    cmds.push({ bin: 'gcloud', args: ['storage', 'cp', zipPath, `gs://${bucket}/${fn.zipObject}`, '--project', projectId] });
  }
  // Reescreve o `storage_source.object` de cada `google_cloudfunctions2_function`
  // no(s) `<stack>.tf.json` do projeto para o nome versionado ANTES do apply —
  // o synth só conhece o placeholder `<id>.zip` (não builda handlers).
  patchFunctionZipObjects(dir, built);
  return cmds;
}

/**
 * O synth (packages/providers/gcp/src/synth/constructs/function.ts) emite
 * `storage_source.object` com o placeholder `gcpFunctionZipObject(id)`
 * (`<id>.zip`) — ele não builda handlers, então não conhece o hash do
 * conteúdo (calculado só aqui no deploy, ver hashFunctionBundle). Reescreve
 * esse `object`, em TODOS os `*.tf.json` do diretório de synth GCP, para o
 * nome versionado (`<id>-<hash>.zip`) que de fato foi enviado ao bucket —
 * localiza o resource pelo tfId (`toTfId(constructId)`, MESMA sanitização
 * que o synth usa como chave do resource). Sem este patch o Terraform sempre
 * veria o placeholder fixo do synth (nunca muda entre synths) e nunca
 * detectaria que o código do handler mudou.
 */
export function patchFunctionZipObjects(dir: string, functions: GCPFunctionMeta[]): void {
  if (functions.length === 0) return;
  const zipObjectByTfId = new Map(functions.map((fn) => [toTfId(fn.constructId), fn.zipObject]));

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.tf.json')) continue;
    const filePath = path.join(dir, file);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let template: { resource?: { google_cloudfunctions2_function?: Record<string, any> } };
    try {
      template = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      continue; // tf.json ilegível/corrompido — synth de novo resolve
    }
    const resources = template.resource?.google_cloudfunctions2_function;
    if (!resources) continue;

    let changed = false;
    for (const [tfId, resource] of Object.entries(resources)) {
      const zipObject = zipObjectByTfId.get(tfId);
      if (!zipObject) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const storageSource = (resource as any)?.build_config?.[0]?.source?.[0]?.storage_source?.[0];
      if (storageSource && storageSource.object !== zipObject) {
        storageSource.object = zipObject;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(filePath, JSON.stringify(template, null, 2) + '\n');
    }
  }
}
