import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import Redis from 'ioredis';
import type { Blob, Cache, CacheConfig, Queue, RuntimeAdapter, Secret, Sql, SqlConfig, Table } from '../types';

let docClient: DynamoDBDocumentClient | null = null;
function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return docClient;
}

let s3Client: S3Client | null = null;
function getS3Client(): S3Client {
  if (!s3Client) s3Client = new S3Client({});
  return s3Client;
}

let sqsClient: SQSClient | null = null;
function getSqsClient(): SQSClient {
  if (!sqsClient) sqsClient = new SQSClient({});
  return sqsClient;
}

let smClient: SecretsManagerClient | null = null;
function getSmClient(): SecretsManagerClient {
  if (!smClient) smClient = new SecretsManagerClient({});
  return smClient;
}

const redisPools = new Map<string, Redis>();
const pgPools = new Map<string, Pool>();

export function table(name: string): Table {
  return {
    async put(item) {
      await getDocClient().send(new PutCommand({ TableName: name, Item: item }));
    },
    async get(id) {
      const res = await getDocClient().send(new GetCommand({ TableName: name, Key: { id } }));
      return res.Item ?? null;
    },
    async delete(id) {
      await getDocClient().send(new DeleteCommand({ TableName: name, Key: { id } }));
    },
    async list() {
      const res = await getDocClient().send(new ScanCommand({ TableName: name }));
      return res.Items ?? [];
    },
    async query(filter) {
      const keys = Object.keys(filter);
      if (keys.length === 0) {
        const res = await getDocClient().send(new ScanCommand({ TableName: name }));
        return res.Items ?? [];
      }
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const expr = keys
        .map((k, i) => {
          names[`#k${i}`] = k;
          values[`:v${i}`] = filter[k];
          return `#k${i} = :v${i}`;
        })
        .join(' AND ');
      const res = await getDocClient().send(
        new ScanCommand({
          TableName: name,
          FilterExpression: expr,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return res.Items ?? [];
    },
  };
}

export function blob(name: string): Blob {
  return {
    async put(key, body, opts) {
      const data = typeof body === 'string' ? Buffer.from(body) : body;
      await getS3Client().send(
        new PutObjectCommand({ Bucket: name, Key: key, Body: data, ContentType: opts?.contentType }),
      );
    },
    async get(key) {
      try {
        const res = await getS3Client().send(new GetObjectCommand({ Bucket: name, Key: key }));
        const bytes = await res.Body!.transformToByteArray();
        return { body: Buffer.from(bytes), contentType: res.ContentType };
      } catch (e: unknown) {
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async delete(key) {
      await getS3Client().send(new DeleteObjectCommand({ Bucket: name, Key: key }));
    },
    async list(prefix) {
      const res = await getS3Client().send(new ListObjectsV2Command({ Bucket: name, Prefix: prefix }));
      return (res.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
    },
    async presignPut(key, opts) {
      return getSignedUrl(
        getS3Client(),
        new PutObjectCommand({ Bucket: name, Key: key, ContentType: opts?.contentType }),
        { expiresIn: opts?.expiresSeconds ?? 900 },
      );
    },
    async presignGet(key, opts) {
      return getSignedUrl(getS3Client(), new GetObjectCommand({ Bucket: name, Key: key }), {
        expiresIn: opts?.expiresSeconds ?? 900,
      });
    },
  };
}

export function queue(queueUrl: string): Queue {
  const sqs = getSqsClient();
  return {
    async send(body) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
        }),
      );
    },
    async receive(maxMessages = 1) {
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: Math.min(maxMessages, 10),
          WaitTimeSeconds: 1,
        }),
      );
      return (res.Messages ?? []).map((m) => ({
        id: m.MessageId!,
        body: m.Body!,
        async delete() {
          await sqs.send(
            new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }),
          );
        },
      }));
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

export function secret(nameOrArn: string): Secret {
  return {
    async get() {
      const res = await getSmClient().send(new GetSecretValueCommand({ SecretId: nameOrArn }));
      const val =
        res.SecretString ??
        (res.SecretBinary ? Buffer.from(res.SecretBinary).toString('base64') : null);
      if (!val) throw new Error(`Secret "${nameOrArn}" sem valor de string`);
      return val;
    },
  };
}

const adapter: RuntimeAdapter = { table, blob, queue, cache, sql, secret };
export default adapter;
