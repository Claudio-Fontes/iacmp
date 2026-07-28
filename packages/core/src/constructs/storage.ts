import { ref, type Ref } from '../refs';
import { Stack, BaseConstruct } from '../stack';

export interface BucketRefs {
  readonly arn: Ref<'Arn'>;
  readonly name: Ref<'Name'>;
}

export interface StorageBucketProps {
  versioning?: boolean;
  publicAccess?: boolean;
  websiteHosting?: boolean;
  bucketName?: string;
  location?: string;
  /** 'geo' → replicação para a região pareada (Azure: RA-GRS com endpoint secundário de leitura; AWS ignora — DR lá é bucket em stack region:'dr'). */
  replication?: 'geo';
  lifecycleRules?: Array<{
    prefix?: string;
    expireAfterDays?: number;
    transitionToGlacierDays?: number;
  }>;
  /** Regras CORS — necessário para upload/download direto do browser (ex: presigned URL). */
  cors?: Array<{
    allowedMethods: Array<'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD'>;
    allowedOrigins?: string[];
    allowedHeaders?: string[];
    maxAgeSeconds?: number;
  }>;
  /** Dispara uma Lambda quando um objeto é criado/removido no bucket (S3 → Lambda).
   *  lambdaId = id de uma Fn.Lambda. O synth cria a NotificationConfiguration e a
   *  Lambda::Permission necessárias. */
  eventNotifications?: Array<{
    lambdaId: string | Ref<'Arn'>;
    events?: string[];   // ex: ['s3:ObjectCreated:*'] (padrão)
    prefix?: string;
    suffix?: string;
  }>;
}

export interface StorageFileSystemProps {
  performanceMode?: 'generalPurpose' | 'maxIO';
  throughputMode?: 'bursting' | 'provisioned';
  encrypted?: boolean;
  accessPoints?: Array<{
    name: string;
    path: string;
    uid?: number;
    gid?: number;
  }>;
}

export interface StorageArchiveProps {
  retrievalTier?: 'Expedited' | 'Standard' | 'Bulk';
  lockEnabled?: boolean;
  retentionDays?: number;
  location?: string;
}

export namespace Storage {
  export class Bucket implements BaseConstruct, BucketRefs {
    readonly type = 'Storage.Bucket';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: StorageBucketProps = {}) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
    get arn(): Ref<'Arn'> { return ref(this.id, 'Arn'); }
    get name(): Ref<'Name'> { return ref(this.id, 'Name'); }
  }

  export class FileSystem implements BaseConstruct {
    readonly type = 'Storage.FileSystem';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: StorageFileSystemProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class Archive implements BaseConstruct {
    readonly type = 'Storage.Archive';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: StorageArchiveProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
