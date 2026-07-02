import { ref, type Ref } from '../refs';
import { Stack, BaseConstruct } from '../stack';

export interface RedisRefs {
  readonly endpoint: Ref<'Endpoint'>;
  readonly port: Ref<'Port'>;
}

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
  export class Redis implements BaseConstruct, RedisRefs {
    readonly type = 'Cache.Redis';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: CacheRedisProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
    get endpoint(): Ref<'Endpoint'> { return ref(this.id, 'Endpoint'); }
    get port(): Ref<'Port'> { return ref(this.id, 'Port'); }
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
