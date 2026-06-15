import { BM25Embedder, createEmbedder } from '../src/rag/embedder';

describe('BM25Embedder', () => {
  const embedder = new BM25Embedder();

  test('embed retorna um vetor por texto', async () => {
    const texts = ['lambda serverless aws', 'rds database postgresql'];
    const vectors = await embedder.embed(texts);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(4096);
    expect(vectors[1]).toHaveLength(4096);
  });

  test('embed de lista vazia retorna vazio', async () => {
    const vectors = await embedder.embed([]);
    expect(vectors).toHaveLength(0);
  });

  test('vetor é normalizado (norma L2 ≈ 1)', async () => {
    const [[...v]] = await embedder.embed(['lambda timeout memory aws serverless']);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3);
  });

  test('vetor de texto vazio não lança exceção', async () => {
    const vectors = await embedder.embed(['']);
    expect(vectors).toHaveLength(1);
    // texto vazio → norma zero → vetor de zeros
    const norm = Math.sqrt(vectors[0].reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(0, 5);
  });

  test('textos diferentes produzem vetores diferentes', async () => {
    const [v1, v2] = await embedder.embed(['lambda aws serverless', 'rds postgresql database']);
    const identical = v1.every((val, i) => val === v2[i]);
    expect(identical).toBe(false);
  });

  test('mesmo texto produz vetor idêntico (determinístico)', async () => {
    const text = 'vpc subnet cidr nat gateway';
    const [v1] = await embedder.embed([text]);
    const [v2] = await embedder.embed([text]);
    expect(v1).toEqual(v2);
  });

  test('vocabSize customizado é respeitado', async () => {
    const small = new BM25Embedder(128);
    const [v] = await small.embed(['teste']);
    expect(v).toHaveLength(128);
  });
});

describe('createEmbedder', () => {
  test('sem apiKey → retorna BM25Embedder', () => {
    const e = createEmbedder();
    expect(e).toBeInstanceOf(BM25Embedder);
  });

  test('sem apiKey undefined → retorna BM25Embedder', () => {
    const e = createEmbedder(undefined);
    expect(e).toBeInstanceOf(BM25Embedder);
  });

  test('com apiKey → retorna VoyageEmbedder (não BM25)', () => {
    const e = createEmbedder('fake-key-123');
    expect(e).not.toBeInstanceOf(BM25Embedder);
  });
});
