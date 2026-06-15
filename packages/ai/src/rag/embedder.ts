import * as crypto from 'crypto';

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

// VoyageEmbedder: usa a API voyage-code-2 se VOYAGE_API_KEY disponível
export class VoyageEmbedder implements Embedder {
  private readonly apiKey: string;
  private readonly model = 'voyage-code-2';
  private readonly endpoint = 'https://api.voyageai.com/v1/embeddings';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Voyage aceita até 128 textos por request
    const BATCH_SIZE = 128;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const batchVectors = await this.embedBatch(batch);
      results.push(...batchVectors);
    }

    return results;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          input_type: 'document',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Voyage API error ${response.status}: ${body}`);
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Garante ordem correta (Voyage retorna em ordem, mas por segurança)
      const sorted = data.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => d.embedding);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// BM25Embedder: fallback quando não há VOYAGE_API_KEY
// Retorna vetor TF-IDF esparso como representação numérica
export class BM25Embedder implements Embedder {
  private readonly vocabSize: number;

  constructor(vocabSize = 4096) {
    this.vocabSize = vocabSize;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.textToVector(text));
  }

  private textToVector(text: string): number[] {
    const tokens = this.tokenize(text);
    const tf = this.termFrequency(tokens);
    const vector = new Float64Array(this.vocabSize);

    for (const [term, freq] of Object.entries(tf)) {
      // Hash determinístico do termo para posição no vetor
      const hash = this.termHash(term);
      const pos = Math.abs(hash) % this.vocabSize;
      // TF-IDF simplificado: log(1 + freq) normalizado pelo comprimento
      vector[pos] += Math.log(1 + freq) / Math.max(1, tokens.length);
    }

    // Normaliza L2 para similaridade cosseno funcionar corretamente
    return this.normalizeL2(Array.from(vector));
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s._-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  private termFrequency(tokens: string[]): Record<string, number> {
    const tf: Record<string, number> = {};
    for (const t of tokens) {
      tf[t] = (tf[t] ?? 0) + 1;
    }
    return tf;
  }

  private termHash(term: string): number {
    // djb2 hash — simples e determinístico
    let hash = 5381;
    for (let i = 0; i < term.length; i++) {
      hash = ((hash << 5) + hash) ^ term.charCodeAt(i);
      hash = hash & 0x7fffffff; // mantém 31 bits positivos
    }
    return hash;
  }

  private normalizeL2(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return vector;
    return vector.map(v => v / norm);
  }
}

// Factory: retorna o embedder adequado baseado na disponibilidade de VOYAGE_API_KEY
export function createEmbedder(voyageApiKey?: string): Embedder {
  if (voyageApiKey) {
    return new VoyageEmbedder(voyageApiKey);
  }
  return new BM25Embedder();
}
