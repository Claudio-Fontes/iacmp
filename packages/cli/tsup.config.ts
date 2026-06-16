import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'fs';

/**
 * O `iacmp` é distribuído como um pacote único (`npm i -g iacmp`). Os pacotes
 * internos do workspace (@iacmp/ai, providers, dashboard, registry, plugin-sdk)
 * são inlinados no bundle. A EXCEÇÃO é @iacmp/core: ele é publicado no npm como
 * dependência real, pois os stacks do usuário fazem `import from '@iacmp/core'`
 * e o `init` referencia o pacote — então core precisa existir on-disk como
 * módulo resolvível, não inlinado. As deps de terceiros (@oclif/core, chalk,
 * diff, ora, @anthropic-ai/sdk) também ficam externas.
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
  // inlina @iacmp/* EXCETO @iacmp/core (este fica externo, dep real publicada)
  noExternal: [/^@iacmp\/(?!core)/],
};

export default defineConfig([
  {
    ...common,
    entry: ['src/index.ts', 'src/commands/**/*.ts'],
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
