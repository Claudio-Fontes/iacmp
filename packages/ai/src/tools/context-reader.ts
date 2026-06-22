import * as fs from 'fs';
import * as path from 'path';
import { buildIndexes, IndexerOptions } from '../rag/indexer';
import { retrieve, formatRetrievedContext, RetrieverIndexes } from '../rag/retriever';
import { SYSTEM_PROMPT_TEMPLATE } from '../prompts/system-prompt';
import { fetchLive, shouldFetchLive } from '../rag/live-retriever';

// Cache de índices em memória por projectDir (evita reindexar em cada mensagem)
const indexCache = new Map<string, RetrieverIndexes>();

const TREE_EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'synth-out', '.iacmp', 'coverage', '.next', '.turbo', 'build', '.cache']);
const TREE_MAX_DEPTH = 4;
const TREE_MAX_ENTRIES = 200;

// Lista nomes de pastas/arquivos do projeto (sem conteúdo) — dá ao modelo
// visão da estrutura geral além de stacks/, sem custar tokens com conteúdo.
function buildDirectoryTree(projectDir: string): string {
  const lines: string[] = [];
  let count = 0;

  const walk = (dir: string, depth: number, prefix: string): void => {
    if (depth > TREE_MAX_DEPTH || count >= TREE_MAX_ENTRIES) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const sorted = entries
      .filter(e => !e.name.startsWith('.') && !TREE_EXCLUDED_DIRS.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of sorted) {
      if (count >= TREE_MAX_ENTRIES) {
        lines.push(`${prefix}... (mais itens omitidos)`);
        return;
      }
      count++;
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        walk(path.join(dir, entry.name), depth + 1, prefix + '  ');
      } else {
        lines.push(`${prefix}${entry.name}`);
      }
    }
  };

  walk(projectDir, 0, '');
  return lines.join('\n');
}

function readProjectStructure(projectDir: string): string {
  const tree = buildDirectoryTree(projectDir);
  if (!tree) return '';
  return `## Estrutura de pastas do projeto\n\`\`\`\n${tree}\n\`\`\`\n`;
}

// Lê metadados básicos do projeto (config + lista de stacks) — sem conteúdo completo
export function readProjectMeta(projectDir: string): string {
  const lines: string[] = [];

  const configPath = path.join(projectDir, 'iacmp.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      lines.push('## Configuração do projeto (iacmp.json)');
      lines.push(`- Provider: ${config['provider'] ?? 'aws'}`);
      lines.push(`- Região: ${config['region'] ?? 'us-east-1'}`);
      lines.push(`- Linguagem: ${config['language'] ?? 'typescript'}`);
      lines.push(`- Nome: ${config['name'] ?? path.basename(projectDir)}`);
      lines.push('');
    } catch {
      lines.push('iacmp.json encontrado mas inválido.');
      lines.push('');
    }
  } else {
    lines.push('Nenhum iacmp.json encontrado — projeto não inicializado.');
    lines.push('');
  }

  lines.push(readProjectStructure(projectDir));

  const stacksDir = path.join(projectDir, 'stacks');
  if (fs.existsSync(stacksDir)) {
    const findStackFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) files.push(...findStackFiles(full));
        else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) files.push(full);
      }
      return files;
    };

    const stackFiles = findStackFiles(stacksDir);
    if (stackFiles.length > 0) {
      lines.push('## Stacks existentes');
      lines.push('IMPORTANTE: Estas são as stacks reais do projeto. Ao modificar ou mover recursos, use exatamente estes caminhos — não crie arquivos novos se o destino já existe.');
      for (const filePath of stackFiles) {
        const rel = path.relative(projectDir, filePath);
        lines.push(`\n### ${rel}`);
        lines.push('```typescript');
        lines.push(fs.readFileSync(filePath, 'utf-8').trimEnd());
        lines.push('```');
      }
      lines.push('');
    } else {
      lines.push('## Stacks existentes\nNenhuma stack encontrada em stacks/.');
      lines.push('');
    }
  } else {
    lines.push('Diretório stacks/ não encontrado.');
    lines.push('');
  }

  return lines.join('\n');
}

// Comportamento legado: injeta tudo (fallback quando RAG não está disponível)
export function readProjectContext(projectDir: string): string {
  const lines: string[] = [];

  const configPath = path.join(projectDir, 'iacmp.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      lines.push('## Configuração do projeto (iacmp.json)');
      lines.push(`- Provider: ${config['provider'] ?? 'aws'}`);
      lines.push(`- Região: ${config['region'] ?? 'us-east-1'}`);
      lines.push(`- Linguagem: ${config['language'] ?? 'typescript'}`);
      lines.push(`- Nome: ${config['name'] ?? path.basename(projectDir)}`);
      lines.push('');
    } catch {
      lines.push('iacmp.json encontrado mas inválido.');
      lines.push('');
    }
  } else {
    lines.push('Nenhum iacmp.json encontrado — projeto não inicializado.');
    lines.push('');
  }

  lines.push(readProjectStructure(projectDir));

  const stacksDir = path.join(projectDir, 'stacks');
  if (fs.existsSync(stacksDir)) {
    const findStackFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) files.push(...findStackFiles(full));
        else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) files.push(full);
      }
      return files;
    };

    const stackFiles = findStackFiles(stacksDir);
    if (stackFiles.length > 0) {
      lines.push('## Stacks existentes');
      lines.push('Caminhos completos (use exatamente estes em "deletions"):');
      for (const filePath of stackFiles) {
        const rel = path.relative(projectDir, filePath);
        const stat = fs.statSync(filePath);
        lines.push(`- ${rel} (${(stat.size / 1024).toFixed(1)} KB)`);
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.split('\n').length <= 200) {
          lines.push('```typescript');
          lines.push(content);
          lines.push('```');
        }
      }
      lines.push('');
    } else {
      lines.push('## Stacks existentes\nNenhuma stack encontrada em stacks/.');
      lines.push('');
    }
  } else {
    lines.push('Diretório stacks/ não encontrado.');
    lines.push('');
  }

  return lines.join('\n');
}

// Versão RAG: recupera contexto relevante para a query do usuário
export async function readProjectContextRAG(
  projectDir: string,
  userQuery: string,
  options: {
    anthropicApiKey?: string;
    useContextualRetrieval?: boolean;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<string> {
  const { anthropicApiKey, useContextualRetrieval, onProgress } = options;

  try {
    const indexerOptions: IndexerOptions = {
      projectDir,
      systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
      anthropicApiKey,
      useContextualRetrieval,
      onProgress: onProgress ?? (() => {}),
    };

    // O indexer usa hash para detectar mudanças e só reconstrói se necessário
    const indexes = await buildIndexes(indexerOptions);
    indexCache.set(projectDir, indexes);

    const results = retrieve(indexes, userQuery, {
      projectK: 5,
      docsK: 3,
      knowledgeK: 5,
      sourceK: 5,
      minScore: 0.05,
    });

    const ragContext = formatRetrievedContext(results);
    const meta = readProjectMeta(projectDir);

    // Live retriever: consulta fontes externas quando a query pede info recente/preço/terraform
    let liveContext = '';
    if (shouldFetchLive(userQuery)) {
      liveContext = await fetchLive(userQuery, [], { projectDir });
    }

    // Sem hits relevantes: fallback para comportamento legado
    if (!ragContext && !liveContext) {
      return readProjectContext(projectDir);
    }

    const parts = [meta];
    if (ragContext) parts.push(ragContext);
    if (liveContext) parts.push(`## Informações ao vivo\n${liveContext}`);
    return parts.join('\n');
  } catch {
    // Fallback silencioso para comportamento legado
    return readProjectContext(projectDir);
  }
}

// Limpa o cache de índices em memória
export function invalidateIndexCache(projectDir?: string): void {
  if (projectDir) {
    indexCache.delete(projectDir);
  } else {
    indexCache.clear();
  }
}
