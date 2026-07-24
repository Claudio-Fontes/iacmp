import { BaseConstruct } from '@iacmp/core';
import { TFOutput, toTfId, addResource } from './common.js';

export function synthStorage(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Storage.Bucket': {
      const lifecycleRules = (props.lifecycleRules as Array<Record<string, unknown>>) ?? [];
      const tfRules: Array<Record<string, unknown>> = [];
      for (const lr of lifecycleRules) {
        const prefixCond = lr.prefix ? { with_state: 'ANY', matches_prefix: [lr.prefix as string] } : {};
        if (lr.transitionToGlacierDays) {
          tfRules.push({
            action: [{ type: 'SetStorageClass', storage_class: 'ARCHIVE' }],
            condition: [{ age: lr.transitionToGlacierDays as number, ...prefixCond }],
          });
        }
        if (lr.expireAfterDays) {
          tfRules.push({
            action: [{ type: 'Delete' }],
            condition: [{ age: lr.expireAfterDays as number, ...prefixCond }],
          });
        }
      }
      addResource(r, 'google_storage_bucket', id, {
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        location: (props.location as string) ?? 'US',
        versioning: [{ enabled: (props.versioning as boolean) ?? false }],
        uniform_bucket_level_access: !(props.publicAccess as boolean),
        ...(tfRules.length > 0 ? { lifecycle_rule: tfRules } : {}),
      });
      ctx.outputs[`${construct.id}BucketName`] = { value: `\${google_storage_bucket.${id}.name}` };
      ctx.outputs[`${construct.id}BucketUrl`] = { value: `\${google_storage_bucket.${id}.url}` };
      return true;
    }

    case 'Storage.FileSystem': {
      addResource(r, 'google_filestore_instance', id, {
        name: construct.id,
        location: '${var.gcp_region}-a',
        tier: 'STANDARD',
        networks: [{ network: 'default', modes: ['MODE_IPV4'] }],
        file_shares: [{ name: construct.id, capacity_gb: 1024 }],
      });
      return true;
    }

    case 'Storage.Archive': {
      const archiveRules: Array<Record<string, unknown>> = [];
      if (props.retentionDays) {
        archiveRules.push({
          action: [{ type: 'Delete' }],
          condition: [{ age: props.retentionDays as number }],
        });
      }
      addResource(r, 'google_storage_bucket', id, {
        name: `${construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-archive`,
        location: 'US',
        storage_class: 'ARCHIVE',
        uniform_bucket_level_access: true,
        ...(archiveRules.length > 0 ? { lifecycle_rule: archiveRules } : {}),
      });
      return true;
    }

    default:
      return false;
  }
}
