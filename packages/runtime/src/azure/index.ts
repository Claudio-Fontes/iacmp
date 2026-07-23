import { Collection, MongoClient } from 'mongodb';
import {
  BlobSASPermissions,
  BlobServiceClient,
  ContainerClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import type { Blob, RuntimeAdapter, Table } from '../types';

// Database.DynamoDB no Azure é Cosmos DB MongoDB API (não Table API) — mesma
// decisão já validada em deploy/azure-dynamo-shim.ts. MONGO_URI/DB_NAME chegam
// auto-injetados pelo synth (function.ts) sempre que o Fn.Lambda referencia
// ref(<Table>, 'Name').

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

// Documento Mongo -> item de negócio: remove o `_id` interno do driver (a
// chave de negócio é sempre o campo `id`, gravado explicitamente).
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

// Shim @aws-sdk/client-s3 -> Azure Blob Storage: mesmo mapeamento já validado em
// deploy/azure-s3-shim.ts. O "name" recebido é a storage account (valor da env
// injetada pelo synth); a credencial vem de {ENV_KEY}_CONNECTION_STRING.
const CONTAINER = 'data';

function getConnectionString(name: string): string {
  for (const [key, val] of Object.entries(process.env)) {
    if (val === name) {
      const connStr = process.env[`${key}_CONNECTION_STRING`];
      if (connStr) return connStr;
    }
  }
  throw new Error(
    `Nenhuma connection string encontrada para "${name}". Esperado env var {KEY}_CONNECTION_STRING onde {KEY}="${name}".`,
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
      await getContainer(name); // container precisa existir ANTES do PUT direto via SAS
      return signedBlobUrl(name, key, 'cw', opts?.expiresSeconds ?? 900);
    },
    async presignGet(key, opts) {
      return signedBlobUrl(name, key, 'r', opts?.expiresSeconds ?? 900);
    },
  };
}

const adapter: RuntimeAdapter = { table, blob };
export default adapter;
