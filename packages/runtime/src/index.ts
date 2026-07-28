import type { Blob, Cache, CacheConfig, Queue, RuntimeAdapter, Secret, Sql, SqlConfig, Table } from './types';

export type { Blob, Cache, CacheConfig, Queue, QueueMessage, RuntimeAdapter, Secret, Sql, SqlConfig, Table } from './types';

// Mecanismo PRIMÁRIO: alias de bundle (esbuild, em packages/cli/src/deploy/{aws,azure,gcp}.ts)
// substitui '@iacmp/runtime' pelo adaptador correto em tempo de build. Este seletor
// por env var só é usado fora do fluxo de deploy do iacmp (testes, local, etc.).
let cached: RuntimeAdapter | null = null;
function getAdapter(): RuntimeAdapter {
  if (!cached) {
    const cloud = process.env.IACMP_CLOUD;
    cached =
      cloud === 'azure'
        ? (require('./azure').default as RuntimeAdapter)
        : cloud === 'gcp'
          ? (require('./gcp').default as RuntimeAdapter)
          : (require('./aws').default as RuntimeAdapter);
  }
  return cached;
}

export function table(name: string): Table {
  return getAdapter().table(name);
}

export function blob(name: string): Blob {
  return getAdapter().blob(name);
}

export function queue(nameOrUrl: string): Queue {
  return getAdapter().queue(nameOrUrl);
}

export function cache(host: string, opts?: CacheConfig): Cache {
  return getAdapter().cache(host, opts);
}

export function sql(config: SqlConfig): Sql {
  return getAdapter().sql(config);
}

export function secret(nameOrArn: string): Secret {
  return getAdapter().secret(nameOrArn);
}
