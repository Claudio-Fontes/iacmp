/**
 * Resolve o caminho absoluto do servidor MCP (@iacmp/mcp), que vem como
 * dependência da CLI. Usado por `iacmp mcp serve` (para executá-lo) e por
 * `iacmp setup` (para gravar o caminho no config do Claude). Caminho absoluto —
 * o Claude Desktop (GUI) não herda o PATH do shell, então depender de um binário
 * no PATH seria frágil.
 */
export function resolveMcpServer(): string {
  try {
    return require.resolve('@iacmp/mcp/dist/server.js');
  } catch {
    try {
      return require.resolve('@iacmp/mcp');
    } catch {
      throw new Error(
        'Servidor MCP (@iacmp/mcp) não encontrado. Ele acompanha o iacmp como ' +
        'dependência — reinstale com: npm install -g iacmp',
      );
    }
  }
}
