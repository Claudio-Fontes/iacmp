import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function parseEnvFile(filePath: string, opts?: { overwrite?: boolean }): void {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (opts?.overwrite || process.env[key] === undefined) process.env[key] = val;
  }
}

/**
 * Carrega configurações de ambiente em ordem de prioridade crescente:
 * 1. ~/.iacmp/config — defaults globais do usuário. NÃO sobrescreve variável
 *    já exportada no shell (convenção universal: env explícito vence arquivo
 *    de config — `OPENAI_API_KEY=x iacmp ai ...` tem que valer).
 * 2. .env do projeto — SOBRESCREVE shell e global (comportamento documentado
 *    do iacmp desde o chat.js original: o projeto tem prioridade).
 */
export function loadEnv(cwd: string = process.cwd()): void {
  parseEnvFile(path.join(os.homedir(), '.iacmp', 'config'), { overwrite: false });
  parseEnvFile(path.join(cwd, '.env'), { overwrite: true });
}
