import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function parseEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key) process.env[key] = val;
  }
}

/**
 * Carrega configurações de ambiente em ordem de prioridade crescente:
 * 1. ~/.iacmp/config — API keys e preferências globais do usuário
 * 2. .env do projeto   — overrides específicos do projeto
 *
 * Variáveis já definidas no shell antes da chamada são sobrescritas
 * (comportamento idêntico ao anterior, mantido para compatibilidade).
 */
export function loadEnv(cwd: string = process.cwd()): void {
  parseEnvFile(path.join(os.homedir(), '.iacmp', 'config'));
  parseEnvFile(path.join(cwd, '.env'));
}
