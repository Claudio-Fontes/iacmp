import { Stack, BaseConstruct, isRef, prepareStacksForSynth } from '@iacmp/core';
import type { Ref } from '@iacmp/core';

import {
  expr,
  toSym, safeStorageName, bv, tag,
  crossParamName, resolveValue,
  BicepResource, BicepOutput, SynthContext,
} from './constructs/shared';
import { validateAzureResources } from './validation';

import { synthesizeCompute } from './constructs/compute';
import { synthesizeStorage } from './constructs/storage';
import { synthesizeNetwork } from './constructs/network';
import { synthesizeDatabase } from './constructs/database';
import { synthesizeCache } from './constructs/cache';
import { synthesizeFunction } from './constructs/function';
import { synthesizePolicy } from './constructs/policy';
import { synthesizeMessaging } from './constructs/messaging';
import { synthesizeMonitoring } from './constructs/monitoring';

// Re-export para não quebrar imports externos que possam ler utilitários do módulo bicep.
export { toSym, safeStorageName, crossParamName, resolveValue, tag, expr, bv };
export type { BicepResource, BicepOutput, SynthContext };

// ── Renderer ─────────────────────────────────────────────────────────────────
function renderBicep(
  params: Array<{ name: string; type: string; default?: unknown; secure?: boolean }>,
  resources: BicepResource[],
  outputs: BicepOutput[],
): string {
  const lines: string[] = [];

  for (const p of params) {
    if (p.secure) lines.push('@secure()');
    const def = p.default !== undefined ? ` = ${bv(p.default)}` : '';
    lines.push(`param ${p.name} ${p.type}${def}`);
  }
  if (params.length > 0) lines.push('');

  for (const r of resources) {
    // `module` (ex: filhos do APIM compartilhado cross-RG — ver Function.ApiGateway):
    // sintaxe própria, sem `type@apiVersion` nem `existing` — aponta pra um arquivo
    // .bicep-irmão, opcionalmente `scope`d pra outro resource group, com `params:`
    // (reaproveita bv() em cima de r.properties, igual a `properties` de um resource comum).
    if (r.moduleFile) {
      const fields: Array<[string, unknown]> = [];
      if (r.scope) fields.push(['scope', expr(r.scope)]);
      if (r.name !== undefined) fields.push(['name', r.name]);
      if (r.dependsOn && r.dependsOn.length > 0) {
        fields.push(['dependsOn', expr(`[\n    ${r.dependsOn.join('\n    ')}\n  ]`)]);
      }
      fields.push(['params', r.properties]);
      lines.push(`module ${r.sym} '${r.moduleFile}' = {`);
      for (const [k, v] of fields) {
        lines.push(`  ${k}: ${bv(v, 1)}`);
      }
      lines.push('}');
      lines.push('');
      continue;
    }

    const fields: Array<[string, unknown]> = [];
    if (r.scope) fields.push(['scope', expr(r.scope)]);
    if (r.parent) fields.push(['parent', expr(r.parent)]);
    if (r.name !== undefined) fields.push(['name', r.name]);
    // Recursos `existing` (ex: APIM compartilhado) só aceitam name/scope/parent
    // no Bicep — location/kind/sku/tags/identity/dependsOn/properties são do
    // recurso real, não configuráveis aqui. Emiti-los causaria erro do compilador
    // Bicep ("Existing resources cannot be configured...").
    if (!r.existing) {
      if (r.location) fields.push(['location', expr(r.location)]);
      if (r.kind) fields.push(['kind', r.kind]);
      if (r.sku) fields.push(['sku', r.sku]);
      if (r.tags) fields.push(['tags', r.tags]);
      if (r.identity) fields.push(['identity', r.identity]);
      if (r.dependsOn && r.dependsOn.length > 0) {
        fields.push(['dependsOn', expr(`[\n    ${r.dependsOn.join('\n    ')}\n  ]`)]);
      }
      fields.push(['properties', r.properties]);
    }

    lines.push(`resource ${r.sym} '${r.type}@${r.apiVersion}'${r.existing ? ' existing' : ''} = ${r.condition ? `if (${r.condition}) ` : ''}{`);
    for (const [k, v] of fields) {
      lines.push(`  ${k}: ${bv(v, 1)}`);
    }
    lines.push('}');
    lines.push('');
  }

  for (const o of outputs) {
    // ConnectionString/keys como output é intencional: é a amarração cross-stack
    // (module.outputs.X no _main.bicep). O linter avisa porque outputs ficam no
    // histórico de deployment — aceito para os projetos gerados; silenciar aqui
    // evita o warning em todo build.
    if (/listKeys|listConnectionStrings|primaryKey|primaryMasterKey/.test(o.value)) {
      lines.push('#disable-next-line outputs-should-not-contain-secrets');
    }
    lines.push(`output ${o.name} ${o.type} = ${o.value}`);
  }

  return lines.join('\n');
}

// ── Per-construct dispatcher ──────────────────────────────────────────────────
function synthesizeConstruct(construct: BaseConstruct, ctx: SynthContext): void {
  const type = construct.type;

  if (type.startsWith('Compute.')) {
    synthesizeCompute(construct, ctx);
  } else if (type.startsWith('Storage.')) {
    synthesizeStorage(construct, ctx);
  } else if (type.startsWith('Network.')) {
    synthesizeNetwork(construct, ctx);
  } else if (type.startsWith('Database.')) {
    synthesizeDatabase(construct, ctx);
  } else if (type.startsWith('Cache.')) {
    synthesizeCache(construct, ctx);
  } else if (type === 'Function.Lambda' || type === 'Function.ApiGateway' || type === 'Events.EventBridge' || type === 'Workflow.StepFunctions') {
    synthesizeFunction(construct, ctx);
  } else if (type === 'Policy.IAM' || type === 'Secret.Vault' || type === 'Certificate.TLS') {
    synthesizePolicy(construct, ctx);
  } else if (type.startsWith('Messaging.')) {
    synthesizeMessaging(construct, ctx);
  } else if (type === 'Monitoring.Alarm' || type === 'Monitoring.Dashboard' || type === 'Logging.Stream' || type === 'Custom.Resource') {
    synthesizeMonitoring(construct, ctx);
  } else {
    console.warn(`[iacmp/azure] construct '${type}' nao suportado`);
  }
}

// ── Function metadata for packaging ──────────────────────────────────────────
export interface AzureFunctionMeta {
  constructId: string;
  functionAppName: string;
  handler: string;
  code: string;
  runtime: string;
  /** Path patterns (ex: "/files/{key}", "/files/{key+}") de todos os ApiGateway que apontam pra esse lambda. */
  routePatterns: string[];
}

export function extractAzureFunctionMeta(stack: Stack, allStacks?: Stack[]): AzureFunctionMeta[] {
  const universe = allStacks ?? [stack];
  const routesByLambda = new Map<string, string[]>();
  for (const s of universe) {
    for (const c of s.constructs) {
      if (c.type !== 'Function.ApiGateway') continue;
      const routes = ((c.props as Record<string, unknown>).routes as Array<Record<string, unknown>>) ?? [];
      for (const route of routes) {
        const lambdaId = route.lambdaId as string | undefined;
        const routePath = route.path as string | undefined;
        if (lambdaId && routePath) {
          if (!routesByLambda.has(lambdaId)) routesByLambda.set(lambdaId, []);
          routesByLambda.get(lambdaId)!.push(routePath);
        }
      }
    }
  }

  return stack.constructs
    .filter(c => c.type === 'Function.Lambda')
    .map(c => {
      const props = c.props as Record<string, unknown>;
      return {
        constructId: c.id,
        functionAppName: c.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20),
        handler: (props.handler as string) ?? 'dist/handler.handler',
        code: (props.code as string) ?? 'dist/',
        runtime: (props.runtime as string) ?? 'nodejs20',
        routePatterns: routesByLambda.get(c.id) ?? [],
      };
    });
}

// ── Container build metadata (Compute.Container com `build`) ─────────────────
// O deploy precisa saber QUAIS Compute.Container têm `build` (context+dockerfile)
// para: garantir o ACR de bootstrap, buildar+pushar a imagem (Docker local ou
// ACR Tasks best-effort) e injetar `<imageParamName>=<loginServer>/<repository>:<tag>`
// como valor de parâmetro Bicep — reaproveita o MESMO param `<sym>Image` que já
// existe para `image` literal (ver synthesizeCompute), só troca quem fornece o valor.
export interface AzureContainerBuildMeta {
  constructId: string;
  /** Nome do param Bicep (`<sym>Image`) que recebe a imagem final via --parameters no deploy. */
  imageParamName: string;
  /** Nome do repositório no ACR de bootstrap — prefixado pelo projeto para não colidir entre projetos diferentes que compartilham o mesmo ACR. */
  repository: string;
  tag: string;
  /** Caminho do contexto de build, relativo à raiz do projeto (mesmo valor de `build.context`). */
  context: string;
  dockerfile?: string;
}

export function extractAzureContainerBuilds(stack: Stack, projectName?: string): AzureContainerBuildMeta[] {
  const projectSlug = (projectName ?? 'iacmp').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'iacmp';
  const out: AzureContainerBuildMeta[] = [];
  for (const c of stack.constructs) {
    if (c.type !== 'Compute.Container') continue;
    const props = c.props as Record<string, unknown>;
    const build = props.build as { context: string; dockerfile?: string } | undefined;
    if (!build) continue;
    const idSlug = c.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'container';
    out.push({
      constructId: c.id,
      imageParamName: `${toSym(c.id)}Image`,
      repository: `${projectSlug}-${idSlug}`,
      tag: 'latest',
      context: build.context,
      dockerfile: build.dockerfile,
    });
  }
  return out;
}

// ── Main export ───────────────────────────────────────────────────────────────
export function emitBicep(stack: Stack, opts?: {
  accountTier?: 'free' | 'standard';
  allStacks?: Stack[];
  /** APIM compartilhado (iacmp.json → azure.sharedApim) — ver SynthContext.sharedApim. */
  sharedApim?: { name: string; resourceGroup: string; projectResourceGroup?: string };
  /** Nome do projeto (iacmp.json → name) — usado para prefixar os filhos do APIM compartilhado. */
  projectName?: string;
  /** Recebe (via push) o conteúdo de módulos Bicep aninhados que este synth
   * precisar gerar como arquivos-irmãos (ex: filhos do APIM compartilhado quando
   * sharedApim.resourceGroup difere do RG do projeto — ver Function.ApiGateway).
   * Quem chama (o comando `synth`) grava cada item em disco ao lado do .bicep
   * principal, no mesmo diretório (o `module` referencia por nome relativo).
   * Ausência/array não fornecido = nenhum módulo necessário (regressão zero). */
  moduleFilesOut?: Array<{ filename: string; content: string }>;
}): string {
  const accountTier = opts?.accountTier ?? 'standard';
  // Normalização + validação semântica provider-agnóstica (o MESMO ponto de
  // entrada do AWS) — refs quebradas, porta de SG do banco, CIDR de subnet, etc.
  // passam a ser pegos em synth-time no Azure também, não só no deploy real.
  // Só roda com o UNIVERSO completo (allStacks): validar refs cross-stack exige
  // ver todas as stacks. O synth.ts real sempre passa allStacks; chamadas
  // isoladas (unit test de um fragmento) pulam — não há projeto para validar.
  if (opts?.allStacks && opts.allStacks.length > 0) {
    prepareStacksForSynth(opts.allStacks, { accountTier, cloud: 'azure' });
  }
  const idx = new Map<string, BaseConstruct>(stack.constructs.map(c => [c.id, c]));
  // globalIdx: lookup de tipo em qualquer stack (nunca usado para resolver valor de ref)
  const allConstructs = (opts?.allStacks ?? [stack]).flatMap(s => s.constructs);
  const globalIdx = new Map<string, BaseConstruct>(allConstructs.map(c => [c.id, c]));
  const resources: BicepResource[] = [];
  const outputs: BicepOutput[] = [];
  const needsAdminPassword = { value: false };
  const crossParams = new Map<string, string>();
  const functionImageParams = new Map<string, string>();
  const cdnBucketRefs = new Set<string>();
  const lambdaWithEventGridTrigger = new Set<string>();
  for (const c of stack.constructs) {
    if (c.type !== 'Storage.Bucket') continue;
    const p = c.props as Record<string, unknown>;
    const notifications = (p.eventNotifications as Array<Record<string, unknown>>) ?? [];
    for (const n of notifications) {
      const raw = n.lambdaId;
      const lid = isRef(raw) ? (raw as Ref).constructId : raw as string;
      if (lid && idx.has(lid)) lambdaWithEventGridTrigger.add(lid);
    }
  }

  // VNet integration — subnetIds de Database.SQL (postgres) e Compute.Container.
  // Postgres Flexible Server exige subnet EXCLUSIVA (delegada só a ele — nenhum
  // outro recurso, nem outro Postgres, pode usá-la). Compute.Container (Container
  // Apps Environment dedicado) TAMBÉM exige a subnet delegada — validado em
  // deploy real 2026-07-22 (bateria p07): o ARM rejeita o CAE com
  // "ManagedEnvironmentSubnetDelegationError: The subnet of the environment must
  // be delegated to the service 'Microsoft.App/environments'" mesmo sem
  // workload profiles (a doc pública da Microsoft que orienta NÃO delegar em
  // Consumption-only está desatualizada/incorreta para o Microsoft.App/
  // managedEnvironments@2023-05-01 que emitimos — o erro do ARM é a palavra
  // final; NÃO reverter esta delegation sem novo deploy real confirmando).
  // Detecta em synth-time (não no deploy real, ~15-20min depois) qualquer
  // conflito de subnet compartilhada entre as duas delegations (cada uma só
  // aceita UM serviço). Calculado sobre TODAS as stacks (allConstructs) porque
  // VNet/subnet podem estar numa stack de rede e o banco/container em outra.
  const postgresSubnetOwner = new Map<string, string>(); // subnetId → Database.SQL id dono
  const containerSubnetOwner = new Map<string, string>(); // subnetId → Compute.Container id dono
  for (const c of allConstructs) {
    const p = c.props as Record<string, unknown>;
    const subnetIds = (p.subnetIds as string[] | undefined) ?? [];
    if (subnetIds.length === 0) continue;
    if (c.type === 'Database.SQL' && ((p.engine as string) ?? 'mysql') === 'postgres') {
      for (const sid of subnetIds) {
        const existingOwner = postgresSubnetOwner.get(sid);
        if (existingOwner && existingOwner !== c.id) {
          throw new Error(
            `[azure] Subnet "${sid}" já está delegada exclusivamente ao Database.SQL "${existingOwner}". ` +
            `Postgres Flexible Server exige subnet dedicada (Microsoft.DBforPostgreSQL/flexibleServers) — ` +
            `nenhum outro recurso, nem outro banco, pode compartilhá-la. Use uma subnet diferente para "${c.id}".`,
          );
        }
        postgresSubnetOwner.set(sid, c.id);
      }
    }
    if (c.type === 'Compute.Container') {
      for (const sid of subnetIds) containerSubnetOwner.set(sid, c.id);
    }
  }
  for (const [sid, owner] of postgresSubnetOwner) {
    if (containerSubnetOwner.has(sid)) {
      throw new Error(
        `[azure] Subnet "${sid}" é usada tanto pelo Database.SQL "${owner}" (delegação exclusiva ` +
        `Microsoft.DBforPostgreSQL/flexibleServers) quanto por um Compute.Container (delegação exclusiva ` +
        `Microsoft.App/environments) — uma subnet só aceita UMA delegation. Use subnets separadas.`,
      );
    }
  }

  const subnetsByVpc = new Map<string, Array<{ id: string; cidr: string; public: boolean; delegationService?: string }>>();
  for (const c of stack.constructs) {
    if (c.type !== 'Network.Subnet') continue;
    const p = c.props as Record<string, unknown>;
    const vpcId = p.vpcId;
    const vnetId = isRef(vpcId) ? (vpcId as Ref).constructId : vpcId as string;
    if (!subnetsByVpc.has(vnetId)) subnetsByVpc.set(vnetId, []);
    subnetsByVpc.get(vnetId)!.push({
      id: c.id,
      cidr: p.cidr as string,
      public: (p.public as boolean) ?? false,
      delegationService: postgresSubnetOwner.has(c.id)
        ? 'Microsoft.DBforPostgreSQL/flexibleServers'
        : containerSubnetOwner.has(c.id)
          ? 'Microsoft.App/environments'
          : undefined,
    });
  }

  // Outputs cross-stack de VpcId/SubnetId (ver resolveSubnetForVnetIntegration em
  // shared.ts): só emitidos quando ALGUM Database.SQL/Compute.Container com
  // subnetIds está numa stack DIFERENTE da subnet — emitir sempre poluiria
  // (e quebraria golden tests de) stacks 100% de rede sem consumidor nenhum.
  // Bug real de bateria (p09): sem o wiring param↔output entre módulos do
  // _main.bicep, o módulo do banco/container podia deployar antes da VNet
  // terminar (corrida no ARM) — ver generateAzureMainBicep em synth-out.ts.
  const stackOfConstruct = new Map<string, string>();
  for (const s of opts?.allStacks ?? [stack]) {
    for (const c of s.constructs) stackOfConstruct.set(c.id, s.name);
  }
  const crossStackSubnetIds = new Set<string>();
  const crossStackVpcIds = new Set<string>();
  for (const c of allConstructs) {
    if (c.type !== 'Database.SQL' && c.type !== 'Compute.Container') continue;
    const p = c.props as Record<string, unknown>;
    const consumerSubnetIds = (p.subnetIds as string[] | undefined) ?? [];
    for (const sid of consumerSubnetIds) {
      if (stackOfConstruct.get(sid) === stackOfConstruct.get(c.id)) continue; // same-stack: sem param, ver shared.ts
      crossStackSubnetIds.add(sid);
      const subnetConstruct = globalIdx.get(sid);
      if (!subnetConstruct) continue;
      const subnetVpcRaw = (subnetConstruct.props as Record<string, unknown>).vpcId;
      crossStackVpcIds.add(isRef(subnetVpcRaw) ? (subnetVpcRaw as Ref).constructId : subnetVpcRaw as string);
    }
  }

  const hasContainerApp = stack.constructs.some(c => c.type === 'Compute.Container');
  // O env compartilhado (free tier: só 1 por região) só serve containers SEM
  // subnetIds — quem pede VNet integration ganha um Microsoft.App/managedEnvironments
  // dedicado (ver compute.ts). Sem essa distinção, todo projeto com Container Apps
  // em VNet criaria um CAE órfão e não-referenciado além do dedicado.
  const needsSharedContainerEnv = stack.constructs.some(
    c => c.type === 'Compute.Container' && ((c.props as Record<string, unknown>).subnetIds as string[] | undefined ?? []).length === 0,
  );
  let sharedContainerEnvSym: string | null = null;
  if (needsSharedContainerEnv) {
    sharedContainerEnvSym = 'sharedContainerEnv';
    resources.push({
      sym: sharedContainerEnvSym,
      type: 'Microsoft.App/managedEnvironments',
      apiVersion: '2023-05-01',
      name: expr(`'${stack.name}-cae'`),
      location: 'location',
      tags: { Stack: stack.name },
      properties: { zoneRedundant: false },
      condition: 'empty(sharedCaeId)',
    });
    outputs.push({ name: 'sharedCaeId', type: 'string', value: `empty(sharedCaeId) ? ${sharedContainerEnvSym}.id : sharedCaeId` });
  }

  // Storage compartilhada entre TODAS as Function.Lambda da stack — usada só
  // para AzureWebJobsStorage/WEBSITE_CONTENTAZUREFILECONNECTIONSTRING (connection
  // string via listKeys()). Cada Function App tem seu próprio WEBSITE_CONTENTSHARE
  // e AzureFunctionsWebHost__hostid (ver function.ts) para não colidir no mesmo
  // storage account.
  const hasLambda = stack.constructs.some(c => c.type === 'Function.Lambda');
  const sharedFunctionStorageSym: string | null = hasLambda ? 'sharedFnStorage' : null;
  if (sharedFunctionStorageSym) {
    resources.push({
      sym: sharedFunctionStorageSym,
      type: 'Microsoft.Storage/storageAccounts',
      apiVersion: '2023-01-01',
      name: expr(`'fn\${uniqueString(resourceGroup().id)}'`),
      location: 'location',
      sku: { name: 'Standard_LRS' },
      kind: 'StorageV2',
      tags: { Stack: stack.name },
      properties: { minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false },
    });
  }

  const sharedApim = opts?.sharedApim
    ? {
        name: opts.sharedApim.name,
        resourceGroup: opts.sharedApim.resourceGroup,
        crossRg: opts.sharedApim.projectResourceGroup !== undefined
          && opts.sharedApim.projectResourceGroup !== opts.sharedApim.resourceGroup,
        projectSlug: (opts.projectName ?? stack.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'iacmp',
        crossRgModuleSym: 'sharedApimChildren',
      }
    : undefined;
  // Só existe quando crossRg: acumula os filhos do APIM compartilhado que não
  // podem ficar no scope do template do projeto (BCP165) — ver Function.ApiGateway.
  const apimCrossRgChild = sharedApim?.crossRg
    ? { resources: [] as BicepResource[], outputs: [] as BicepOutput[], params: new Map<string, string>(), existingDeclared: false }
    : undefined;

  const ctx: SynthContext = {
    idx,
    globalIdx,
    resources,
    outputs,
    needsAdminPassword,
    crossParams,
    functionImageParams,
    sharedContainerEnvSym,
    sharedFunctionStorageSym,
    cdnBucketRefs,
    subnetsByVpc,
    accountTier,
    dedicatedContainerEnvs: new Map<string, string>(),
    crossStackSubnetIds,
    crossStackVpcIds,
    sharedApim,
    apimCrossRgChild,
  };

  for (const construct of stack.constructs) {
    synthesizeConstruct(construct, ctx);
  }

  // Guard: handlers de Lambda que acessam Cache.Redis devem usar REDIS_CONNECTION_STRING
  const hasRedis = stack.constructs.some(c => c.type === 'Cache.Redis');
  if (hasRedis) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePath = require('path') as typeof import('path');
    const srcDir = nodePath.join(process.cwd(), 'src');
    if (fs.existsSync(srcDir)) {
      const badHandlers: string[] = [];
      for (const f of fs.readdirSync(srcDir).filter((f: string) => f.endsWith('.ts'))) {
        const code = fs.readFileSync(nodePath.join(srcDir, f), 'utf-8');
        const usesRedisHost = /new\s+Redis\s*\(\s*\{/.test(code) || /process\.env\.REDIS_HOST/.test(code);
        const usesConnStr = /REDIS_CONNECTION_STRING/.test(code);
        if (usesRedisHost && !usesConnStr) badHandlers.push(f);
      }
      if (badHandlers.length > 0) {
        throw new Error(
          `Handlers de Redis sem REDIS_CONNECTION_STRING detectados: ${badHandlers.join(', ')}\n\n` +
          `No Azure, Cache.Redis usa Redis Enterprise (porta 10000, TLS obrigatório).\n` +
          `NUNCA use new Redis({ host, port }) — falta autenticação e TLS.\n` +
          `CORRETO:\n` +
          `  environment: { REDIS_CONNECTION_STRING: ref('MyCache', 'ConnectionString') }\n` +
          `  // handler:\n` +
          `  const redis = new Redis(process.env.REDIS_CONNECTION_STRING!);`
        );
      }
    }
  }

  // Post-processing: Container Apps com Event Grid trigger same-stack → minReplicas:1.
  for (const lambdaId of lambdaWithEventGridTrigger) {
    const app = resources.find(r => r.sym === toSym(lambdaId) && r.type === 'Microsoft.App/containerApps');
    if (app?.properties?.template) {
      const tmpl = app.properties.template as Record<string, unknown>;
      tmpl.scale = { ...(tmpl.scale as object ?? {}), minReplicas: 1 };
    }
  }

  // Post-processing: Storage.Buckets referenciados por CDN via bucketRef → allowBlobPublicAccess.
  // NÃO cria mais um container decorativo 'web' aqui (removido — bug confirmado em
  // deploy real, bateria p06): nada no pipeline de deploy jamais fazia upload nele
  // (nenhum `az storage blob upload*` em todo o deploy/azure.ts), e mesmo populado à
  // mão um container Blob comum não resolve documento default no root — GET / sempre
  // 404 (diferente do defaultRootObject do CloudFront/AWS, que o synth Azure nunca
  // implementou). Para servir root funcionalmente no Azure use
  // Storage.Bucket({ websiteHosting: true }) — ativa o endpoint $web (data-plane, ver
  // deploy/azure.ts) com primaryEndpoints.web e index/error document reais; ver o
  // tratamento de websiteHosting em constructs/network.ts (Network.CDN).
  for (const bucketId of cdnBucketRefs) {
    const bucketSym = toSym(bucketId);
    const bucketResource = resources.find(r => r.sym === bucketSym);
    if (bucketResource) {
      bucketResource.properties.allowBlobPublicAccess = true;
    }
  }

  // Choke point global: resolve todos os Ref que escaparam dos cases individuais.
  for (const r of resources) {
    r.properties = resolveValue(r.properties, idx, crossParams) as Record<string, unknown>;
    if (r.name !== undefined) r.name = resolveValue(r.name, idx, crossParams);
    if (r.tags) r.tags = resolveValue(r.tags, idx, crossParams) as Record<string, string>;
  }

  // Guard: detecta ref() concatenado com string (ex: ref('X','Arn') + '/*' → '[object Object]/*')
  const serialized = JSON.stringify(resources);
  const badPaths: string[] = [];
  if (serialized.includes('[object Object]')) {
    const scan = (node: unknown, path: string): void => {
      if (typeof node === 'string' && node.includes('[object Object]')) badPaths.push(path);
      else if (Array.isArray(node)) node.forEach((v, i) => scan(v, `${path}[${i}]`));
      else if (node && typeof node === 'object') Object.entries(node as Record<string, unknown>).forEach(([k, v]) => scan(v, `${path}.${k}`));
    };
    resources.forEach((r, i) => scan(r, `resources[${i}]`));
  }
  if (badPaths.length > 0) {
    throw new Error(
      `"[object Object]" detectado no template Bicep em: ${badPaths.join(', ')}\n\n` +
      `Causa: ref(...) foi concatenado com string no código da stack (ex: ref('MeuBucket','Arn') + '/*').\n` +
      `NÃO concatene refs — use apenas ref() diretamente nos campos que aceitam referência.\n` +
      `No Azure, policies de storage usam RBAC e não precisam de ARN com '/*'.`
    );
  }

  // APIM compartilhado cross-RG: renderiza os filhos acumulados por
  // Function.ApiGateway (case sharedApim.crossRg) como um arquivo .bicep-irmão
  // e adiciona o `module` que o invoca com `scope: resourceGroup(sharedApim.
  // resourceGroup)` — só roda quando algum API Gateway efetivamente usou o
  // sharedApim cross-RG (apimCrossRgChild.resources não fica vazio nesse caso).
  if (apimCrossRgChild && apimCrossRgChild.resources.length > 0 && sharedApim) {
    const childParams = [...apimCrossRgChild.params.keys()].map(name => ({ name, type: 'string' }));
    const childContent = renderBicep(childParams, apimCrossRgChild.resources, apimCrossRgChild.outputs);
    // Prefixo "_" (mesma convenção do _main.bicep): isStackFile (synth-out.ts)
    // ignora arquivos "_*" ao listar templates/stacks — sem isso, este módulo
    // companheiro (que só existe pra ser referenciado de DENTRO do .bicep da
    // stack, nunca deployado sozinho) seria tratado como uma stack própria pelo
    // _main.bicep e o `param` interno dele exigiria um output inexistente.
    const childFilename = `_${stack.name}.apim-shared-children.bicep`;
    opts?.moduleFilesOut?.push({ filename: childFilename, content: childContent });

    const moduleParams: Record<string, unknown> = {};
    for (const [name, value] of apimCrossRgChild.params) moduleParams[name] = value;

    resources.push({
      sym: sharedApim.crossRgModuleSym,
      type: 'module',
      apiVersion: '',
      moduleFile: childFilename,
      name: `${sharedApim.projectSlug}-apim-children-deploy`,
      scope: `resourceGroup('${sharedApim.resourceGroup}')`,
      properties: moduleParams,
    });
  }

  const params: Array<{ name: string; type: string; default?: unknown; secure?: boolean }> = [
    { name: 'location', type: 'string', default: expr('resourceGroup().location') },
  ];
  if (needsAdminPassword.value || crossParams.get('adminPassword') === 'secureString') {
    params.push({ name: 'adminPassword', type: 'string', secure: true });
    crossParams.delete('adminPassword');
  }
  for (const [name, defaultImage] of functionImageParams) {
    params.push({ name, type: 'string', default: defaultImage || 'node:20-alpine' });
  }
  if (hasContainerApp) {
    params.push({ name: 'acrServer', type: 'string', default: '' });
    params.push({ name: 'acrUser', type: 'string', default: '' });
    params.push({ name: 'acrPassword', type: 'string', default: '', secure: true });
  }
  if (needsSharedContainerEnv) {
    params.push({ name: 'sharedCaeId', type: 'string', default: '' });
  }
  for (const [name, type] of crossParams) {
    if (type === 'secureString') { params.push({ name, type: 'string', secure: true }); continue; }
    if (type === 'string:optional') { params.push({ name, type: 'string', default: '' }); continue; }
    params.push({ name, type });
  }

  // Rede de segurança offline: valida os recursos gerados contra o catálogo de
  // conhecimento Azure (métricas por namespace, enums de alarme) — pega em
  // synth-time (2s) a classe de erro que o `az validate` não vê e que só o ARM
  // reprovaria depois de ~15min de deploy.
  const semanticErrors = validateAzureResources(resources);
  if (semanticErrors.length > 0) {
    throw new Error(`Validação Azure (synth) falhou:\n- ${semanticErrors.join('\n- ')}`);
  }

  return renderBicep(params, resources, outputs);
}
