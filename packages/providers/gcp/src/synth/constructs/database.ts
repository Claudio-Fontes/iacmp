import { BaseConstruct } from '@iacmp/core';
import { CACHE_TIER_MAP, CACHE_CAPACITY_MAP } from '../common.js';
import { TFOutput, toTfId, addResource } from './common.js';

export function synthDatabase(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const edition = (props.edition as string) ?? '';
      const dbVersionMap: Record<string, string> = {
        mysql: 'MYSQL_8_0',
        postgres: 'POSTGRES_15',
        mariadb: 'MYSQL_8_0',
        sqlserver: `SQLSERVER_2019_${(edition || 'EXPRESS').toUpperCase()}`,
        oracle: 'POSTGRES_15',
      };
      const dbVersion = dbVersionMap[engine] ?? 'MYSQL_8_0';
      addResource(r, 'google_sql_database_instance', id, {
        name: construct.id,
        database_version: dbVersion,
        region: '${var.gcp_region}',
        settings: [{
          tier: (props.instanceType as string) ?? 'db-f1-micro',
          backup_configuration: [{ enabled: true }],
          availability_type: (props.multiAz as boolean) ? 'REGIONAL' : 'ZONAL',
        }],
        deletion_protection: false,
      });
      ctx.outputs[`${construct.id}ConnectionName`] = { value: `\${google_sql_database_instance.${id}.connection_name}` };
      return true;
    }

    case 'Database.DocumentDB': {
      addResource(r, 'google_firestore_database', id, {
        project: '${var.project_id}',
        name: '(default)',
        location_id: '${var.gcp_region}',
        type: 'FIRESTORE_NATIVE',
        deletion_policy: (props.deletionProtection as boolean)
          ? 'DELETE_PROTECTION_ENABLED'
          : 'DELETE_PROTECTION_DISABLED',
      });
      return true;
    }

    case 'Database.DynamoDB': {
      addResource(r, 'google_bigtable_instance', id, {
        name: construct.id.toLowerCase(),
        cluster: [{
          cluster_id: 'cluster-1',
          zone: '${var.gcp_zone}',
          num_nodes: 1,
          storage_type: 'SSD',
        }],
        instance_type: 'PRODUCTION',
        display_name: construct.id,
      });
      ctx.needsZoneVar = true;
      return true;
    }

    case 'Cache.Redis': {
      const nodeType = (props.nodeType as string) ?? 'small';
      addResource(r, 'google_redis_instance', id, {
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        tier: CACHE_TIER_MAP[nodeType] ?? 'BASIC',
        memory_size_gb: CACHE_CAPACITY_MAP[nodeType] ?? 1,
        region: '${var.gcp_region}',
        redis_version: 'REDIS_7_0',
        auth_enabled: true,
        transit_encryption_mode: 'SERVER_AUTHENTICATION',
      });
      ctx.outputs[`${construct.id}RedisHost`] = { value: `\${google_redis_instance.${id}.host}` };
      ctx.outputs[`${construct.id}RedisPort`] = { value: `\${google_redis_instance.${id}.port}` };
      return true;
    }

    case 'Cache.Memcached': {
      addResource(r, 'google_memcache_instance', id, {
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        region: '${var.gcp_region}',
        node_count: (props.numCacheNodes as number) ?? 2,
        node_config: [{ cpu_count: 1, memory_size_mb: 1024 }],
      });
      return true;
    }

    case 'Secret.Vault': {
      const secretId = construct.id.replace(/[^a-zA-Z0-9_-]/g, '-');
      addResource(r, 'google_secret_manager_secret', id, {
        secret_id: secretId,
        replication: [{ auto: [{}] }],
      });
      ctx.outputs[`${construct.id}SecretName`] = { value: `\${google_secret_manager_secret.${id}.secret_id}` };
      return true;
    }

    case 'Certificate.TLS': {
      const sans = (props.subjectAlternativeNames as string[]) ?? [];
      addResource(r, 'google_certificate_manager_certificate', id, {
        name: construct.id.replace(/[^a-zA-Z0-9-]/g, '-'),
        managed: [{ domains: [props.domainName as string, ...sans] }],
      });
      return true;
    }

    default:
      return false;
  }
}
