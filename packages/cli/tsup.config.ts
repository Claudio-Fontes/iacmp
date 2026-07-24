import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'fs';

/**
 * O `iacmp` é distribuído como um pacote único (`npm i -g iacmp`). Os pacotes
 * internos do workspace (@iacmp/ai, providers, dashboard, registry, plugin-sdk)
 * são inlinados no bundle. As EXCEÇÕES são @iacmp/core e @iacmp/runtime: ambos
 * são publicados no npm como dependência real, pois os stacks/handlers do
 * usuário fazem `import from '@iacmp/core'` / `'@iacmp/runtime'` — precisam
 * existir on-disk como módulo resolvível (inclusive via `require.resolve` do
 * deploy, para achar o adaptador de cada cloud), não inlinados. As deps de
 * terceiros (@oclif/core, chalk, diff, ora, @anthropic-ai/sdk) também ficam
 * externas.
 *
 * São dois bundles porque têm raízes diferentes:
 *  - src/  → dist/ (preserva dist/commands/ para a descoberta de comandos do oclif)
 *  - bin/chat.js → dist/chat.js (script spawnado em `iacmp ai --chat`)
 */
const common = {
  format: ['cjs'] as const,
  platform: 'node' as const,
  target: 'node20',
  bundle: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  shims: false,
  // inlina @iacmp/* EXCETO @iacmp/core e @iacmp/runtime (ficam externos, deps reais publicadas)
  // inlina @iacmp/* EXCETO core, runtime e mcp (deps reais externas): core/runtime
  // porque os stacks/handlers do usuário os importam; mcp porque é o servidor MCP
  // (ESM + better-sqlite3 nativo) que `iacmp mcp serve` resolve on-disk.
  noExternal: [/^@iacmp\/(?!core|runtime|mcp)/],
};

export default defineConfig([
  {
    ...common,
    entry: ['src/index.ts', 'src/help.ts', 'src/commands/**/*.ts', 'src/deploy/azure-dynamo-shim.ts', 'src/deploy/azure-s3-shim.ts'],
    outDir: 'dist',
    clean: true,
    // @iacmp/registry foi inlinado, mas seu client.ts lê registry.json via
    // fs.readFileSync(path.join(__dirname, 'registry.json')). No bundle __dirname
    // é dist/commands/, e o tsup empacota só JS — então copiamos o data file
    // para lá, senão `iacmp registry list/search` quebra com ENOENT (CLI-REGISTRY-01).
    onSuccess: async () => {
      mkdirSync('dist/commands', { recursive: true });
      copyFileSync('../registry/src/registry.json', 'dist/commands/registry.json');
    },
  },
  {
    ...common,
    entry: { chat: 'bin/chat.js' },
    outDir: 'dist',
    clean: false,
  },
]);
