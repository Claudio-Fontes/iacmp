export interface Table {
  /** upsert por 'id' */
  put(item: Record<string, unknown> & { id: string }): Promise<void>;
  get(id: string): Promise<Record<string, unknown> | null>;
  delete(id: string): Promise<void>;
  /** scan / find-all */
  list(): Promise<Record<string, unknown>[]>;
  /** igualdade nos campos do filtro */
  query(filter: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

export interface Blob {
  put(key: string, body: Buffer | string, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ body: Buffer; contentType?: string } | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  presignPut(key: string, opts?: { expiresSeconds?: number; contentType?: string }): Promise<string>;
  presignGet(key: string, opts?: { expiresSeconds?: number }): Promise<string>;
}

/** Contrato que cada adaptador de cloud (aws/index.ts, azure/index.ts) implementa. */
export interface RuntimeAdapter {
  table(name: string): Table;
  blob(name: string): Blob;
}
