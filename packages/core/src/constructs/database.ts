import { Stack, BaseConstruct } from '../stack';

export interface DatabaseSQLProps {
  engine: 'mysql' | 'postgres';
  instanceType?: string;
  multiAz?: boolean;
  storageGb?: number;
  backupRetentionDays?: number;
  deletionProtection?: boolean;
}

export interface DatabaseDocumentDBProps {
  instanceType?: string;
  instances?: number;
  deletionProtection?: boolean;
}

export interface DatabaseDynamoDBProps {
  partitionKey: string;
  sortKey?: string;
  billingMode?: 'PAY_PER_REQUEST' | 'PROVISIONED';
  readCapacity?: number;
  writeCapacity?: number;
  ttlAttribute?: string;
  pointInTimeRecovery?: boolean;
  streamEnabled?: boolean;
  globalSecondaryIndexes?: Array<{
    name: string;
    partitionKey: string;
    sortKey?: string;
  }>;
}

export namespace Database {
  export class SQL implements BaseConstruct {
    readonly type = 'Database.SQL';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: DatabaseSQLProps) {
      if (props.engine !== 'mysql' && props.engine !== 'postgres')
        throw new Error(`Database.SQL "${id}": engine inválido "${props.engine}". Use "mysql" ou "postgres".`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class DocumentDB implements BaseConstruct {
    readonly type = 'Database.DocumentDB';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: DatabaseDocumentDBProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class DynamoDB implements BaseConstruct {
    readonly type = 'Database.DynamoDB';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: DatabaseDynamoDBProps) {
      if (!props.partitionKey)
        throw new Error(`Database.DynamoDB "${id}": partitionKey é obrigatório`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
