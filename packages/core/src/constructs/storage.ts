import { Stack, BaseConstruct } from '../stack';

export interface StorageBucketProps {
  versioning?: boolean;
  publicAccess?: boolean;
  location?: string;
  lifecycleRules?: Array<{
    prefix?: string;
    expireAfterDays?: number;
    transitionToGlacierDays?: number;
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
  export class Bucket implements BaseConstruct {
    readonly type = 'Storage.Bucket';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: StorageBucketProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
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
