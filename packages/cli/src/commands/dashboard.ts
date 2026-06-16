import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { startDashboard, ProjectInfo, StackInfo } from '@iacmp/dashboard';
import { listTemplates } from '../synth-out';

function parseResources(filePath: string, provider: string): Array<{ type: string; id: string }> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    if (provider === 'aws') {
      const resources = parsed.Resources as Record<string, { Type: string }> | undefined;
      if (resources) {
        return Object.entries(resources).map(([id, r]) => ({ type: r.Type, id }));
      }
    }

    if (provider === 'azure') {
      const resources = parsed.resources as Array<{ type: string; name: string }> | undefined;
      if (Array.isArray(resources)) {
        return resources.map(r => ({ type: r.type, id: r.name }));
      }
    }

    if (provider === 'gcp') {
      const resources = parsed.resources as Array<{ type: string; name: string }> | undefined;
      if (Array.isArray(resources)) {
        return resources.map(r => ({ type: r.type, id: r.name }));
      }
    }

    // genérico
    if (Array.isArray(parsed.resources)) {
      return (parsed.resources as Array<{ type?: string; name?: string; id?: string }>).map(r => ({
        type: r.type ?? 'unknown',
        id: r.name ?? r.id ?? 'unknown',
      }));
    }

    return [];
  } catch {
    return [];
  }
}

export default class Dashboard extends Command {
  static description = 'Inicia o dashboard web de visualização das stacks';

  static flags = {
    port: Flags.integer({ char: 'p', description: 'Porta do servidor', default: 4000 }),
    open: Flags.boolean({ description: 'Abre o browser automaticamente', default: false }),
  };

  static examples = [
    '$ iacmp dashboard',
    '$ iacmp dashboard --port 3000',
    '$ iacmp dashboard --open',
  ];

  async run(): Promise<void> {
    const { flags } = await this.parse(Dashboard);
    const cwd = process.cwd();
    const configPath = path.join(cwd, 'iacmp.json');

    if (!fs.existsSync(configPath)) {
      this.error('Projeto não inicializado. Rode: iacmp init');
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      name: string;
      provider: string;
      region: string;
    };

    const stacks: StackInfo[] = [];

    for (const t of listTemplates(cwd, config.provider)) {
      const resources = parseResources(t.filePath, config.provider);
      stacks.push({ name: t.stackName, provider: config.provider, resources });
    }

    const info: ProjectInfo = {
      name: config.name,
      provider: config.provider,
      region: config.region,
      stacks,
    };

    const port = flags.port;
    await startDashboard(info, port);

    const url = `http://localhost:${port}`;
    this.log(`Dashboard disponível em ${url}`);

    if (flags.open) {
      try {
        const openCmd = process.platform === 'win32' ? `start ${url}` : `open ${url}`;
        execSync(openCmd);
      } catch {}
    }

    // Mantém o servidor vivo
    await new Promise<void>(() => {});
  }
}
