import { Collection, MongoClient } from 'mongodb';
import {
  BlobSASPermissions,
  BlobServiceClient,
  ContainerClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { ServiceBusClient } from '@azure/service-bus';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';
import { Pool } from 'pg';
import Redis from 'ioredis';
import type { Blob, Cache, CacheConfig, Queue, RuntimeAdapter, Secret, Sql, SqlConfig, Table } from '../types';

// Database.DynamoDB no Azure é Cosmos DB MongoDB API — mesma decisão validada em
// deploy/azure-dynamo-shim.ts. MONGO_URI/DB_NAME chegam auto-injetados pelo synth.
let mongoClient: MongoClient | null = null;
async function getMongoClient(): Promise<MongoClient> {
  if (!mongoClient) {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI não definida no ambiente da Function');
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();
  }
  return mongoClient;
}

async function getCollection(tableName: string): Promise<Collection> {
  const dbName = process.env.DB_NAME;
  if (!dbName) throw new Error('DB_NAME não definida no ambiente da Function');
  const mongo = await getMongoClient();
  return mongo.db(dbName).collection(tableName);
}

function toItem(doc: Record<string, unknown>): Record<string, unknown> {
  const { _id, ...rest } = doc;
  void _id;
  return rest;
}

export function table(name: string): Table {
  return {
    async put(item) {
      const col = await getCollection(name);
      const { id, ...rest } = item;
      await col.replaceOne({ id }, { id, ...rest }, { upsert: true });
    },
    async get(id) {
      const col = await getCollection(name);
      const doc = await col.findOne({ id });
      return doc ? toItem(doc) : null;
    },
    async delete(id) {
      const col = await getCollection(name);
      await col.deleteOne({ id });
    },
    async list() {
      const col = await getCollection(name);
      const docs = await col.find({}).toArray();
      return docs.map(toItem);
    },
    async query(filter) {
      const col = await getCollection(name);
      const docs = await col.find(filter).toArray();
      return docs.map(toItem);
    },
  };
}

// blob(name): "name" é connection string direta ou nome de storage account.
// Connection string direta evita que o synth emita env vars *_CONNECTION_STRING,
// que o Azure Functions Consumption plan interpreta como Azure Files e rejeita.
const CONTAINER = 'data';

function getConnectionString(name: string): string {
  if (name.startsWith('DefaultEndpointsProtocol=')) return name;
  for (const [key, val] of Object.entries(process.env)) {
    if (val === name) {
      const connStr = process.env[`${key}_CONNECTION_STRING`];
      if (connStr) return connStr;
    }
  }
  throw new Error(
    `Nenhuma connection string encontrada para "${name}". Passe a connection string diretamente ou defina env var {KEY}_CONNECTION_STRING onde {KEY}="${name}".`,
  );
}

const ensuredContainers = new Set<string>();
async function getContainer(name: string): Promise<ContainerClient> {
  const service = BlobServiceClient.fromConnectionString(getConnectionString(name));
  const container = service.getContainerClient(CONTAINER);
  if (!ensuredContainers.has(name)) {
    await container.createIfNotExists();
    ensuredContainers.add(name);
  }
  return container;
}

function parseCredential(connStr: string): { accountName: string; credential: StorageSharedKeyCredential } {
  const parts = Object.fromEntries(
    connStr
      .split(';')
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i), p.slice(i + 1)];
      }),
  ) as Record<string, string>;
  const accountName = parts['AccountName'];
  return { accountName, credential: new StorageSharedKeyCredential(accountName, parts['AccountKey']) };
}

function signedBlobUrl(name: string, key: string, perms: string, expiresInSeconds: number): string {
  const connStr = getConnectionString(name);
  const { accountName, credential } = parseCredential(connStr);
  const sas = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER,
      blobName: key,
      permissions: BlobSASPermissions.parse(perms),
      startsOn: new Date(Date.now() - 60_000),
      expiresOn: new Date(Date.now() + expiresInSeconds * 1000),
    },
    credential,
  ).toString();
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `https://${accountName}.blob.core.windows.net/${CONTAINER}/${encodedKey}?${sas}`;
}

export function blob(name: string): Blob {
  return {
    async put(key, body, opts) {
      const container = await getContainer(name);
      const blockBlob = container.getBlockBlobClient(key);
      const data = typeof body === 'string' ? Buffer.from(body) : body;
      await blockBlob.upload(data, data.length, {
        blobHTTPHeaders: opts?.contentType ? { blobContentType: opts.contentType } : undefined,
      });
    },
    async get(key) {
      const container = await getContainer(name);
      const blockBlob = container.getBlockBlobClient(key);
      try {
        const buffer = await blockBlob.downloadToBuffer();
        const props = await blockBlob.getProperties();
        return { body: buffer, contentType: props.contentType };
      } catch (e: unknown) {
        if ((e as { statusCode?: number }).statusCode === 404) return null;
        throw e;
      }
    },
    async delete(key) {
      const container = await getContainer(name);
      await container.getBlockBlobClient(key).deleteIfExists();
    },
    async list(prefix) {
      const container = await getContainer(name);
      const keys: string[] = [];
      for await (const b of container.listBlobsFlat({ prefix })) keys.push(b.name);
      return keys;
    },
    async presignPut(key, opts) {
      await getContainer(name);
      return signedBlobUrl(name, key, 'cw', opts?.expiresSeconds ?? 900);
    },
    async presignGet(key, opts) {
      return signedBlobUrl(name, key, 'r', opts?.expiresSeconds ?? 900);
    },
  };
}

// queue(nameOrConnStr): se começa com "Endpoint=sb://", é connection string com
// EntityPath incluído. Caso contrário, é o nome da fila — lê
// SERVICEBUS_CONNECTION_STRING do ambiente.
const sbClients = new Map<string, ServiceBusClient>();

function resolveSb(nameOrConnStr: string): { client: ServiceBusClient; queueName: string } {
  if (nameOrConnStr.startsWith('Endpoint=sb://')) {
    const match = nameOrConnStr.match(/EntityPath=([^;]+)/);
    const queueName = match?.[1] ?? '';
    const connStr = nameOrConnStr.replace(/;?EntityPath=[^;]+/, '');
    if (!sbClients.has(connStr)) sbClients.set(connStr, new ServiceBusClient(connStr));
    return { client: sbClients.get(connStr)!, queueName };
  }
  const connStr = process.env.SERVICEBUS_CONNECTION_STRING;
  if (!connStr) throw new Error('SERVICEBUS_CONNECTION_STRING não definida');
  if (!sbClients.has(connStr)) sbClients.set(connStr, new ServiceBusClient(connStr));
  return { client: sbClients.get(connStr)!, queueName: nameOrConnStr };
}

export function queue(nameOrConnStr: string): Queue {
  return {
    async send(body) {
      const { client, queueName } = resolveSb(nameOrConnStr);
      const sender = client.createSender(queueName);
      try {
        await sender.sendMessages({ body: typeof body === 'string' ? body : JSON.stringify(body) });
      } finally {
        await sender.close();
      }
    },
    async receive(maxMessages = 1) {
      const { client, queueName } = resolveSb(nameOrConnStr);
      const receiver = client.createReceiver(queueName);
      try {
        const msgs = await receiver.receiveMessages(maxMessages, { maxWaitTimeInMs: 2000 });
        return msgs.map((m) => ({
          id: m.messageId?.toString() ?? '',
          body: typeof m.body === 'string' ? m.body : JSON.stringify(m.body),
          async delete() {
            await receiver.completeMessage(m);
          },
        }));
      } finally {
        await receiver.close();
      }
    },
  };
}

const redisPools = new Map<string, Redis>();
const pgPools = new Map<string, Pool>();
const kvClients = new Map<string, SecretClient>();

export function cache(host: string, opts?: CacheConfig): Cache {
  const port = opts?.port ?? 6380;
  const key = `${host}:${port}`;
  function getRedis(): Redis {
    if (!redisPools.has(key)) {
      redisPools.set(
        key,
        new Redis({ host, port, password: opts?.auth, tls: opts?.tls !== false ? {} : undefined }),
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
          ssl: config.ssl !== false ? { rejectUnauthorized: false } : undefined,
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

// secret(secretId): "https://VAULT.vault.azure.net/secrets/NAME" ou "VAULT_URL|NAME"
export function secret(secretId: string): Secret {
  let vaultUrl: string;
  let secretName: string;
  if (secretId.startsWith('https://')) {
    const slash = secretId.lastIndexOf('/');
    secretName = secretId.slice(slash + 1);
    const secondSlash = secretId.slice(0, slash).lastIndexOf('/');
    vaultUrl = secretId.slice(0, secondSlash);
  } else {
    const sep = secretId.indexOf('|');
    vaultUrl = sep > -1 ? secretId.slice(0, sep) : '';
    secretName = sep > -1 ? secretId.slice(sep + 1) : secretId;
  }
  if (!kvClients.has(vaultUrl)) {
    kvClients.set(vaultUrl, new SecretClient(vaultUrl, new DefaultAzureCredential()));
  }
  const client = kvClients.get(vaultUrl)!;
  return {
    async get() {
      const res = await client.getSecret(secretName);
      if (!res.value) throw new Error(`Secret "${secretName}" sem valor`);
      return res.value;
    },
  };
}

const adapter: RuntimeAdapter = { table, blob, queue, cache, sql, secret };
export default adapter;
