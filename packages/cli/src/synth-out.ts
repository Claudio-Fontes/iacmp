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
  if (provider === 'terraform' || provider === 'gcp') return '.tf.json';
  if (provider === 'azure') return '.bicep';
  return '.json';
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
    if (t.filePath.endsWith('.bicep')) {
      // Azure: cross-stack = `param X <tipo>` SEM default (o deploy injeta com o
      // output homônimo de outra stack). `output X ...` é o lado exportador.
      // Mesma semântica do Export/ImportValue do CFN, dialeto Bicep.
      try {
        const content = fs.readFileSync(t.filePath, 'utf-8');
        for (const line of content.split('\n')) {
          // Apenas params SEM default são dependências hard — obrigam a stack
          // exportadora a ser deployada primeiro. Params com default (ex: = '')
          // são "soft": o deploy injeta no 2º passo sem criar ciclo de dependência.
          // Regex: param NAME TYPE  (sem nada depois do tipo = sem default)
          const param = line.match(/^param\s+(\w+)\s+\w+\s*$/);
          if (param) importNames.add(param[1]);
          const output = line.match(/^output\s+(\w+)\s/);
          if (output) exportNames.add(output[1]);
        }
      } catch { /* ilegível — sem dependências conhecidas */ }
    } else {
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

  // Kahn's terminou com nós sobrando → há ciclo de dependência cross-stack.
  // Nós presos têm indegree > 0 porque cada um importa algo exportado por outro
  // nó igualmente preso, formando um ciclo impossível de ordenar.
  // Falha ANTES de tentar qualquer deploy — a mensagem orienta o fix.
  if (ordered.length < templates.length) {
    const seen = new Set(ordered.map(t => t.filePath));
    const inCycle = templates.filter(t => !seen.has(t.filePath));

    // Identifica quais imports de cada stack presa apontam para outra stack presa.
    const cycleEdges: string[] = [];
    for (const importer of inCycle) {
      const needed = importsByPath.get(importer.filePath)!;
      for (const exporter of inCycle) {
        if (exporter.filePath === importer.filePath) continue;
        const provided = exportsByPath.get(exporter.filePath)!;
        const mutual = [...needed].filter(name => provided.has(name));
        if (mutual.length > 0) {
          cycleEdges.push(
            `  "${importer.stackName}" importa ${mutual.map(n => `"${n}"`).join(', ')} exportado por "${exporter.stackName}"`
          );
        }
      }
    }

    const stackNames = inCycle.map(t => `"${t.stackName}"`).join(' ↔ ');
    throw new Error(
      `Dependência circular entre stacks detectada: ${stackNames}\n` +
      (cycleEdges.length > 0 ? `\n${cycleEdges.join('\n')}\n` : '') +
      `\nFix: coloque os constructs com referência mútua na MESMA stack` +
      ` (ex: o bucket com eventNotifications + a Lambda-alvo juntos).`
    );
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

  if (provider === 'azure') {
    // Formato Bicep: conta declarações `resource <sym> '<type>' = { ... }`
    return (content.match(/^resource\s+/gm) ?? []).length;
  }

  if (provider === 'terraform' || provider === 'gcp') {
    // Formato .tf.json: { "resource": { "<type>": { "<name>": {...} } } }
    try {
      const tfJson = JSON.parse(content) as Record<string, unknown>;
      const resourceMap = tfJson['resource'];
      if (!resourceMap || typeof resourceMap !== 'object') return 0;
      return Object.values(resourceMap as Record<string, Record<string, unknown>>)
        .reduce((sum, instances) => sum + Object.keys(instances).length, 0);
    } catch {
      return 0;
    }
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
