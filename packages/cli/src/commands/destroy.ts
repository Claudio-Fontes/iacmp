import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

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

    const outDir = path.join(cwd, 'synth-out');
    if (!fs.existsSync(outDir)) {
      this.error('Nenhum output encontrado. Rode: iacmp synth');
    }

    const templates = fs.readdirSync(outDir)
      .filter(f => f.endsWith('.json'))
      .filter(f => !flags.stack || f.replace('.json', '') === flags.stack);

    if (templates.length === 0) {
      this.error('Nenhuma stack encontrada para destruir.');
    }

    let totalResources = 0;
    const stackNames: string[] = [];
    for (const file of templates) {
      const templatePath = path.join(outDir, file);
      const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
      const resourceCount = Object.keys(template.Resources ?? {}).length;
      totalResources += resourceCount;
      stackNames.push(file.replace('.json', ''));
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
