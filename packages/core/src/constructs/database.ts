import { Stack, BaseConstruct } from '../stack';

export type SQLEngine =
  | 'mysql'
  | 'postgres'
  | 'mariadb'
  | 'oracle'
  | 'sqlserver';

export interface DatabaseSQLProps {
  engine: SQLEngine;
  instanceType?: string;
  multiAz?: boolean;
  storageGb?: number;
  backupRetentionDays?: number;
  deletionProtection?: boolean;
  /** Edição do Oracle ou SQL Server quando aplicável.
   * Oracle: 'ee' | 'se2' (padrão: 'se2')
   * SQL Server: 'ex' | 'web' | 'se' | 'ee' (padrão: 'ex')
   */
  edition?: string;
  /** Licença: 'license-included' | 'bring-your-own-license' (padrão: 'license-included') */
  licenseModel?: 'license-included' | 'bring-your-own-license';
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

    static readonly SUPPORTED_ENGINES: SQLEngine[] = [
      'mysql', 'postgres', 'mariadb', 'oracle', 'sqlserver',
    ];

    constructor(stack: Stack, readonly id: string, props: DatabaseSQLProps) {
      if (!SQL.SUPPORTED_ENGINES.includes(props.engine)) {
        throw new Error(
          `Database.SQL "${id}": engine inválido "${props.engine}". ` +
          `Use um dos valores suportados: ${SQL.SUPPORTED_ENGINES.join(', ')}.`,
        );
      }
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
