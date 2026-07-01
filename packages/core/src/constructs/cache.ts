import { Stack, BaseConstruct } from '../stack';

export interface CacheRedisProps {
  nodeType?: 'small' | 'medium' | 'large';
  numCacheNodes?: number;
  automaticFailoverEnabled?: boolean;
  atRestEncryptionEnabled?: boolean;
  transitEncryptionEnabled?: boolean;
  version?: string;
  /** Subnets (ids de Network.Subnet ou literais) — o synth cria o CacheSubnetGroup. Preferível a subnetGroupName. */
  subnetIds?: string[];
  subnetGroupName?: string;
  securityGroupIds?: string[];
}

export interface CacheMemcachedProps {
  nodeType?: 'small' | 'medium' | 'large';
  numCacheNodes?: number;
  subnetGroupName?: string;
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

  export class Memcached implements BaseConstruct {
    readonly type = 'Cache.Memcached';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: CacheMemcachedProps) {
      if ((props.numCacheNodes ?? 1) < 1)
        throw new Error(`Cache.Memcached "${id}": numCacheNodes deve ser >= 1`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
