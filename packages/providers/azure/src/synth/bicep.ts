import { Stack, BaseConstruct, isRef } from '@iacmp/core';
import type { Ref } from '@iacmp/core';

import {
  expr,
  toSym, safeStorageName, bv, tag,
  crossParamName, resolveValue,
  BicepResource, BicepOutput, SynthContext,
} from './constructs/shared';

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
    const fields: Array<[string, unknown]> = [];
    if (r.scope) fields.push(['scope', expr(r.scope)]);
    if (r.parent) fields.push(['parent', expr(r.parent)]);
    if (r.name !== undefined) fields.push(['name', r.name]);
    if (r.location) fields.push(['location', expr(r.location)]);
    if (r.kind) fields.push(['kind', r.kind]);
    if (r.sku) fields.push(['sku', r.sku]);
    if (r.tags) fields.push(['tags', r.tags]);
    if (r.identity) fields.push(['identity', r.identity]);
    if (r.dependsOn && r.dependsOn.length > 0) {
      fields.push(['dependsOn', expr(`[\n    ${r.dependsOn.join('\n    ')}\n  ]`)]);
    }
    fields.push(['properties', r.properties]);

    lines.push(`resource ${r.sym} '${r.type}@${r.apiVersion}' = ${r.condition ? `if (${r.condition}) ` : ''}{`);
    for (const [k, v] of fields) {
      lines.push(`  ${k}: ${bv(v, 1)}`);
    }
    lines.push('}');
    lines.push('');
  }

  for (const o of outputs) {
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

// ── Main export ───────────────────────────────────────────────────────────────
export function emitBicep(stack: Stack, opts?: { accountTier?: 'free' | 'standard' }): string {
  const accountTier = opts?.accountTier ?? 'standard';
  const idx = new Map<string, BaseConstruct>(stack.constructs.map(c => [c.id, c]));
  const resources: BicepResource[] = [];
  const outputs: BicepOutput[] = [];
  const needsAdminPassword = { value: false };
  const crossParams = new Map<string, string>();
  const functionImageParams = new Set<string>();
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

  const subnetsByVpc = new Map<string, Array<{ id: string; cidr: string; public: boolean }>>();
  for (const c of stack.constructs) {
    if (c.type !== 'Network.Subnet') continue;
    const p = c.props as Record<string, unknown>;
    const vpcId = p.vpcId;
    const vnetId = isRef(vpcId) ? (vpcId as Ref).constructId : vpcId as string;
    if (!subnetsByVpc.has(vnetId)) subnetsByVpc.set(vnetId, []);
    subnetsByVpc.get(vnetId)!.push({ id: c.id, cidr: p.cidr as string, public: (p.public as boolean) ?? false });
  }

  const hasContainerApp = stack.constructs.some(c => c.type === 'Compute.Container');
  let sharedContainerEnvSym: string | null = null;
  if (hasContainerApp) {
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

  const hasLambda = stack.constructs.some(c => c.type === 'Function.Lambda');
  const sharedFunctionStorageSym: string | null = hasLambda ? 'sharedFnStorage' : null;
  const sharedFunctionPlanSym: string | null = hasLambda ? 'sharedFunctionPlan' : null;
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
  if (sharedFunctionPlanSym) {
    resources.push({
      sym: sharedFunctionPlanSym,
      type: 'Microsoft.Web/serverfarms',
      apiVersion: '2023-12-01',
      name: expr(`'${stack.name}-plan'`),
      location: 'location',
      kind: 'functionapp',
      sku: { name: 'FC1', tier: 'FlexConsumption' },
      tags: { Stack: stack.name },
      properties: { reserved: true },
    });
  }

  const sharedFnBlobServiceSym: string | null = hasLambda ? 'sharedFnStorageBlobSvc' : null;
  const sharedFnDeployContainerSym: string | null = hasLambda ? 'sharedFnDeployContainer' : null;

  if (sharedFnBlobServiceSym) {
    resources.push({
      sym: sharedFnBlobServiceSym,
      type: 'Microsoft.Storage/storageAccounts/blobServices',
      apiVersion: '2023-01-01',
      parent: sharedFunctionStorageSym!,
      name: 'default',
      properties: {},
    });
  }
  if (sharedFnDeployContainerSym) {
    resources.push({
      sym: sharedFnDeployContainerSym,
      type: 'Microsoft.Storage/storageAccounts/blobServices/containers',
      apiVersion: '2023-01-01',
      parent: sharedFnBlobServiceSym!,
      name: 'deployments',
      properties: {},
    });
  }

  const ctx: SynthContext = {
    idx,
    resources,
    outputs,
    needsAdminPassword,
    crossParams,
    functionImageParams,
    sharedContainerEnvSym,
    sharedFunctionPlanSym,
    sharedFunctionStorageSym,
    sharedFnDeployContainerSym,
    cdnBucketRefs,
    subnetsByVpc,
    accountTier,
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

  // Post-processing: Storage.Buckets referenciados por CDN via bucketRef → allowBlobPublicAccess + container 'web'.
  for (const bucketId of cdnBucketRefs) {
    const bucketSym = toSym(bucketId);
    const bucketResource = resources.find(r => r.sym === bucketSym);
    if (bucketResource) {
      bucketResource.properties.allowBlobPublicAccess = true;
    }
    const blobSvcSym = `${bucketSym}BlobService`;
    if (!resources.find(r => r.sym === blobSvcSym)) {
      resources.push({
        sym: blobSvcSym,
        type: 'Microsoft.Storage/storageAccounts/blobServices',
        apiVersion: '2023-01-01',
        parent: bucketSym,
        name: 'default',
        properties: {},
      });
    }
    resources.push({
      sym: `${bucketSym}WebContainer`,
      type: 'Microsoft.Storage/storageAccounts/blobServices/containers',
      apiVersion: '2023-01-01',
      parent: blobSvcSym,
      name: 'web',
      properties: { publicAccess: 'Blob' },
    });
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

  const params: Array<{ name: string; type: string; default?: unknown; secure?: boolean }> = [
    { name: 'location', type: 'string', default: expr('resourceGroup().location') },
  ];
  if (needsAdminPassword.value || crossParams.get('adminPassword') === 'secureString') {
    params.push({ name: 'adminPassword', type: 'string', secure: true });
    crossParams.delete('adminPassword');
  }
  for (const name of functionImageParams) {
    params.push({ name, type: 'string', default: 'node:20-alpine' });
  }
  if (hasContainerApp) {
    params.push({ name: 'acrServer', type: 'string', default: '' });
    params.push({ name: 'acrUser', type: 'string', default: '' });
    params.push({ name: 'acrPassword', type: 'string', default: '', secure: true });
    params.push({ name: 'sharedCaeId', type: 'string', default: '' });
  }
  for (const [name, type] of crossParams) {
    if (type === 'secureString') { params.push({ name, type: 'string', secure: true }); continue; }
    if (type === 'string:optional') { params.push({ name, type: 'string', default: '' }); continue; }
    params.push({ name, type });
  }

  return renderBicep(params, resources, outputs);
}
