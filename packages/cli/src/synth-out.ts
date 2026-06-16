import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolução centralizada dos artefatos de `iacmp synth`.
 *
 * O `synth` grava em `synth-out/<provider>/` (um subdiretório por provider, para
 * evitar que providers diferentes sobrescrevam os arquivos uns dos outros). Todos
 * os comandos que consomem esses artefatos (`deploy`, `destroy`, `diff`,
 * `dashboard`) precisam ler do MESMO lugar — este módulo é a única fonte de
 * verdade desses caminhos.
 */

/** Extensão do arquivo de template gerado para cada provider. */
export function templateExt(provider: string): string {
  return provider === 'terraform' ? '.tf' : '.json';
}

/** Raiz dos outputs de synth (`synth-out/`). */
export function synthRoot(cwd: string): string {
  return path.join(cwd, 'synth-out');
}

/** Diretório canônico de output de um provider (`synth-out/<provider>/`). */
export function providerOutDir(cwd: string, provider: string): string {
  return path.join(synthRoot(cwd), provider);
}

function hasTemplates(dir: string, provider: string): boolean {
  const ext = templateExt(provider);
  try {
    return fs
      .readdirSync(dir)
      .some(f => f.endsWith(ext) && fs.statSync(path.join(dir, f)).isFile());
  } catch {
    return false;
  }
}

/**
 * Resolve o diretório de onde LER os templates de um provider.
 * Prioriza `synth-out/<provider>/`; cai para `synth-out/` plano (layout legado,
 * gerado por versões antigas do CLI) quando o subdiretório ainda não existe mas
 * há templates compatíveis na raiz. Retorna `null` quando não há nada para ler.
 */
export function resolveTemplateDir(cwd: string, provider: string): string | null {
  const dir = providerOutDir(cwd, provider);
  if (fs.existsSync(dir)) return dir;
  const root = synthRoot(cwd);
  if (fs.existsSync(root) && hasTemplates(root, provider)) return root; // legado/flat
  return null;
}

export interface TemplateRef {
  /** Nome da stack (nome do arquivo sem extensão). */
  stackName: string;
  /** Caminho absoluto do arquivo de template. */
  filePath: string;
  /** Nome do arquivo (com extensão). */
  fileName: string;
}

/**
 * Lista os templates sintetizados de um provider, com filtro opcional por stack.
 * Retorna `[]` quando não há nenhum.
 */
export function listTemplates(cwd: string, provider: string, stack?: string): TemplateRef[] {
  const dir = resolveTemplateDir(cwd, provider);
  if (!dir) return [];
  const ext = templateExt(provider);
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith(ext) && fs.statSync(path.join(dir, f)).isFile())
    .map(f => ({
      stackName: f.slice(0, -ext.length),
      filePath: path.join(dir, f),
      fileName: f,
    }))
    .filter(t => !stack || t.stackName === stack);
}

/** Caminho do template salvo de uma stack específica, ou `null` se não existir. */
export function savedTemplatePath(cwd: string, provider: string, stackName: string): string | null {
  const dir = resolveTemplateDir(cwd, provider);
  if (!dir) return null;
  const p = path.join(dir, `${stackName}${templateExt(provider)}`);
  return fs.existsSync(p) ? p : null;
}

/** Conta recursos em um template sintetizado, de forma agnóstica de provider. */
export function countResources(filePath: string, provider: string): number {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 0;
  }

  if (provider === 'terraform') {
    const matches = content.match(/^resource\s+"/gm);
    return matches ? matches.length : 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return 0;
  }

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.resources)) return obj.resources.length; // azure/gcp
    if (obj.Resources && typeof obj.Resources === 'object') {
      return Object.keys(obj.Resources as Record<string, unknown>).length; // aws
    }
  }
  return 0;
}
