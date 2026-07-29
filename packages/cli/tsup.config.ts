import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

/**
 * O `iacmp` é distribuído como um pacote único (`npm i -g iacmp`). Os pacotes
 * internos do workspace (providers, dashboard, registry, plugin-sdk) são
 * inlinados no bundle. As EXCEÇÕES:
 *  - @iacmp/core e @iacmp/runtime: publicados no npm como dependência real —
 *    os stacks/handlers do usuário fazem `import from '@iacmp/core'` /
 *    `'@iacmp/runtime'`, então precisam existir on-disk como módulo resolvível.
 *  - @iacmp/ai e @iacmp/knowledge: módulos PRO (repo privado iacmp-pro) —
 *    NUNCA inlinados no bundle público. O CLI os carrega dinamicamente via
 *    src/pro/ e degrada com mensagem quando ausentes.
 * As deps de terceiros (@oclif/core, chalk, diff, ora, @anthropic-ai/sdk)
 * também ficam externas.
 *
 * Bundles:
 *  - src/        → dist/ (preserva dist/commands/ para a descoberta do oclif)
 *  - bin/chat.js → dist/chat.js (script spawnado em `iacmp ai --chat`)
 *  - iacmp-mcp   → dist/mcp-server.js — SÓ quando o checkout irmão
 *    ../../../iacmp-mcp existe (máquina de dev / build Pro). O build público
 *    sai sem o servidor MCP embutido; `iacmp setup`/`mcp serve` degradam.
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
  // inlina @iacmp/* EXCETO core/runtime (deps publicadas) e ai/knowledge (Pro)
  noExternal: [/^@iacmp\/(?!core|runtime|ai|knowledge)/],
  external: ['@iacmp/ai', '@iacmp/knowledge'],
};

const MCP_SERVER_ENTRY = '../../../iacmp-mcp/src/server.ts';

// GUARD DE PUBLICAÇÃO: no build público (IACMP_PUBLIC_BUILD=1, usado pelo
// prepack) o @iacmp/knowledge (o corpus — conteúdo Pro) fica EXTERNAL no
// bundle do mcp-server: o servidor embutido vai pro tarball SÓ com as
// ferramentas mecânicas (write_stack/synth/deploy/destroy/...) — o server.ts
// carrega o módulo de knowledge dinamicamente e degrada quando ausente.
// No build de dev/Pro o corpus é inlinado (comportamento completo).
const isPublicBuild = process.env.IACMP_PUBLIC_BUILD === '1';
const includeMcpServer = existsSync(MCP_SERVER_ENTRY);

export default defineConfig([
  {
    ...common,
    entry: ['src/index.ts', 'src/help.ts', 'src/commands/**/*.ts', 'src/hooks/welcome.ts', 'src/deploy/azure-dynamo-shim.ts', 'src/deploy/azure-s3-shim.ts'],
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
  // Servidor MCP embutido: bundla @modelcontextprotocol/sdk (e, no build
  // dev/Pro, o @iacmp/knowledge). better-sqlite3 está nas deps da CLI → fica
  // externo automaticamente (addon nativo). Entry só existe quando o checkout
  // do iacmp-mcp está ao lado (sempre verdadeiro na máquina que publica).
  ...(includeMcpServer ? [{
    format: ['cjs'] as const,
    platform: 'node' as const,
    target: 'node20',
    bundle: true,
    splitting: false,
    sourcemap: false,
    dts: false,
    shims: false,
    entry: { 'mcp-server': MCP_SERVER_ENTRY },
    outDir: 'dist',
    clean: false,
    ...(isPublicBuild ? { external: ['@iacmp/knowledge'] } : {}),
  }] : []),
]);
