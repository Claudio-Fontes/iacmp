import * as fs from 'fs';

/**
 * Lê e parseia um arquivo JSON. Lança Error com mensagem amigável (inclui o
 * caminho + motivo do erro) quando o arquivo não existe, não é legível ou tem
 * JSON inválido. Quem chama deve repassar a Error.message via `this.error()`.
 */
export function readJsonFile<T = unknown>(filePath: string): T {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new Error(`Falha ao ler '${filePath}': ${errMessage(e)}`);
  }
  try {
    return JSON.parse(content) as T;
  } catch (e) {
    throw new Error(`JSON inválido em '${filePath}': ${errMessage(e)}`);
  }
}

/** Extrai uma mensagem amigável de qualquer valor capturado em catch. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
