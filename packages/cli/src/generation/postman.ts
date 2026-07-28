import * as fs from 'fs';
import * as path from 'path';
import { Stack } from '@iacmp/core';

function resolveModule(projectDir: string, moduleName: string): string | null {
  let dir = projectDir;
  for (let i = 0; i < 5; i++) {
    const modPath = path.join(dir, 'node_modules', moduleName);
    if (fs.existsSync(modPath)) return modPath;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findStackFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findStackFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

interface Route {
  method: string;
  path: string;
  lambdaId?: string;
}

interface PostmanRequest {
  name: string;
  request: {
    method: string;
    header: Array<{ key: string; value: string }>;
    body?: { mode: string; raw: string };
    url: { raw: string; host: string[]; path: string[]; variable?: Array<{ key: string; value: string; description: string }> };
  };
  response: unknown[];
}

function routeToPostmanItem(route: Route, projectName: string): PostmanRequest {
  // /items/{id} → /items/{{id}}
  const postmanPath = route.path.replace(/\{([^}]+)\}/g, '{{$1}}');
  // Split path into segments, removing leading empty
  const pathSegments = postmanPath.split('/').filter(Boolean);

  // Extract path params like {{id}}
  const pathParamMatches = [...postmanPath.matchAll(/\{\{([^}]+)\}\}/g)];
  const pathVariables = pathParamMatches.map(m => ({
    key: m[1],
    value: '',
    description: `Path param: ${m[1]}`,
  }));

  const needsBody = ['POST', 'PUT', 'PATCH'].includes(route.method.toUpperCase());
  const handlerName = route.lambdaId ?? '';
  // Human-readable name: method + path without leading slash
  const itemName = `${route.method.toUpperCase()} ${route.path}`;

  const item: PostmanRequest = {
    name: itemName,
    request: {
      method: route.method.toUpperCase(),
      header: needsBody ? [{ key: 'Content-Type', value: 'application/json' }] : [],
      url: {
        raw: `{{baseUrl}}${postmanPath}`,
        host: ['{{baseUrl}}'],
        path: pathSegments,
        ...(pathVariables.length > 0 ? { variable: pathVariables } : {}),
      },
    },
    response: [],
  };

  if (needsBody) {
    item.request.body = {
      mode: 'raw',
      raw: JSON.stringify({ message: 'exemplo' }, null, 2),
    };
  }

  return item;
}

export function generatePostmanCollection(cwd: string): string {
  const stacksDir = path.join(cwd, 'stacks');
  const configPath = path.join(cwd, 'iacmp.json');

  // Project name from iacmp.json
  let projectName = path.basename(cwd);
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    if (typeof cfg.name === 'string' && cfg.name) projectName = cfg.name;
  } catch { /* usa dirname */ }

  // Register tsx for TypeScript stack files
  const tsxPath = resolveModule(cwd, 'tsx');
  if (tsxPath) {
    try {
      const tsxApiPath = require.resolve('tsx/cjs/api', { paths: [cwd] });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require(tsxApiPath) as { register: () => void }).register();
    } catch { /* tsx register falhou, tenta sem */ }
  }

  const stackFiles = findStackFiles(stacksDir);
  const routes: Route[] = [];

  for (const stackPath of stackFiles) {
    let stackModule: Record<string, unknown>;
    try {
      stackModule = require(stackPath) as Record<string, unknown>;
    } catch { continue; }

    const stack = stackModule.default ?? stackModule.stack ?? stackModule;
    if (!stack || typeof stack !== 'object' || !('constructs' in stack)) continue;

    const constructs = (stack as Stack).constructs ?? [];
    for (const c of constructs) {
      if (c.type !== 'Function.ApiGateway') continue;
      const props = (c.props ?? {}) as Record<string, unknown>;
      const apigwRoutes = (props.routes as Array<Record<string, unknown>>) ?? [];
      for (const r of apigwRoutes) {
        if (typeof r.method === 'string' && typeof r.path === 'string') {
          routes.push({
            method: r.method,
            path: r.path,
            lambdaId: typeof r.lambdaId === 'string' ? r.lambdaId : undefined,
          });
        }
      }
    }
  }

  // Collect unique path params across all routes
  const allPathParams = new Set<string>();
  for (const r of routes) {
    for (const m of r.path.matchAll(/\{([^}]+)\}/g)) allPathParams.add(m[1]);
  }

  const variables: Array<{ key: string; value: string; type: string }> = [
    { key: 'baseUrl', value: 'https://SEU_API_ID.execute-api.us-east-1.amazonaws.com/prod', type: 'string' },
    ...[...allPathParams].map(p => ({ key: p, value: '', type: 'string' })),
  ];

  const collection = {
    info: {
      name: `${projectName} API`,
      description: `Collection gerada automaticamente a partir das rotas de ${projectName}.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: routes.map(r => routeToPostmanItem(r, projectName)),
    variable: variables,
  };

  return JSON.stringify(collection, null, 2);
}
