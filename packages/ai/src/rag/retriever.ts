import { Chunk } from './chunker';
import { BM25Index, bm25Search } from './bm25';

export interface RetrievalResult {
  chunk: Chunk;
  score: number;
  source: string;
}

export interface RetrieverIndexes {
  projectIndex: BM25Index;
  docsIndex: BM25Index;
  knowledgeIndex: BM25Index;
  // Mapa de id → chunk para lookup rápido
  chunkMap: Map<string, Chunk>;
}

// Quantos chunks buscar por corpus por padrão
const DEFAULT_K = {
  project: 5,
  docs: 3,
  knowledge: 5,
};

export function retrieve(
  indexes: RetrieverIndexes,
  query: string,
  options: {
    projectK?: number;
    docsK?: number;
    knowledgeK?: number;
    minScore?: number;
  } = {},
): RetrievalResult[] {
  const {
    projectK = DEFAULT_K.project,
    docsK = DEFAULT_K.docs,
    knowledgeK = DEFAULT_K.knowledge,
    minScore = 0.1,
  } = options;

  const results: RetrievalResult[] = [];

  // Busca nos três corpora
  const projectHits = bm25Search(indexes.projectIndex, query, projectK);
  const docsHits = bm25Search(indexes.docsIndex, query, docsK);
  const knowledgeHits = bm25Search(indexes.knowledgeIndex, query, knowledgeK);

  for (const hit of [...projectHits, ...docsHits, ...knowledgeHits]) {
    if (hit.score < minScore) continue;
    const chunk = indexes.chunkMap.get(hit.id);
    if (!chunk) continue;

    results.push({
      chunk,
      score: hit.score,
      source: chunk.metadata.source,
    });
  }

  // Ordena por score descendente
  return results.sort((a, b) => b.score - a.score);
}

// Formata os chunks recuperados para injeção no prompt
export function formatRetrievedContext(results: RetrievalResult[]): string {
  if (results.length === 0) return '';

  const sections: string[] = ['## Contexto recuperado pelo RAG\n'];

  const bySource = {
    'project-stack': results.filter(r => r.chunk.metadata.source === 'project-stack'),
    'iacmp-docs': results.filter(r => r.chunk.metadata.source === 'iacmp-docs'),
    'platform-knowledge': results.filter(r => r.chunk.metadata.source === 'platform-knowledge'),
  };

  if (bySource['project-stack'].length > 0) {
    sections.push('### Stacks do projeto relevantes');
    for (const r of bySource['project-stack']) {
      sections.push(r.chunk.content);
      sections.push('');
    }
  }

  if (bySource['iacmp-docs'].length > 0) {
    sections.push('### Documentação de constructs relevante');
    for (const r of bySource['iacmp-docs']) {
      sections.push(r.chunk.content);
      sections.push('');
    }
  }

  if (bySource['platform-knowledge'].length > 0) {
    sections.push('### Conhecimento de plataforma relevante');
    for (const r of bySource['platform-knowledge']) {
      sections.push(r.chunk.content);
      sections.push('');
    }
  }

  return sections.join('\n');
}
