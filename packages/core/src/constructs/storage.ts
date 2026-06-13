import { Stack, BaseConstruct } from '../stack';

export interface StorageBucketProps {
  versioning?: boolean;
  publicAccess?: boolean;
}

export namespace Storage {
  export class Bucket implements BaseConstruct {
    readonly type = 'Storage.Bucket';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: StorageBucketProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
