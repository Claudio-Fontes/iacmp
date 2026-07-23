import type { Blob, RuntimeAdapter, Table } from './types';

export type { Blob, RuntimeAdapter, Table } from './types';

// Fallback runtime: o mecanismo PRIMÁRIO é o alias de bundle (esbuild, em
// packages/cli/src/deploy/{aws,azure}.ts), que troca a especificação
// '@iacmp/runtime' pelo adaptador certo em tempo de build — o handler nunca
// chega a executar este arquivo em deploy real. Este seletor por env var só
// importa (via require, lazy) o adaptador da cloud corrente, para não exigir
// as deps opcionais da OUTRA cloud (@aws-sdk/* vs mongodb/@azure/storage-blob)
// em quem rodar o pacote fora do fluxo de deploy do iacmp.
let cached: RuntimeAdapter | null = null;
function getAdapter(): RuntimeAdapter {
  if (!cached) {
    cached =
      process.env.IACMP_CLOUD === 'azure'
        ? (require('./azure').default as RuntimeAdapter)
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
