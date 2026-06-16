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

    // Descoberta idêntica ao synth/deploy (ver src/commands/synth.ts): recursa
    // em subpastas de stacks/ e reconhece tanto .ts quanto .js.
    const findStackFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...findStackFiles(full));
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
          files.push(full);
        }
      }
      return files;
    };

    const files = findStackFiles(stacksDir);

    if (files.length === 0) {
      this.log('Nenhuma stack encontrada em stacks/');
      return;
    }

    this.log('Stacks disponíveis:\n');
    for (const filePath of files) {
      const stat = fs.statSync(filePath);
      const modified = stat.mtime.toLocaleString('pt-BR');
      // nome relativo a stacks/ sem extensão (ex.: network/vpc), evitando
      // ambiguidade entre stacks de mesmo basename em subpastas distintas.
      const name = path.relative(stacksDir, filePath).replace(/\.(ts|js)$/, '');
      this.log(`  ${name.padEnd(30)} modificado: ${modified}`);
    }
  }
}
