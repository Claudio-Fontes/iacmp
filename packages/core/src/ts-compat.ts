import * as fs from 'fs';
import * as path from 'path';

/**
 * Compatibilidade com a versão do TypeScript do projeto do usuário.
 *
 * O iacmp valida os arquivos .ts do usuário via tsc (synth, audit, geração).
 * TS5/6: moduleResolution 'node' com ignoreDeprecations.
 * TS7+: 'node'/'node10' foram removidos — usa 'bundler' + types:['node'].
 * Detecta a versão instalada e adapta — funciona com qualquer TS >= 5.
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
  const major = detectTypeScriptMajor(projectDir);
  const opts: Record<string, unknown> = {
    target: 'ES2022',
    module: 'commonjs',
    esModuleInterop: true,
    strict: false,
    skipLibCheck: true,
  };
  if (major !== null && major >= 7) {
    // TS7 removeu moduleResolution 'node'/'node10' — usa 'bundler' que é válido
    // para CommonJS + module bundlers e não requer ignoreDeprecations.
    opts.moduleResolution = 'bundler';
    opts.types = ['node'];
  } else {
    opts.moduleResolution = 'node';
    // ignoreDeprecations existe a partir do TS 5.0; valor deve casar com a major.
    if (major !== null && major >= 5) {
      opts.ignoreDeprecations = `${major}.0`;
    }
  }
  return { ...opts, ...extra };
}
