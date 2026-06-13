import { Command } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';

export default class Ls extends Command {
  static description = 'Lista as stacks disponíveis no projeto';

  static examples = ['$ iacmp ls'];

  async run(): Promise<void> {
    const cwd = process.cwd();
    const stacksDir = path.join(cwd, 'stacks');

    if (!fs.existsSync(stacksDir)) {
      this.log('Diretório stacks/ não encontrado. Rode: iacmp init');
      return;
    }

    const files = fs.readdirSync(stacksDir).filter(f => f.endsWith('.ts'));

    if (files.length === 0) {
      this.log('Nenhuma stack encontrada em stacks/');
      return;
    }

    this.log('Stacks disponíveis:\n');
    for (const file of files) {
      const filePath = path.join(stacksDir, file);
      const stat = fs.statSync(filePath);
      const modified = stat.mtime.toLocaleString('pt-BR');
      const name = file.replace(/\.ts$/, '');
      this.log(`  ${name.padEnd(30)} modificado: ${modified}`);
    }
  }
}
