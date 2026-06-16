import * as path from 'path';

export const NATIVE_PROVIDERS = ['aws', 'azure', 'gcp', 'terraform'] as const;

const STACK_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROVIDER_PATTERN = /^[a-z0-9_-]+$/;

export function safeJoin(baseDir: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Caminho vazio ou inválido recebido.');
  }

  if (path.isAbsolute(relativePath)) {
    throw new Error(
      `Caminho absoluto rejeitado por segurança: "${relativePath}". ` +
      `Use sempre caminhos relativos ao projeto.`
    );
  }

  const baseResolved = path.resolve(baseDir);
  const fullResolved = path.resolve(baseResolved, relativePath);

  if (fullResolved !== baseResolved && !fullResolved.startsWith(baseResolved + path.sep)) {
    throw new Error(
      `Caminho fora do diretório do projeto rejeitado: "${relativePath}" ` +
      `(resolveria para "${fullResolved}"). Path traversal não é permitido.`
    );
  }

  return fullResolved;
}

export function isWithin(baseDir: string, candidatePath: string): boolean {
  try {
    const baseResolved = path.resolve(baseDir);
    const fullResolved = path.isAbsolute(candidatePath)
      ? path.resolve(candidatePath)
      : path.resolve(baseResolved, candidatePath);
    return fullResolved === baseResolved || fullResolved.startsWith(baseResolved + path.sep);
  } catch {
    return false;
  }
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  if (typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  try {
    const s = JSON.stringify(err);
    return typeof s === 'string' ? s : String(err);
  } catch {
    return String(err);
  }
}

export function assertValidStackName(stackName: string): void {
  if (typeof stackName !== 'string' || !STACK_NAME_PATTERN.test(stackName)) {
    throw new Error(
      `Nome de stack inválido: "${stackName}". ` +
      `Use apenas letras, números, hífen e underscore (regex: /^[A-Za-z0-9_-]+$/).`
    );
  }
}

export function assertValidProvider(provider: string, allowlist?: readonly string[]): void {
  if (typeof provider !== 'string' || !PROVIDER_PATTERN.test(provider)) {
    throw new Error(
      `Nome de provider inválido: "${provider}". ` +
      `Use apenas letras minúsculas, números, hífen e underscore.`
    );
  }

  const allowed = allowlist ?? NATIVE_PROVIDERS;
  if (!allowed.includes(provider)) {
    throw new Error(
      `Provider "${provider}" não permitido. Allowlist: ${allowed.join(', ')}.`
    );
  }
}
