import { buildBM25Index, bm25Search } from '../src/rag/bm25';
import { Chunk } from '../src/rag/chunker';

function makeChunk(id: string, content: string): Chunk {
  return {
    id,
    content,
    metadata: { source: 'platform-knowledge', platform: 'aws' },
  };
}

describe('BM25', () => {
  const chunks = [
    makeChunk('a', 'lambda function serverless aws timeout memory'),
    makeChunk('b', 'rds database mysql postgresql aurora replica'),
    makeChunk('c', 's3 bucket storage versioning object encryption'),
    makeChunk('d', 'vpc subnet cidr nat gateway private public'),
    makeChunk('e', 'lambda timeout concurrent executions limit throttle'),
  ];

  const index = buildBM25Index(chunks);

  test('buildBM25Index — conta documentos corretamente', () => {
    expect(index.totalDocs).toBe(5);
    expect(index.documents).toHaveLength(5);
  });

  test('buildBM25Index — avgLength é positivo', () => {
    expect(index.avgLength).toBeGreaterThan(0);
  });

  test('buildBM25Index — df registra frequência de documentos por termo', () => {
    // "lambda" aparece em chunks a e e
    expect(index.df['lambda']).toBe(2);
    // "rds" aparece só em b
    expect(index.df['rds']).toBe(1);
  });

  test('bm25Search — retorna chunk mais relevante para "lambda"', () => {
    const results = bm25Search(index, 'lambda', 3);
    expect(results.length).toBeGreaterThan(0);
    // chunks a e e têm lambda; ambos devem aparecer
    const ids = results.map(r => r.id);
    expect(ids).toContain('a');
    expect(ids).toContain('e');
  });

  test('bm25Search — retorna chunk correto para "rds aurora"', () => {
    const results = bm25Search(index, 'rds aurora', 1);
    expect(results[0].id).toBe('b');
    expect(results[0].score).toBeGreaterThan(0);
  });

  test('bm25Search — respeita topK', () => {
    const results = bm25Search(index, 'lambda', 1);
    expect(results).toHaveLength(1);
  });

  test('bm25Search — query sem match retorna vazio', () => {
    const results = bm25Search(index, 'kubernetes helm operator', 5);
    expect(results).toHaveLength(0);
  });

  test('bm25Search — índice vazio retorna vazio', () => {
    const emptyIndex = buildBM25Index([]);
    const results = bm25Search(emptyIndex, 'lambda', 5);
    expect(results).toHaveLength(0);
  });

  test('bm25Search — scores em ordem decrescente', () => {
    const results = bm25Search(index, 'lambda timeout', 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test('buildBM25Index — usa contextualContent quando disponível', () => {
    const chunkWithContext: Chunk = {
      id: 'ctx',
      content: 'conteúdo original',
      contextualContent: 'lambda enriquecida com contexto adicional',
      metadata: { source: 'platform-knowledge' },
    };
    const idx = buildBM25Index([chunkWithContext]);
    const results = bm25Search(idx, 'lambda enriquecida', 1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('ctx');
  });
});
