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

// Arquivos prefixados com "_" são gerados pelo deploy (ex: `_provider.tf` do
// Terraform) e não representam uma stack — nunca contam como template.
function isStackFile(name: string, ext: string): boolean {
  return name.endsWith(ext) && !name.startsWith('_');
}

function hasTemplates(dir: string, provider: string): boolean {
  const ext = templateExt(provider);
  try {
    return fs
      .readdirSync(dir)
      .some(f => isStackFile(f, ext) && fs.statSync(path.join(dir, f)).isFile());
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
    .filter(f => isStackFile(f, ext) && fs.statSync(path.join(dir, f)).isFile())
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

function collectImportValues(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectImportValues(item, found);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'Fn::ImportValue' && typeof value === 'string') {
        found.add(value);
      } else {
        collectImportValues(value, found);
      }
    }
  }
}

/**
 * Ordena templates AWS pra que a stack que EXPORTA (`Outputs.*.Export.Name`)
 * sempre seja deployada/destruída antes/depois da que IMPORTA (`Fn::ImportValue`)
 * — necessário porque `Fn::ApiGateway` em uma stack pode referenciar
 * `Fn::Lambda` de outra (ver `cloudformation.ts`). Sem isso, `aws cloudformation
 * deploy` falharia com "export not found" se a stack importadora subir primeiro.
 * Provider-agnóstico na forma (só AWS usa Outputs/ImportValue hoje — para os
 * demais, a ordem de entrada é preservada).
 */
export function orderByDependency(templates: TemplateRef[]): TemplateRef[] {
  const exportsByPath = new Map<string, Set<string>>();
  const importsByPath = new Map<string, Set<string>>();

  for (const t of templates) {
    const exportNames = new Set<string>();
    const importNames = new Set<string>();
    try {
      const json = JSON.parse(fs.readFileSync(t.filePath, 'utf-8')) as {
        Outputs?: Record<string, { Export?: { Name?: string } }>;
        Resources?: unknown;
      };
      for (const output of Object.values(json.Outputs ?? {})) {
        if (output?.Export?.Name) exportNames.add(output.Export.Name);
      }
      collectImportValues(json.Resources, importNames);
    } catch {
      // não-JSON (ex: terraform .tf) ou template inválido — sem dependências conhecidas
    }
    exportsByPath.set(t.filePath, exportNames);
    importsByPath.set(t.filePath, importNames);
  }

  // Kahn's algorithm: aresta exportador → importador (exportador deploya primeiro).
  const indegree = new Map<string, number>(templates.map(t => [t.filePath, 0]));
  const edges = new Map<string, string[]>(templates.map(t => [t.filePath, []]));

  for (const importer of templates) {
    const needed = importsByPath.get(importer.filePath)!;
    if (needed.size === 0) continue;
    for (const exporter of templates) {
      if (exporter.filePath === importer.filePath) continue;
      const provided = exportsByPath.get(exporter.filePath)!;
      if ([...needed].some(name => provided.has(name))) {
        edges.get(exporter.filePath)!.push(importer.filePath);
        indegree.set(importer.filePath, (indegree.get(importer.filePath) ?? 0) + 1);
      }
    }
  }

  const byPath = new Map(templates.map(t => [t.filePath, t]));
  const queue = templates.filter(t => indegree.get(t.filePath) === 0);
  const ordered: TemplateRef[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    ordered.push(current);
    for (const nextPath of edges.get(current.filePath) ?? []) {
      indegree.set(nextPath, indegree.get(nextPath)! - 1);
      if (indegree.get(nextPath) === 0) queue.push(byPath.get(nextPath)!);
    }
  }
  // Ciclo (não deveria acontecer na prática) — inclui o resto na ordem original
  // em vez de descartar templates silenciosamente.
  if (ordered.length < templates.length) {
    const seen = new Set(ordered.map(t => t.filePath));
    for (const t of templates) if (!seen.has(t.filePath)) ordered.push(t);
  }
  return ordered;
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
