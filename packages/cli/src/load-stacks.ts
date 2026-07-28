import * as fs from 'fs';
import * as path from 'path';

/**
 * Varredura recursiva de stacks/ — retorna caminhos absolutos para arquivos
 * .ts/.js em qualquer nível. Usado por synth, diff, e quem mais consumir o mesmo
 * diretório, para garantir que subdiretórios não sejam ignorados silenciosamente.
 */
export function findStackFiles(dir: string): string[] {
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
}
