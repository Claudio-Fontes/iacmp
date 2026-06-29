import * as fs from 'fs';
import * as path from 'path';

/**
 * Compatibilidade com a versão do TypeScript do projeto do usuário.
 *
 * O iacmp carrega/valida os arquivos .ts do usuário em três pontos (synth via
 * ts-node, audit via ts-node, validação de geração via tsc). Todos usam
 * `moduleResolution: 'node'` (node10), que emite uma deprecation a partir do
 * TS 5.x e vira ERRO FATAL de compilação se `ignoreDeprecations` não casar com
 * a major instalada (TS 5.x exige '5.0'; TS 6.x exige '6.0'). Em vez de fixar
 * uma versão de TypeScript, detectamos a que o projeto tem e adaptamos as
 * opções — o iacmp funciona com qualquer TS >= 5 sem forçar pin.
 */

/** Sobe a árvore de diretórios procurando node_modules/<moduleName>. */
function resolveModuleDir(projectDir: string, moduleName: string): string | null {
  let dir = projectDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'node_modules', moduleName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Major version do TypeScript instalado no projeto, ou null se não encontrado. */
export function detectTypeScriptMajor(projectDir: string): number | null {
  try {
    const tsDir = resolveModuleDir(projectDir, 'typescript');
    if (!tsDir) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(tsDir, 'package.json'), 'utf-8')) as { version?: string };
    if (!pkg.version) return null;
    const major = parseInt(pkg.version.split('.')[0], 10);
    return Number.isNaN(major) ? null : major;
  } catch {
    return null;
  }
}

/**
 * compilerOptions base para carregar/validar .ts do usuário, adaptados à versão
 * do TS instalada. `extra` sobrescreve/estende (ex: paths, baseUrl, noEmit do
 * validador). Único lugar que conhece o acoplamento iacmp ↔ versão do TS.
 */
export function tsCompilerOptions(projectDir: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    target: 'ES2022',
    module: 'commonjs',
    moduleResolution: 'node',
    esModuleInterop: true,
    strict: false,
    skipLibCheck: true,
  };
  const major = detectTypeScriptMajor(projectDir);
  // ignoreDeprecations existe a partir do TS 5.0 e o valor deve casar com a major.
  if (major !== null && major >= 5) {
    opts.ignoreDeprecations = `${major}.0`;
  }
  return { ...opts, ...extra };
}
