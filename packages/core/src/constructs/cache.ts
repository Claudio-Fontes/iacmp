import { Stack, BaseConstruct } from '../stack';

export interface CacheRedisProps {
  nodeType?: 'small' | 'medium' | 'large';
  numCacheNodes?: number;
  automaticFailoverEnabled?: boolean;
  atRestEncryptionEnabled?: boolean;
  transitEncryptionEnabled?: boolean;
}

export namespace Cache {
  export class Redis implements BaseConstruct {
    readonly type = 'Cache.Redis';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: CacheRedisProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
