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
import type { Blob, RuntimeAdapter, Table } from '../types';

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

const adapter: RuntimeAdapter = { table, blob };
export default adapter;
