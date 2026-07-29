import * as fs from 'fs';
import path from 'path';
import { t } from './i18n';

export function resolveMcpServer(): string {
  // O servidor MCP é bundlado em dist/mcp-server.js junto com a CLI — mas SÓ
  // nos builds feitos com o checkout do iacmp-mcp presente (máquina de dev /
  // build Pro; ver tsup.config.ts). Este módulo é inlinado em qualquer bundle
  // que o importa (ex: dist/commands/setup.js), então __filename varia.
  // Navegamos até dist/ localizando o segmento 'dist' no caminho.
  const sep = path.sep;
  const marker = sep + 'dist' + sep;
  const idx = __filename.lastIndexOf(marker);
  if (idx !== -1) {
    const distDir = __filename.slice(0, idx + sep.length + 4); // até 'dist' inclusive
    const bundled = path.join(distDir, 'mcp-server.js');
    if (fs.existsSync(bundled)) return bundled;
  }
  // Fallback para execução fora do bundle (dev local com ts-node)
  try { return require.resolve('@iacmp/mcp/dist/server.js'); } catch { /* ausente */ }
  throw new Error(t(
    'O servidor MCP (busca de exemplos validados) faz parte do iacmp Pro — este build não o inclui.\n' +
    'O restante do CLI (init/synth/deploy/destroy/diff/diagram) funciona normalmente sem ele.',
    'The MCP server (validated-example search) is part of iacmp Pro — this build does not include it.\n' +
    'The rest of the CLI (init/synth/deploy/destroy/diff/diagram) works fully without it.',
  ));
}
