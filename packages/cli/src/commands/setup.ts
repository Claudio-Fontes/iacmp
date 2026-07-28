import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import { homedir, platform } from 'os';
import chalk from 'chalk';
import { resolveMcpServer } from '../mcp-path';

interface Target {
  label: string;
  file: string;
  /** Claude Code (~/.claude.json) é gerido pelo app — só atualizamos se já existe.
   * O Claude Desktop lê um arquivo dedicado — podemos criá-lo. */
  createIfMissing: boolean;
}

function claudeTargets(): Target[] {
  const home = homedir();
  const targets: Target[] = [
    { label: 'Claude Code', file: path.join(home, '.claude.json'), createIfMissing: false },
  ];
  const p = platform();
  let desktop: string | undefined;
  if (p === 'darwin') {
    desktop = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else if (p === 'win32') {
    desktop = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json')
      : undefined;
  } else {
    desktop = path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
  if (desktop) targets.push({ label: 'Claude Desktop', file: desktop, createIfMissing: true });
  return targets;
}

export default class Setup extends Command {
  static description =
    'Integra o iacmp com o Claude: registra o servidor MCP (write_stack, synth_project, ' +
    'deploy_project…) no Claude Code e no Claude Desktop. Idempotente.';

  static examples = ['$ iacmp setup', '$ iacmp setup --dry-run'];

  static flags = {
    'dry-run': Flags.boolean({ description: 'Mostra o que seria escrito, sem alterar nada', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Setup);

    let serverPath: string;
    try {
      serverPath = resolveMcpServer();
    } catch (err) {
      this.error((err as Error).message);
    }

    // Caminhos absolutos (node + servidor): o Claude Desktop é GUI e não herda o
    // PATH do shell, então depender de um binário no PATH seria frágil.
    const entry = { command: process.execPath, args: [serverPath, 'stdio'] };

    this.log(chalk.bold('iacmp setup — integração com o Claude'));
    this.log(chalk.dim(`servidor MCP: ${serverPath}`));
    this.log('');

    let touched = false;
    for (const t of claudeTargets()) {
      const exists = fs.existsSync(t.file);
      if (!exists && !t.createIfMissing) {
        this.log(`${chalk.yellow('•')} ${t.label}: não encontrado — pulado`);
        continue;
      }
      if (flags['dry-run']) {
        this.log(`${chalk.cyan('•')} ${t.label}: registraria mcpServers.iacmp em ${t.file}`);
        touched = true;
        continue;
      }

      let config: Record<string, unknown> = {};
      if (exists) {
        try {
          config = JSON.parse(fs.readFileSync(t.file, 'utf8')) as Record<string, unknown>;
        } catch {
          this.log(`${chalk.red('•')} ${t.label}: ${t.file} não é JSON válido — pulado (ajuste manual)`);
          continue;
        }
      } else {
        fs.mkdirSync(path.dirname(t.file), { recursive: true });
      }

      const servers = (config.mcpServers ?? (config.mcpServers = {})) as Record<string, unknown>;
      const had = servers.iacmp !== undefined;
      servers.iacmp = entry;
      fs.writeFileSync(t.file, JSON.stringify(config, null, 2) + '\n');
      this.log(`${chalk.green('✓')} ${t.label}: ${had ? 'atualizado' : 'registrado'} (${t.file})`);
      touched = true;
    }

    this.log('');
    if (!touched) {
      this.log(chalk.yellow('Nenhum config do Claude encontrado. Instale o Claude Code ou o Claude Desktop e rode `iacmp setup` de novo.'));
    } else if (!flags['dry-run']) {
      this.log(chalk.bold('Pronto.') + ' Reinicie o Claude para carregar os tools do iacmp.');
    }
  }
}
