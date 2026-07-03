import { Chunk } from './chunker';

// BM25 — algoritmo de ranking por relevância baseado em term frequency
// Padrão da indústria para busca por palavras-chave. Sem dependências externas.
// Funciona offline, zero custo, boa baseline antes de embedding semântico.

interface BM25Document {
  id: string;
  terms: Record<string, number>; // term → frequency
  length: number;
}

export interface BM25Index {
  documents: BM25Document[];
  df: Record<string, number>;  // document frequency por termo
  avgLength: number;
  totalDocs: number;
}

// k1 e b são parâmetros padrão BM25 — bem testados na literatura
const K1 = 1.5;
const B = 0.75;

function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s._-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function termFrequency(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of tokens) {
    tf[t] = (tf[t] ?? 0) + 1;
  }
  return tf;
}

export function buildBM25Index(chunks: Chunk[]): BM25Index {
  const documents: BM25Document[] = [];
  const df: Record<string, number> = {};
  let totalLength = 0;

  for (const chunk of chunks) {
    // Usa contextualContent se disponível (Contextual Retrieval), senão content
    const text = chunk.contextualContent ?? chunk.content;
    const tokens = tokenize(text);
    const terms = termFrequency(tokens);

    totalLength += tokens.length;
    documents.push({ id: chunk.id, terms, length: tokens.length });

    // Conta em quantos documentos cada termo aparece
    for (const term of Object.keys(terms)) {
      df[term] = (df[term] ?? 0) + 1;
    }
  }

  return {
    documents,
    df,
    avgLength: documents.length > 0 ? totalLength / documents.length : 0,
    totalDocs: documents.length,
  };
}

export function bm25Search(
  index: BM25Index,
  query: string,
  topK: number = 5,
): Array<{ id: string; score: number }> {
  const queryTerms = tokenize(query);
  const scores: Record<string, number> = {};

  for (const term of queryTerms) {
    const docFreq = index.df[term] ?? 0;
    if (docFreq === 0) continue;

    // IDF component (inverse document frequency)
    const idf = Math.log(
      (index.totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1
    );

    for (const doc of index.documents) {
      const tf = doc.terms[term] ?? 0;
      if (tf === 0) continue;

      // BM25 TF component com normalização por comprimento
      const tfNorm =
        (tf * (K1 + 1)) /
        (tf + K1 * (1 - B + B * (doc.length / index.avgLength)));

      scores[doc.id] = (scores[doc.id] ?? 0) + idf * tfNorm;
    }
  }

  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ id, score }));
}
