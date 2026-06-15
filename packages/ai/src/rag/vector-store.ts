import * as fs from 'fs';
import * as path from 'path';

export interface VectorMetadata {
  id: string;
  source: string;
  section?: string;
  platform?: string;
  [key: string]: unknown;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

interface VectorEntry {
  id: string;
  vector: Float32Array;
  metadata: VectorMetadata;
}

// Índice de vetores em memória com similaridade cosseno
export class VectorStore {
  private entries: VectorEntry[] = [];
  private dimension: number = 0;

  add(id: string, vector: number[], metadata: VectorMetadata): void {
    if (this.dimension === 0) {
      this.dimension = vector.length;
    }

    // Normaliza para garantir que similaridade cosseno funciona corretamente
    const normalized = this.normalizeL2(vector);
    this.entries.push({
      id,
      vector: new Float32Array(normalized),
      metadata,
    });
  }

  search(queryVector: number[], topK: number = 5): SearchResult[] {
    if (this.entries.length === 0) return [];

    const normalizedQuery = new Float32Array(this.normalizeL2(queryVector));
    const scores: Array<{ index: number; score: number }> = [];

    for (let i = 0; i < this.entries.length; i++) {
      const score = this.cosineSimilarity(normalizedQuery, this.entries[i].vector);
      scores.push({ index: i, score });
    }

    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ index, score }) => ({
        id: this.entries[index].id,
        score,
        metadata: this.entries[index].metadata,
      }));
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.dimension = 0;
  }

  // Serializa o índice em binário para persistência
  // Formato: [header: 16 bytes][entries...]
  // Header: magic(4) + version(4) + numEntries(4) + dimension(4)
  // Entry: idLen(4) + id(idLen) + metadataLen(4) + metadata(metadataLen) + vector(dimension * 4)
  save(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const MAGIC = 0x56454354; // "VECT"
    const VERSION = 1;

    // Calcula tamanho total
    const encodedEntries = this.entries.map(entry => {
      const idBytes = Buffer.from(entry.id, 'utf-8');
      const metaBytes = Buffer.from(JSON.stringify(entry.metadata), 'utf-8');
      return { entry, idBytes, metaBytes };
    });

    const totalSize = 16 + encodedEntries.reduce((sum, { entry, idBytes, metaBytes }) => {
      return sum + 4 + idBytes.length + 4 + metaBytes.length + entry.vector.length * 4;
    }, 0);

    const buffer = Buffer.alloc(totalSize);
    let offset = 0;

    // Header
    buffer.writeUInt32BE(MAGIC, offset); offset += 4;
    buffer.writeUInt32BE(VERSION, offset); offset += 4;
    buffer.writeUInt32BE(this.entries.length, offset); offset += 4;
    buffer.writeUInt32BE(this.dimension, offset); offset += 4;

    // Entries
    for (const { entry, idBytes, metaBytes } of encodedEntries) {
      buffer.writeUInt32BE(idBytes.length, offset); offset += 4;
      idBytes.copy(buffer, offset); offset += idBytes.length;

      buffer.writeUInt32BE(metaBytes.length, offset); offset += 4;
      metaBytes.copy(buffer, offset); offset += metaBytes.length;

      for (const v of entry.vector) {
        buffer.writeFloatBE(v, offset); offset += 4;
      }
    }

    fs.writeFileSync(filePath, buffer);
  }

  // Carrega índice do binário
  load(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;

    try {
      const buffer = fs.readFileSync(filePath);
      let offset = 0;

      const magic = buffer.readUInt32BE(offset); offset += 4;
      if (magic !== 0x56454354) return false; // magic inválido

      const version = buffer.readUInt32BE(offset); offset += 4;
      if (version !== 1) return false; // versão incompatível

      const numEntries = buffer.readUInt32BE(offset); offset += 4;
      const dimension = buffer.readUInt32BE(offset); offset += 4;

      this.dimension = dimension;
      this.entries = [];

      for (let i = 0; i < numEntries; i++) {
        const idLen = buffer.readUInt32BE(offset); offset += 4;
        const id = buffer.subarray(offset, offset + idLen).toString('utf-8'); offset += idLen;

        const metaLen = buffer.readUInt32BE(offset); offset += 4;
        const metaStr = buffer.subarray(offset, offset + metaLen).toString('utf-8'); offset += metaLen;
        const metadata = JSON.parse(metaStr) as VectorMetadata;

        const vector = new Float32Array(dimension);
        for (let d = 0; d < dimension; d++) {
          vector[d] = buffer.readFloatBE(offset); offset += 4;
        }

        this.entries.push({ id, vector, metadata });
      }

      return true;
    } catch {
      return false;
    }
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    // Vetores já normalizados — similaridade cosseno = produto interno
    return Math.max(-1, Math.min(1, dot));
  }

  private normalizeL2(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return vector;
    return vector.map(v => v / norm);
  }
}
