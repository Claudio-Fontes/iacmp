import { Firestore, Query } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { PubSub } from '@google-cloud/pubsub';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Pool } from 'pg';
import Redis from 'ioredis';
import type { Blob, Cache, CacheConfig, Queue, RuntimeAdapter, Secret, Sql, SqlConfig, Table } from '../types';

let firestore: Firestore | null = null;
function getFirestore(): Firestore {
  if (!firestore) firestore = new Firestore();
  return firestore;
}

let storage: Storage | null = null;
function getStorage(): Storage {
  if (!storage) storage = new Storage();
  return storage;
}

let pubsub: PubSub | null = null;
function getPubSub(): PubSub {
  if (!pubsub) pubsub = new PubSub();
  return pubsub;
}

let secretManager: SecretManagerServiceClient | null = null;
function getSecretManager(): SecretManagerServiceClient {
  if (!secretManager) secretManager = new SecretManagerServiceClient();
  return secretManager;
}

const redisPools = new Map<string, Redis>();
const pgPools = new Map<string, Pool>();

export function table(name: string): Table {
  const col = () => getFirestore().collection(name);
  return {
    async put(item) {
      await col().doc(item.id).set(item);
    },
    async get(id) {
      const doc = await col().doc(id).get();
      return doc.exists ? ((doc.data() as Record<string, unknown>) ?? null) : null;
    },
    async delete(id) {
      await col().doc(id).delete();
    },
    async list() {
      const snap = await col().get();
      return snap.docs.map((d) => d.data() as Record<string, unknown>);
    },
    async query(filter) {
      let q: Query = col();
      for (const [k, v] of Object.entries(filter)) {
        q = q.where(k, '==', v);
      }
      const snap = await q.get();
      return snap.docs.map((d) => d.data() as Record<string, unknown>);
    },
  };
}

export function blob(name: string): Blob {
  const bucket = () => getStorage().bucket(name);
  return {
    async put(key, body, opts) {
      const data = typeof body === 'string' ? Buffer.from(body) : body;
      await bucket().file(key).save(data, { contentType: opts?.contentType });
    },
    async get(key) {
      const file = bucket().file(key);
      const [exists] = await file.exists();
      if (!exists) return null;
      const [body] = await file.download();
      const [meta] = await file.getMetadata();
      return { body, contentType: meta.contentType };
    },
    async delete(key) {
      await bucket().file(key).delete();
    },
    async list(prefix) {
      const [files] = await bucket().getFiles({ prefix });
      return files.map((f) => f.name);
    },
    async presignPut(key, opts) {
      const [url] = await bucket()
        .file(key)
        .getSignedUrl({
          version: 'v4',
          action: 'write',
          expires: Date.now() + (opts?.expiresSeconds ?? 900) * 1000,
          contentType: opts?.contentType,
        });
      return url;
    },
    async presignGet(key, opts) {
      const [url] = await bucket()
        .file(key)
        .getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + (opts?.expiresSeconds ?? 900) * 1000,
        });
      return url;
    },
  };
}

// queue(topicName): publica no topic Pub/Sub; receive usa convenção "<topic>-sub".
export function queue(topicName: string): Queue {
  return {
    async send(body) {
      const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      await getPubSub().topic(topicName).publishMessage({ data });
    },
    async receive(maxMessages = 1) {
      const subName = `${topicName}-sub`;
      const sub = getPubSub().subscription(subName);
      return new Promise<ReturnType<typeof queue>['receive'] extends (...a: any[]) => Promise<infer R> ? R : never>((resolve) => {
        const collected: Array<{ id: string; body: string; delete(): Promise<void> }> = [];
        const done = () => {
          sub.removeAllListeners('message');
          resolve(collected);
        };
        const timer = setTimeout(done, 2000);
        sub.on('message', (msg: any) => {
          collected.push({
            id: msg.id as string,
            body: (msg.data as Buffer).toString(),
            async delete() { msg.ack(); },
          });
          if (collected.length >= maxMessages) {
            clearTimeout(timer);
            done();
          }
        });
      });
    },
  };
}

export function cache(host: string, opts?: CacheConfig): Cache {
  const port = opts?.port ?? 6379;
  const key = `${host}:${port}`;
  function getRedis(): Redis {
    if (!redisPools.has(key)) {
      redisPools.set(
        key,
        new Redis({ host, port, password: opts?.auth, tls: opts?.tls ? {} : undefined }),
      );
    }
    return redisPools.get(key)!;
  }
  return {
    async get(k) {
      return getRedis().get(k);
    },
    async set(k, v, ttlSeconds) {
      if (ttlSeconds) await getRedis().set(k, v, 'EX', ttlSeconds);
      else await getRedis().set(k, v);
    },
    async del(k) {
      await getRedis().del(k);
    },
  };
}

export function sql(config: SqlConfig): Sql {
  const key = `${config.host}:${config.port ?? 5432}:${config.database ?? 'postgres'}`;
  function getPool(): Pool {
    if (!pgPools.has(key)) {
      pgPools.set(
        key,
        new Pool({
          host: config.host,
          user: config.user,
          password: config.password,
          database: config.database ?? 'postgres',
          port: config.port ?? 5432,
          ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        }),
      );
    }
    return pgPools.get(key)!;
  }
  return {
    async query<T>(sqlStr: string, params?: unknown[]): Promise<T[]> {
      const res = await getPool().query(sqlStr, params as unknown[]);
      return res.rows as T[];
    },
    async execute(sqlStr, params) {
      await getPool().query(sqlStr, params as unknown[]);
    },
  };
}

// secret(name): "projects/PROJECT/secrets/NAME/versions/latest" ou só "NAME"
// (nesse caso usa GOOGLE_CLOUD_PROJECT do ambiente).
export function secret(name: string): Secret {
  const resourceName = name.startsWith('projects/')
    ? name
    : `projects/${process.env.GOOGLE_CLOUD_PROJECT}/secrets/${name}/versions/latest`;
  return {
    async get() {
      const [version] = await getSecretManager().accessSecretVersion({ name: resourceName });
      const val = version.payload?.data?.toString();
      if (!val) throw new Error(`Secret "${name}" sem valor`);
      return val;
    },
  };
}

const adapter: RuntimeAdapter = { table, blob, queue, cache, sql, secret };
export default adapter;
