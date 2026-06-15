import { retrieve, formatRetrievedContext, RetrieverIndexes } from '../src/rag/retriever';
import { buildBM25Index } from '../src/rag/bm25';
import { Chunk } from '../src/rag/chunker';

function chunk(id: string, content: string, source: Chunk['metadata']['source']): Chunk {
  return { id, content, metadata: { source } };
}

function buildIndexes(
  projectChunks: Chunk[],
  docsChunks: Chunk[],
  knowledgeChunks: Chunk[],
): RetrieverIndexes {
  const all = [...projectChunks, ...docsChunks, ...knowledgeChunks];
  const chunkMap = new Map(all.map(c => [c.id, c]));
  return {
    projectIndex: buildBM25Index(projectChunks),
    docsIndex: buildBM25Index(docsChunks),
    knowledgeIndex: buildBM25Index(knowledgeChunks),
    chunkMap,
  };
}

describe('retrieve', () => {
  const projectChunks = [
    chunk('p1', 'lambda function handler nodejs runtime aws', 'project-stack'),
    chunk('p2', 'rds database mysql production multi-az', 'project-stack'),
  ];
  const docsChunks = [
    chunk('d1', 'Fn.Lambda construct props runtime handler code memory', 'iacmp-docs'),
    chunk('d2', 'Storage.Bucket construct versioning publicAccess', 'iacmp-docs'),
  ];
  const knowledgeChunks = [
    chunk('k1', 'lambda timeout 15 minutes memory 128MB 10GB limit', 'platform-knowledge'),
    chunk('k2', 's3 bucket storage versioning encryption kms', 'platform-knowledge'),
  ];

  const indexes = buildIndexes(projectChunks, docsChunks, knowledgeChunks);

  test('retorna array de RetrievalResult', () => {
    const results = retrieve(indexes, 'lambda function');
    expect(Array.isArray(results)).toBe(true);
  });

  test('query "lambda" encontra chunks relevantes', () => {
    const results = retrieve(indexes, 'lambda', { minScore: 0.01 });
    const ids = results.map(r => r.chunk.id);
    expect(ids.some(id => ['p1', 'd1', 'k1'].includes(id))).toBe(true);
  });

  test('resultados ordenados por score decrescente', () => {
    const results = retrieve(indexes, 'lambda timeout memory', { minScore: 0.01 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test('minScore filtra resultados com score baixo', () => {
    const results = retrieve(indexes, 'lambda', { minScore: 999 });
    expect(results).toHaveLength(0);
  });

  test('chunk.source é propagado corretamente', () => {
    const results = retrieve(indexes, 'lambda', { minScore: 0.01 });
    for (const r of results) {
      expect(r.source).toBe(r.chunk.metadata.source);
    }
  });

  test('índices vazios retornam []', () => {
    const empty = buildIndexes([], [], []);
    expect(retrieve(empty, 'lambda')).toHaveLength(0);
  });

  test('query sem match retorna []', () => {
    const results = retrieve(indexes, 'kubernetes helm operator');
    expect(results).toHaveLength(0);
  });
});

describe('formatRetrievedContext', () => {
  test('lista vazia retorna string vazia', () => {
    expect(formatRetrievedContext([])).toBe('');
  });

  test('inclui seção de stacks quando há project-stack', () => {
    const results = [
      {
        chunk: chunk('p1', 'conteúdo da stack', 'project-stack'),
        score: 1,
        source: 'project-stack' as const,
      },
    ];
    const ctx = formatRetrievedContext(results);
    expect(ctx).toContain('Stacks do projeto');
    expect(ctx).toContain('conteúdo da stack');
  });

  test('inclui seção de docs quando há iacmp-docs', () => {
    const results = [
      {
        chunk: chunk('d1', 'docs do construct', 'iacmp-docs'),
        score: 1,
        source: 'iacmp-docs' as const,
      },
    ];
    const ctx = formatRetrievedContext(results);
    expect(ctx).toContain('constructs');
    expect(ctx).toContain('docs do construct');
  });

  test('inclui seção de knowledge quando há platform-knowledge', () => {
    const results = [
      {
        chunk: chunk('k1', 'conhecimento de plataforma', 'platform-knowledge'),
        score: 1,
        source: 'platform-knowledge' as const,
      },
    ];
    const ctx = formatRetrievedContext(results);
    expect(ctx).toContain('plataforma');
    expect(ctx).toContain('conhecimento de plataforma');
  });

  test('inclui todas as seções quando há os três tipos', () => {
    const results = [
      { chunk: chunk('p1', 'stack content', 'project-stack'), score: 1, source: 'project-stack' as const },
      { chunk: chunk('d1', 'docs content', 'iacmp-docs'), score: 0.9, source: 'iacmp-docs' as const },
      { chunk: chunk('k1', 'knowledge content', 'platform-knowledge'), score: 0.8, source: 'platform-knowledge' as const },
    ];
    const ctx = formatRetrievedContext(results);
    expect(ctx).toContain('stack content');
    expect(ctx).toContain('docs content');
    expect(ctx).toContain('knowledge content');
  });
});
