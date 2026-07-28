import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  ContainerClient,
} from '@azure/storage-blob';

/**
 * Shim @aws-sdk/client-s3 (+ s3-request-presigner) → Azure Blob Storage.
 * Mesmo papel do azure-dynamo-shim: o esbuild troca os imports no empacotamento,
 * então um projeto gerado para AWS roda na Azure sem tocar no handler.
 *
 * Mapeamento: S3 bucket → storage account + container fixo "data" (criado
 * on-demand). O "Bucket" recebido é o nome da storage account (valor da env
 * injetada pelo synth); a credencial vem de {ENV_KEY}_CONNECTION_STRING —
 * mesma convenção do shim de DynamoDB.
 *
 * Diferença inevitável de protocolo no presigned PUT: o consumidor HTTP precisa
 * enviar o header `x-ms-blob-type: BlockBlob` (exigência da API REST do Blob).
 */

const CONTAINER = 'data';

function getConnectionString(bucket: string): string {
  for (const [key, val] of Object.entries(process.env)) {
    if (val === bucket) {
      const connStr = process.env[`${key}_CONNECTION_STRING`];
      if (connStr) return connStr;
    }
  }
  throw new Error(`No connection string found for bucket "${bucket}". Expected env var {KEY}_CONNECTION_STRING where {KEY}="${bucket}".`);
}

const ensured = new Set<string>();
async function getContainer(bucket: string): Promise<ContainerClient> {
  const service = BlobServiceClient.fromConnectionString(getConnectionString(bucket));
  const container = service.getContainerClient(CONTAINER);
  if (!ensured.has(bucket)) {
    await container.createIfNotExists();
    ensured.add(bucket);
  }
  return container;
}

function parseCredential(connStr: string): { accountName: string; credential: StorageSharedKeyCredential } {
  const parts = Object.fromEntries(
    connStr.split(';').filter(Boolean).map(p => {
      const i = p.indexOf('=');
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  ) as Record<string, string>;
  const accountName = parts['AccountName'];
  return { accountName, credential: new StorageSharedKeyCredential(accountName, parts['AccountKey']) };
}

function notFound(): Error {
  const err = new Error('NotFound') as Error & { name: string; $metadata: { httpStatusCode: number } };
  err.name = 'NotFound';
  err.$metadata = { httpStatusCode: 404 };
  return err;
}

export class S3Client {
  constructor(_opts?: unknown) {}
  async send(command: BaseCommand): Promise<unknown> {
    return command.execute();
  }
}

abstract class BaseCommand {
  abstract execute(): Promise<unknown>;
}

interface ObjectInput { Bucket: string; Key: string }

export class PutObjectCommand extends BaseCommand {
  readonly input: ObjectInput & { Body?: unknown; ContentType?: string; Metadata?: Record<string, string> };
  constructor(input: PutObjectCommand['input']) { super(); this.input = input; }
  async execute(): Promise<{ ETag?: string }> {
    const container = await getContainer(this.input.Bucket);
    const blob = container.getBlockBlobClient(this.input.Key);
    const body = this.input.Body ?? '';
    const data = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body as Uint8Array);
    const res = await blob.upload(data, data.length, {
      blobHTTPHeaders: this.input.ContentType ? { blobContentType: this.input.ContentType } : undefined,
      metadata: this.input.Metadata,
    });
    return { ETag: res.etag };
  }
}

export class GetObjectCommand extends BaseCommand {
  readonly input: ObjectInput;
  constructor(input: ObjectInput) { super(); this.input = input; }
  async execute(): Promise<unknown> {
    const container = await getContainer(this.input.Bucket);
    const blob = container.getBlockBlobClient(this.input.Key);
    let buffer: Buffer;
    let props: { contentType?: string; contentLength?: number; lastModified?: Date; metadata?: Record<string, string> };
    try {
      buffer = await blob.downloadToBuffer();
      props = await blob.getProperties();
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode === 404) throw notFound();
      throw e;
    }
    return {
      Body: {
        transformToString: async (enc?: string) => buffer.toString((enc as BufferEncoding) ?? 'utf-8'),
        transformToByteArray: async () => new Uint8Array(buffer),
      },
      ContentType: props.contentType,
      ContentLength: props.contentLength,
      LastModified: props.lastModified,
      Metadata: props.metadata ?? {},
    };
  }
}

export class HeadObjectCommand extends BaseCommand {
  readonly input: ObjectInput;
  constructor(input: ObjectInput) { super(); this.input = input; }
  async execute(): Promise<unknown> {
    const container = await getContainer(this.input.Bucket);
    try {
      const props = await container.getBlockBlobClient(this.input.Key).getProperties();
      return {
        ContentType: props.contentType,
        ContentLength: props.contentLength,
        LastModified: props.lastModified,
        ETag: props.etag,
        Metadata: props.metadata ?? {},
      };
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode === 404) throw notFound();
      throw e;
    }
  }
}

export class DeleteObjectCommand extends BaseCommand {
  readonly input: ObjectInput;
  constructor(input: ObjectInput) { super(); this.input = input; }
  async execute(): Promise<Record<string, never>> {
    const container = await getContainer(this.input.Bucket);
    await container.getBlockBlobClient(this.input.Key).deleteIfExists();
    return {};
  }
}

export class DeleteObjectsCommand extends BaseCommand {
  readonly input: { Bucket: string; Delete: { Objects: Array<{ Key: string }> } };
  constructor(input: DeleteObjectsCommand['input']) { super(); this.input = input; }
  async execute(): Promise<{ Deleted: Array<{ Key: string }> }> {
    const container = await getContainer(this.input.Bucket);
    const deleted: Array<{ Key: string }> = [];
    for (const o of this.input.Delete.Objects) {
      await container.getBlockBlobClient(o.Key).deleteIfExists();
      deleted.push({ Key: o.Key });
    }
    return { Deleted: deleted };
  }
}

export class CopyObjectCommand extends BaseCommand {
  readonly input: { Bucket: string; Key: string; CopySource: string };
  constructor(input: CopyObjectCommand['input']) { super(); this.input = input; }
  async execute(): Promise<Record<string, never>> {
    // CopySource = "<bucket>/<key>" (possivelmente URL-encoded). Origem e destino
    // podem ser accounts diferentes — a origem vira URL com SAS de leitura.
    const decoded = decodeURIComponent(this.input.CopySource);
    const slash = decoded.indexOf('/');
    const srcBucket = decoded.slice(0, slash);
    const srcKey = decoded.slice(slash + 1);
    const srcUrl = signedBlobUrl(srcBucket, srcKey, 'r', 300);
    const container = await getContainer(this.input.Bucket);
    await container.getBlockBlobClient(this.input.Key).syncCopyFromURL(srcUrl);
    return {};
  }
}

export class ListObjectsV2Command extends BaseCommand {
  readonly input: { Bucket: string; Prefix?: string; MaxKeys?: number };
  constructor(input: ListObjectsV2Command['input']) { super(); this.input = input; }
  async execute(): Promise<unknown> {
    const container = await getContainer(this.input.Bucket);
    const contents: Array<{ Key: string; Size: number; LastModified?: Date; ETag?: string }> = [];
    const max = this.input.MaxKeys ?? 1000;
    for await (const blob of container.listBlobsFlat({ prefix: this.input.Prefix })) {
      contents.push({
        Key: blob.name,
        Size: blob.properties.contentLength ?? 0,
        LastModified: blob.properties.lastModified,
        ETag: blob.properties.etag,
      });
      if (contents.length >= max) break;
    }
    return { Contents: contents, KeyCount: contents.length, IsTruncated: false };
  }
}

function signedBlobUrl(bucket: string, key: string, perms: string, expiresInSeconds: number): string {
  const connStr = getConnectionString(bucket);
  const { accountName, credential } = parseCredential(connStr);
  const sas = generateBlobSASQueryParameters({
    containerName: CONTAINER,
    blobName: key,
    permissions: BlobSASPermissions.parse(perms),
    startsOn: new Date(Date.now() - 60_000),
    expiresOn: new Date(Date.now() + expiresInSeconds * 1000),
  }, credential).toString();
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `https://${accountName}.blob.core.windows.net/${CONTAINER}/${encodedKey}?${sas}`;
}

/** Equivalente do @aws-sdk/s3-request-presigner: PUT → SAS de escrita; GET → SAS de leitura. */
export async function getSignedUrl(
  _client: unknown,
  command: PutObjectCommand | GetObjectCommand,
  opts?: { expiresIn?: number },
): Promise<string> {
  const { Bucket, Key } = command.input;
  const write = command instanceof PutObjectCommand;
  // container precisa existir ANTES do PUT direto do cliente via SAS
  await getContainer(Bucket);
  return signedBlobUrl(Bucket, Key, write ? 'cw' : 'r', opts?.expiresIn ?? 900);
}
