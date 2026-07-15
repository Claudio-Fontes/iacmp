import { TableClient, TableEntity } from '@azure/data-tables';

function getTableClient(tableName: string): TableClient {
  for (const [key, val] of Object.entries(process.env)) {
    if (val === tableName) {
      const connStr = process.env[`${key}_CONNECTION_STRING`];
      if (connStr) {
        return TableClient.fromConnectionString(connStr, tableName);
      }
    }
  }
  throw new Error(`No connection string found for table "${tableName}". Expected env var {KEY}_CONNECTION_STRING where {KEY}="${tableName}".`);
}

// Aceita Record em vez de TableEntity: o SDK retorna TableEntityResult (com
// partitionKey/rowKey opcionais), incompatível com TableEntity estrito — e o
// corpo só desestrutura chaves, não precisa da garantia de presença.
function entityToItem(entity: Record<string, unknown>): Record<string, unknown> {
  const { partitionKey, rowKey, etag, timestamp, ...rest } = entity;
  void partitionKey; void etag; void timestamp;
  const filtered = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('odata.')));
  return { id: rowKey, ...filtered };
}

function itemToEntity(item: Record<string, unknown>): TableEntity {
  const { id, ...rest } = item;
  return { partitionKey: 'default', rowKey: String(id), ...rest } as TableEntity;
}

function isNotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as Record<string, unknown>;
  return err['statusCode'] === 404 || err['code'] === 'ResourceNotFound';
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
    const client = getTableClient(this.tableName);
    const items: Record<string, unknown>[] = [];
    for await (const entity of client.listEntities()) {
      items.push(entityToItem(entity));
    }
    return { Items: items };
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
    const client = getTableClient(this.tableName);
    await client.upsertEntity(itemToEntity(this.item), 'Replace');
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
    const client = getTableClient(this.tableName);
    try {
      const entity = await client.getEntity('default', String(this.key.id));
      return { Item: entityToItem(entity) };
    } catch (e: unknown) {
      if (isNotFound(e)) return { Item: undefined };
      throw e;
    }
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
    const client = getTableClient(this.tableName);
    const rowKey = String(this.key.id);

    const existing = await client.getEntity('default', rowKey);
    const current = entityToItem(existing);

    const setMatch = this.updateExpression.match(/SET\s+(.+)/i);
    if (setMatch) {
      for (const assignment of setMatch[1].split(',')) {
        const [lhs, rhs] = assignment.split('=').map(s => s.trim());
        const fieldName = this.exprNames[lhs] ?? lhs;
        current[fieldName] = this.exprValues[rhs];
      }
    }

    const updatedEntity = itemToEntity(current);
    await client.upsertEntity(updatedEntity, 'Replace');

    const refreshed = await client.getEntity('default', rowKey);
    return { Attributes: entityToItem(refreshed) };
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
    const client = getTableClient(this.tableName);
    await client.deleteEntity('default', String(this.key.id));
    return {};
  }
}
