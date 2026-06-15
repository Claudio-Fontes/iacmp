import * as fs from 'fs';
import * as path from 'path';
import { buildIndexes } from '../rag/indexer';
import { retrieve, formatRetrievedContext, RetrieverIndexes } from '../rag/retriever';
import { routeQuery } from '../rag/query-router';
import { SYSTEM_PROMPT_TEMPLATE } from '../prompts/system-prompt';

// Limite em tokens estimados (1 token ≈ 4 chars)
const RAG_THRESHOLD_CHARS = 8000 * 4;

// Cache dos índices em memória por projectDir — evita reindexar em cada mensagem
const indexCache = new Map<string, { indexes: RetrieverIndexes; builtAt: number }>();
const INDEX_TTL_MS = 60_000; // 1 minuto

async function getIndexes(projectDir: string): Promise<RetrieverIndexes> {
  const cached = indexCache.get(projectDir);
  if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) {
    return cached.indexes;
  }

  const indexes = await buildIndexes({
    projectDir,
    systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
  });

  indexCache.set(projectDir, { indexes, builtAt: Date.now() });
  return indexes;
}

function buildFullContext(projectDir: string): string {
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
        const sizeKb = (stat.size / 1024).toFixed(1);
        lines.push(`- ${rel} (${sizeKb} KB)`);

        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.split('\n').length <= 200) {
          lines.push('```typescript');
          lines.push(content);
          lines.push('```');
        }
      }
      lines.push('');
    } else {
      lines.push('## Stacks existentes');
      lines.push('Nenhuma stack encontrada em stacks/.');
      lines.push('');
    }
  } else {
    lines.push('Diretório stacks/ não encontrado.');
    lines.push('');
  }

  return lines.join('\n');
}

// Lê contexto do projeto.
// Se query for fornecida e o contexto completo exceder o limite, usa RAG.
export function readProjectContext(projectDir: string, query?: string): string {
  const fullContext = buildFullContext(projectDir);

  // Abaixo do limite: comportamento original — injeta tudo
  if (fullContext.length <= RAG_THRESHOLD_CHARS || !query) {
    return fullContext;
  }

  // Acima do limite com query: retorna marcador para RAG assíncrono
  // O contexto completo é retornado por ora — readProjectContextAsync é a via RAG
  return fullContext;
}

// Versão assíncrona que usa RAG quando o contexto excede o limite
export async function readProjectContextAsync(
  projectDir: string,
  query?: string,
): Promise<string> {
  const fullContext = buildFullContext(projectDir);

  if (fullContext.length <= RAG_THRESHOLD_CHARS || !query) {
    return fullContext;
  }

  // Contexto grande + query disponível: usa RAG
  try {
    const indexes = await getIndexes(projectDir);
    const routing = routeQuery(query);

    const results = retrieve(indexes, query, {
      projectK: routing.useProjectStacks ? 6 : 0,
      docsK: routing.useIacmpDocs ? 4 : 0,
      knowledgeK: routing.usePlatformKnowledge ? 5 : 0,
    });

    const ragContext = formatRetrievedContext(results);

    // Contexto mínimo: apenas config + lista de stacks (sem conteúdo)
    const minimalLines: string[] = [];
    const configPath = path.join(projectDir, 'iacmp.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        minimalLines.push('## Configuração do projeto (iacmp.json)');
        minimalLines.push(`- Provider: ${config['provider'] ?? 'aws'}`);
        minimalLines.push(`- Região: ${config['region'] ?? 'us-east-1'}`);
        minimalLines.push(`- Nome: ${config['name'] ?? path.basename(projectDir)}`);
        minimalLines.push('');
      } catch {}
    }

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
        minimalLines.push('## Stacks existentes (lista)');
        for (const f of stackFiles) {
          minimalLines.push(`- ${path.relative(projectDir, f)}`);
        }
        minimalLines.push('');
      }
    }

    const minimal = minimalLines.join('\n');
    return ragContext ? `${minimal}\n${ragContext}` : fullContext;
  } catch {
    // Se o RAG falhar por qualquer motivo, cai no comportamento original
    return fullContext;
  }
}
