import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import { homedir, platform } from 'os';
import chalk from 'chalk';
import { t } from '../i18n';
import { resolveMcpServer } from '../mcp-path';

interface Target {
  label: string;
  file: string;
  createIfMissing: boolean;
}

function claudeTargets(): Target[] {
  const home = homedir();
  // ~/.claude.json pode não existir (Claude Code instalado mas nunca aberto);
  // criamos com só o mcpServers — é o mesmo que `claude mcp add --scope user`
  // faz, e o app funde o resto na primeira execução. Pular aqui deixava a
  // máquina "configurada" sem o Claude Code configurado.
  const targets: Target[] = [
    { label: 'Claude Code', file: path.join(home, '.claude.json'), createIfMissing: true },
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
  static description = t(
    'Integra o iacmp com o Claude: registra o servidor MCP (write_stack, synth_project, ' +
    'deploy_project…) no Claude Code e no Claude Desktop. Idempotente.',
    'Integrates iacmp with Claude: registers the MCP server (write_stack, synth_project, ' +
    'deploy_project…) in Claude Code and Claude Desktop. Idempotent.');

  static examples = ['$ iacmp setup', '$ iacmp setup --dry-run'];

  static flags = {
    'dry-run': Flags.boolean({ description: t('Mostra o que seria escrito, sem alterar nada', 'Shows what would be written, without changing anything'), default: false }),
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

    this.log(chalk.bold(t('iacmp setup — integração com o Claude', 'iacmp setup — Claude integration')));
    this.log(chalk.dim(t(`servidor MCP: ${serverPath}`, `MCP server: ${serverPath}`)));
    this.log('');

    let touched = false;
    for (const target of claudeTargets()) {
      const exists = fs.existsSync(target.file);
      if (!exists && !target.createIfMissing) {
        this.log(t(`${chalk.yellow('•')} ${target.label}: não encontrado — pulado`, `${chalk.yellow('•')} ${target.label}: not found — skipped`));
        continue;
      }
      if (flags['dry-run']) {
        this.log(t(`${chalk.cyan('•')} ${target.label}: registraria mcpServers.iacmp em ${target.file}`, `${chalk.cyan('•')} ${target.label}: would register mcpServers.iacmp in ${target.file}`));
        touched = true;
        continue;
      }

      let config: Record<string, unknown> = {};
      if (exists) {
        try {
          config = JSON.parse(fs.readFileSync(target.file, 'utf8')) as Record<string, unknown>;
        } catch {
          this.log(t(`${chalk.red('•')} ${target.label}: ${target.file} não é JSON válido — pulado (ajuste manual)`, `${chalk.red('•')} ${target.label}: ${target.file} is not valid JSON — skipped (fix manually)`));
          continue;
        }
      } else {
        fs.mkdirSync(path.dirname(target.file), { recursive: true });
      }

      const servers = (config.mcpServers ?? (config.mcpServers = {})) as Record<string, unknown>;
      const had = servers.iacmp !== undefined;
      servers.iacmp = entry;
      fs.writeFileSync(target.file, JSON.stringify(config, null, 2) + '\n');
      this.log(t(`${chalk.green('✓')} ${target.label}: ${had ? 'atualizado' : 'registrado'} (${target.file})`, `${chalk.green('✓')} ${target.label}: ${had ? 'updated' : 'registered'} (${target.file})`));
      touched = true;
    }

    this.log('');
    if (!touched) {
      this.log(chalk.yellow(t('Nenhum config do Claude encontrado. Instale o Claude Code ou o Claude Desktop e rode `iacmp setup` de novo.', 'No Claude config found. Install Claude Code or Claude Desktop and run `iacmp setup` again.')));
    } else if (!flags['dry-run']) {
      // MCP carrega no STARTUP da sessão — rodar o setup de dentro de uma sessão
      // do Claude Code (cenário comum: o próprio agente roda) não dá as tools à
      // sessão atual, e nada avisa. CLAUDECODE=1 identifica esse caso.
      if (process.env.CLAUDECODE) {
        this.log(chalk.yellow.bold(t(
          '⚠ Você está DENTRO de uma sessão do Claude Code — esta sessão NÃO ganha as tools agora.',
          '⚠ You are INSIDE a Claude Code session — this session does NOT get the tools now.')));
        this.log(chalk.yellow(t(
          '  Saia e abra o Claude Code de novo (as tools carregam no início da sessão).',
          '  Exit and reopen Claude Code (tools load at session startup).')));
      } else {
        this.log(chalk.bold(t('Pronto.', 'Done.')) + t(' Reinicie o Claude para carregar os tools do iacmp.', ' Restart Claude to load the iacmp tools.'));
      }
      this.log(chalk.dim(t('Para conferir: digite /mcp no Claude Code — o servidor "iacmp" deve aparecer na lista.', 'To verify: type /mcp in Claude Code — the "iacmp" server should appear in the list.')));
    }
  }
}
