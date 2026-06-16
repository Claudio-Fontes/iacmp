import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { listTemplates, countResources } from '../synth-out';

export default class Destroy extends Command {
  static description = 'Destroi a infraestrutura do provider configurado';

  static flags = {
    provider: Flags.string({ char: 'p', description: 'Provider alvo', default: 'aws' }),
    stack: Flags.string({ char: 's', description: 'Nome da stack específica' }),
    force: Flags.boolean({ char: 'f', description: 'Pula confirmação' }),
  };

  static examples = [
    '$ iacmp destroy',
    '$ iacmp destroy --stack minha-stack',
    '$ iacmp destroy --force',
  ];

  private async confirm(message: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question(`${message} (y/N): `, answer => {
        rl.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Destroy);
    const cwd = process.cwd();
    const configPath = path.join(cwd, 'iacmp.json');

    if (!fs.existsSync(configPath)) {
      this.error('Projeto não inicializado. Rode: iacmp init');
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const provider = flags.provider ?? config.provider ?? 'aws';

    const templates = listTemplates(cwd, provider, flags.stack);

    if (templates.length === 0) {
      this.error(`Nenhuma stack encontrada para destruir. Rode: iacmp synth --provider ${provider}`);
    }

    let totalResources = 0;
    const stackNames: string[] = [];
    for (const t of templates) {
      totalResources += countResources(t.filePath, provider);
      stackNames.push(t.stackName);
    }

    this.log(`Stacks a destruir: ${stackNames.join(', ')}`);
    this.log(`Total de recursos: ${totalResources} em ${provider.toUpperCase()}`);
    this.log('');

    if (!flags.force) {
      const confirmed = await this.confirm('Tem certeza que deseja destruir esses recursos?');
      if (!confirmed) {
        this.log('Operação cancelada.');
        return;
      }
    }

    this.log(`Would destroy ${totalResources} resource(s) from ${provider.toUpperCase()}`);
    this.log('');
    this.log('(MVP: destroy real não implementado nesta fase)');
  }
}
