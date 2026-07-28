import { MongoClient, Collection } from 'mongodb';

// Shim de deploy CRUZADO: um projeto AUTORADO para AWS (handler real com
// @aws-sdk/client-dynamodb + @aws-sdk/lib-dynamodb) também pode ser deployado
// na Azure — o esbuild alias troca esses imports por este arquivo no
// empacotamento (ver deploy/azure.ts). Database.DynamoDB no Azure é Cosmos DB
// MongoDB API (NÃO Table API) — por isso o shim é hoje backed por `mongodb`,
// não `@azure/data-tables`. MONGO_URI/DB_NAME chegam auto-injetados pelo synth
// (function.ts) sempre que o Fn.Lambda referencia ref(<Table>, 'Name').

let client: MongoClient | null = null;

async function getClient(): Promise<MongoClient> {
  if (!client) {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI não definida no ambiente da Function');
    client = new MongoClient(uri);
    await client.connect();
  }
  return client;
}

async function getCollection(tableName: string): Promise<Collection> {
  const dbName = process.env.DB_NAME;
  if (!dbName) throw new Error('DB_NAME não definida no ambiente da Function');
  const mongo = await getClient();
  return mongo.db(dbName).collection(tableName);
}

// Documento Mongo -> item de negócio: remove o `_id` interno do driver (a
// chave de negócio é sempre o campo `id`, gravado explicitamente).
function toItem(doc: Record<string, unknown>): Record<string, unknown> {
  const { _id, ...rest } = doc;
  void _id;
  return rest;
}

export class DynamoDBClient {
  constructor(_opts?: unknown) {}
}

export class DynamoDBDocumentClient {
  static from(_client: unknown): DynamoDBDocumentClient {
    return new DynamoDBDocumentClient();
  }

  async send(command: BaseCommand): Promise<unknown> {
    return command.execute();
  }
}

abstract class BaseCommand {
  abstract execute(): Promise<unknown>;
}

export class ScanCommand extends BaseCommand {
  private tableName: string;
  constructor(input: { TableName: string }) {
    super();
    this.tableName = input.TableName;
  }
  async execute(): Promise<{ Items: Record<string, unknown>[] }> {
    const col = await getCollection(this.tableName);
    const docs = await col.find({}).toArray();
    return { Items: docs.map(toItem) };
  }
}

export class PutCommand extends BaseCommand {
  private tableName: string;
  private item: Record<string, unknown>;
  constructor(input: { TableName: string; Item: Record<string, unknown> }) {
    super();
    this.tableName = input.TableName;
    this.item = input.Item;
  }
  async execute(): Promise<Record<string, never>> {
    const col = await getCollection(this.tableName);
    const { id, ...rest } = this.item;
    await col.replaceOne({ id }, { id, ...rest }, { upsert: true });
    return {};
  }
}

export class GetCommand extends BaseCommand {
  private tableName: string;
  private key: { id: string };
  constructor(input: { TableName: string; Key: { id: string } }) {
    super();
    this.tableName = input.TableName;
    this.key = input.Key;
  }
  async execute(): Promise<{ Item?: Record<string, unknown> }> {
    const col = await getCollection(this.tableName);
    const doc = await col.findOne({ id: this.key.id });
    return { Item: doc ? toItem(doc) : undefined };
  }
}

export class UpdateCommand extends BaseCommand {
  private tableName: string;
  private key: { id: string };
  private updateExpression: string;
  private exprNames: Record<string, string>;
  private exprValues: Record<string, unknown>;

  constructor(input: {
    TableName: string;
    Key: { id: string };
    UpdateExpression: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
    ReturnValues?: string;
  }) {
    super();
    this.tableName = input.TableName;
    this.key = input.Key;
    this.updateExpression = input.UpdateExpression;
    this.exprNames = input.ExpressionAttributeNames ?? {};
    this.exprValues = input.ExpressionAttributeValues ?? {};
  }

  async execute(): Promise<{ Attributes: Record<string, unknown> }> {
    const col = await getCollection(this.tableName);
    const id = this.key.id;

    const set: Record<string, unknown> = {};
    const setMatch = this.updateExpression.match(/SET\s+(.+)/i);
    if (setMatch) {
      for (const assignment of setMatch[1].split(',')) {
        const [lhs, rhs] = assignment.split('=').map(s => s.trim());
        const fieldName = this.exprNames[lhs] ?? lhs;
        set[fieldName] = this.exprValues[rhs];
      }
    }

    await col.updateOne({ id }, { $set: set }, { upsert: true });
    const updated = await col.findOne({ id });
    return { Attributes: updated ? toItem(updated) : {} };
  }
}

export class DeleteCommand extends BaseCommand {
  private tableName: string;
  private key: { id: string };
  constructor(input: { TableName: string; Key: { id: string } }) {
    super();
    this.tableName = input.TableName;
    this.key = input.Key;
  }
  async execute(): Promise<Record<string, never>> {
    const col = await getCollection(this.tableName);
    await col.deleteOne({ id: this.key.id });
    return {};
  }
}
