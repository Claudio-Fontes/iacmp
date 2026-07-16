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

  // Imports "soft" (params Azure COM default) — carregam dado obrigatório
  // (ConnectionString/Name/SecretValue) que o deploy injeta com o output
  // homônimo; NÃO há 2º passo para env var de Function App, então a ORDEM
  // importa (senão a env fica vazia). Viram aresta de ordenação, mas se
  // criarem ciclo são descartadas (fallback), diferente dos hard (que falham).
  const softImportsByPath = new Map<string, Set<string>>();

  for (const t of templates) {
    const exportNames = new Set<string>();
    const importNames = new Set<string>();
    const softImportNames = new Set<string>();
    if (t.filePath.endsWith('.bicep')) {
      // Azure: cross-stack = `param X <tipo>` (o deploy injeta com o output
      // homônimo de outra stack). `output X ...` é o lado exportador.
      try {
        const content = fs.readFileSync(t.filePath, 'utf-8');
        for (const line of content.split('\n')) {
          // param SEM default = dependência HARD (falha o deploy se faltar).
          const hardParam = line.match(/^param\s+(\w+)\s+\w+\s*$/);
          if (hardParam) importNames.add(hardParam[1]);
          // param COM default (ex: = '') = dependência SOFT de ORDEM.
          else {
            const softParam = line.match(/^param\s+(\w+)\s+\w+\s*=/);
            if (softParam) softImportNames.add(softParam[1]);
          }
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
    softImportsByPath.set(t.filePath, softImportNames);
  }

  // 1ª tentativa: ordena com hard + soft edges (a ordem correta inclui a soft).
  const withSoft = topoSort(templates, exportsByPath, importsByPath, softImportsByPath);
  if (withSoft) return withSoft;
  // Ciclo por causa de soft edges → descarta as soft e ordena só com as hard
  // (comportamento antigo: soft vira "melhor esforço", não bloqueia).
  const hardOnly = topoSort(templates, exportsByPath, importsByPath, new Map());
  if (hardOnly) return hardOnly;
  // Ciclo mesmo só com hard → erro real (mensagem abaixo).
  return orderByDependencyStrict(templates, exportsByPath, importsByPath);
}

// Kahn's sobre hard+soft edges. Retorna a ordem, ou null se houver ciclo.
function topoSort(
  templates: TemplateRef[],
  exportsByPath: Map<string, Set<string>>,
  importsByPath: Map<string, Set<string>>,
  softImportsByPath: Map<string, Set<string>>,
): TemplateRef[] | null {
  const indegree = new Map<string, number>(templates.map(t => [t.filePath, 0]));
  const edges = new Map<string, string[]>(templates.map(t => [t.filePath, []]));
  for (const importer of templates) {
    const needed = new Set<string>([
      ...(importsByPath.get(importer.filePath) ?? []),
      ...(softImportsByPath.get(importer.filePath) ?? []),
    ]);
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
  return ordered.length === templates.length ? ordered : null;
}

// Versão estrita (só hard) que LANÇA em ciclo — preserva a mensagem de erro rica.
function orderByDependencyStrict(
  templates: TemplateRef[],
  exportsByPath: Map<string, Set<string>>,
  importsByPath: Map<string, Set<string>>,
): TemplateRef[] {
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

// ── Azure: deployment único com módulos (_main.bicep) ───────────────────────
// Cada stack vira um `module` de um main.bicep gerado; as referências
// cross-stack viram simbólicas (`mod.outputs.X`) e o PRÓPRIO ARM resolve a
// ordem (e paraleliza módulos independentes). Isso elimina o acumulador de
// outputs, a injeção manual de params e a classe de bug "env vazia por ordem
// errada" (589e4b4) — no Azure, multi-deployment por stack era um AWS-ismo.
// O arquivo começa com "_" de propósito: não é uma stack (isStackFile o exclui).

export const AZURE_MAIN_FILE = '_main.bicep';
/** Nome LÓGICO da deployment stack única (físico = `<projeto>-main`). */
export const AZURE_MAIN_STACK = 'main';

/** Caminho do _main.bicep de um projeto, ou null se não existe (layout legado). */
export function azureMainPath(cwd: string): string | null {
  const dir = resolveTemplateDir(cwd, 'azure');
  if (!dir) return null;
  const p = path.join(dir, AZURE_MAIN_FILE);
  return fs.existsSync(p) ? p : null;
}

// sharedCaeId nunca vira param do main (2º passo): injetar o próprio CAE na
// stack que o criou faria `empty(sharedCaeId)` virar false → o CAE sairia do
// template → ARM tentaria deletá-lo com Container Apps attachados
// (DeploymentStackDeleteResourcesFailed). A ordem dos módulos já resolve: o
// primeiro cria o CAE, os seguintes recebem via referência simbólica.
const AZURE_MAIN_NEVER_LIFT = new Set(['sharedCaeId']);

interface ParsedBicepModule {
  ref: TemplateRef;
  sym: string;
  /** Params sem default — dependência obrigatória (senha ou output de outra stack). */
  hardParams: string[];
  /** Params com default; os `string = ''` são candidatos a 2º passo (lift). */
  softParams: { name: string; isEmptyStringDefault: boolean }[];
  outputs: { name: string; type: string }[];
}

function parseBicepModule(t: TemplateRef): ParsedBicepModule {
  const content = fs.readFileSync(t.filePath, 'utf-8');
  const hardParams: string[] = [];
  const softParams: { name: string; isEmptyStringDefault: boolean }[] = [];
  const outputs: { name: string; type: string }[] = [];
  for (const line of content.split('\n')) {
    const hard = line.match(/^param\s+(\w+)\s+\w+\s*$/);
    if (hard) { hardParams.push(hard[1]); continue; }
    const soft = line.match(/^param\s+(\w+)\s+(\w+)\s*=\s*(.*)$/);
    if (soft) {
      softParams.push({ name: soft[1], isEmptyStringDefault: soft[2] === 'string' && soft[3].trim() === "''" });
      continue;
    }
    const out = line.match(/^output\s+(\w+)\s+(\w+)\s*=/);
    if (out) outputs.push({ name: out[1], type: out[2] });
  }
  return { ref: t, sym: `stk_${t.stackName.replace(/[^a-zA-Z0-9]/g, '_')}`, hardParams, softParams, outputs };
}

/**
 * Gera o conteúdo do _main.bicep a partir das stacks ORDENADAS (orderByDependency).
 * Regras de amarração (espelham a semântica do deploy multi-stack legado):
 *  - param `*password` → param @secure `adminPassword` do main (uma senha por deploy);
 *  - param hard → output homônimo do último módulo ANTERIOR que o exporta
 *    (erro de synth se nenhum exporta — antes isso só falhava no deploy);
 *  - param soft com exportador anterior → referência simbólica direta;
 *  - param soft `= ''` cujo exportador vem DEPOIS (ciclo real, ex: Event Grid
 *    precisa do FQDN da function) → vira param do main com default '' e o
 *    deploy faz o 2º passo injetando o output;
 *  - outputs de todos os módulos são re-exportados (zip deploy e 2º passo leem
 *    os outputs da stack única) — nome duplicado: o último módulo vence.
 */
export function generateAzureMainBicep(ordered: TemplateRef[]): string {
  const mods = ordered.map(parseBicepModule);
  const exportedAnywhere = new Set<string>();
  for (const m of mods) for (const o of m.outputs) exportedAnywhere.add(o.name.toLowerCase());

  // outputs disponíveis "até aqui" (lowercase → último exportador anterior)
  const exported = new Map<string, { sym: string; name: string; type: string }>();
  const lifted: string[] = [];
  let needsAdminPassword = false;
  const moduleBlocks: string[] = [];

  for (const m of mods) {
    const wired: string[] = [];
    for (const p of m.hardParams) {
      if (/password$/i.test(p)) {
        needsAdminPassword = true;
        wired.push(`    ${p}: adminPassword`);
        continue;
      }
      const src = exported.get(p.toLowerCase());
      if (!src) {
        throw new Error(
          `_main.bicep: a stack "${m.ref.stackName}" precisa do parâmetro obrigatório "${p}", ` +
          `mas nenhuma stack anterior exporta um output com esse nome.\n` +
          `Fix: garanta que a stack dona do recurso declara \`output ${p}\` — ou coloque os ` +
          `constructs interdependentes na mesma stack.`,
        );
      }
      wired.push(`    ${p}: ${src.sym}.outputs.${src.name}`);
    }
    for (const sp of m.softParams) {
      const src = exported.get(sp.name.toLowerCase());
      if (src) {
        wired.push(`    ${sp.name}: ${src.sym}.outputs.${src.name}`);
        continue;
      }
      if (sp.isEmptyStringDefault && !AZURE_MAIN_NEVER_LIFT.has(sp.name) && exportedAnywhere.has(sp.name.toLowerCase())) {
        if (!lifted.includes(sp.name)) lifted.push(sp.name);
        wired.push(`    ${sp.name}: ${sp.name}`);
      }
      // sem exportador em lugar nenhum: o default do módulo vale (ex: location)
    }
    moduleBlocks.push([
      `module ${m.sym} '${m.ref.fileName}' = {`,
      `  name: '${m.ref.stackName}'`,
      ...(wired.length > 0 ? ['  params: {', ...wired, '  }'] : []),
      '}',
    ].join('\n'));
    for (const o of m.outputs) exported.set(o.name.toLowerCase(), { sym: m.sym, name: o.name, type: o.type });
  }

  const header = [
    '// Gerado por iacmp synth — NÃO editar.',
    '// Deployment único: cada stack é um módulo; as referências simbólicas',
    '// (mod.outputs.X) fazem o ARM ordenar e paralelizar o deploy sozinho.',
  ];
  const params: string[] = [];
  if (needsAdminPassword) params.push('@secure()\nparam adminPassword string');
  for (const name of lifted) {
    params.push(`// 2º passo: o deploy injeta quando o output homônimo ficar disponível.\nparam ${name} string = ''`);
  }
  const outputLines = [...exported.values()].map(
    o => `output ${o.name} ${o.type} = ${o.sym}.outputs.${o.name}`,
  );

  return [
    header.join('\n'),
    ...params,
    ...moduleBlocks,
    ...(outputLines.length > 0 ? [outputLines.join('\n')] : []),
  ].join('\n\n') + '\n';
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
