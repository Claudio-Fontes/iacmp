import { Command } from '@oclif/core';
import { spawn } from 'child_process';
import { resolveMcpServer } from '../../mcp-path';

export default class McpServe extends Command {
  static description =
    'Roda o servidor MCP do iacmp (protocolo stdio) para o Claude. Você normalmente ' +
    'não chama isto à mão — `iacmp setup` registra este comando no Claude, que o ' +
    'executa sozinho.';

  static examples = ['$ iacmp mcp serve'];

  async run(): Promise<void> {
    const serverPath = resolveMcpServer();
    // Executa o servidor MCP herdando stdin/stdout — é por eles que o Claude fala
    // com o servidor (transporte stdio). O run() precisa AGUARDAR o child sair;
    // se retornasse antes, o oclif finalizaria o comando e mataria o servidor.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [serverPath, 'stdio'], { stdio: 'inherit' });
      child.on('exit', code => { process.exitCode = code ?? 0; resolve(); });
      child.on('error', err => reject(new Error(`Falha ao iniciar o servidor MCP: ${err.message}`)));
    });
  }
}
