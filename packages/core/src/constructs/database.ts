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
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
