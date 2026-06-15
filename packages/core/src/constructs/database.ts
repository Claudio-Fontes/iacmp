import { Stack, BaseConstruct } from '../stack';

export interface DatabaseSQLProps {
  engine: 'mysql' | 'postgres';
  instanceType?: string;
  multiAz?: boolean;
}

export namespace Database {
  export class SQL implements BaseConstruct {
    readonly type = 'Database.SQL';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: DatabaseSQLProps) {
      if (props.engine !== 'mysql' && props.engine !== 'postgres') {
        throw new Error(`Database.SQL: engine inválido "${props.engine}". Use "mysql" ou "postgres".`);
      }
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
