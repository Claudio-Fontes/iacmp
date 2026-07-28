export interface Table {
  put(item: Record<string, unknown> & { id: string }): Promise<void>;
  get(id: string): Promise<Record<string, unknown> | null>;
  delete(id: string): Promise<void>;
  list(): Promise<Record<string, unknown>[]>;
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

export interface QueueMessage {
  id: string;
  body: string;
  delete(): Promise<void>;
}

export interface Queue {
  send(body: string | Record<string, unknown>): Promise<void>;
  receive(maxMessages?: number): Promise<QueueMessage[]>;
}

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
}

export interface Secret {
  get(): Promise<string>;
}

export interface SqlConfig {
  host: string;
  user: string;
  password: string;
  database?: string;
  port?: number;
  ssl?: boolean;
}

export interface CacheConfig {
  port?: number;
  auth?: string;
  tls?: boolean;
}

export interface RuntimeAdapter {
  table(name: string): Table;
  blob(name: string): Blob;
  queue(nameOrUrl: string): Queue;
  cache(host: string, opts?: CacheConfig): Cache;
  sql(config: SqlConfig): Sql;
  secret(nameOrArn: string): Secret;
}
