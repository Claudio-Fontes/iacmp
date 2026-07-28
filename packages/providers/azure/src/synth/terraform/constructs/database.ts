import { BaseConstruct } from '@iacmp/core';
import { AzureTFCtx, addRes, toTFId, RG_NAME, RG_LOCATION } from '../common';
import { TFRegistry, resolveDeep } from '../refs';

/** Database.* e Cache.Redis → Cosmos DB, Flexible Server (pg/mysql) e Redis Cache. */
export function synthDatabase(c: BaseConstruct, ctx: AzureTFCtx, reg: TFRegistry): boolean {
  const p = (c.props ?? {}) as Record<string, unknown>;
  const id = toTFId(c.id);
  const rg = RG_NAME;
  const loc = RG_LOCATION;

  switch (c.type) {
    case 'Database.Table':
    case 'Database.DynamoDB': {
      const partitionKey = (p.partitionKey as string) ?? 'id';
      const pkPath = partitionKey.startsWith('/') ? partitionKey : `/${partitionKey}`;
      addRes(ctx, 'azurerm_cosmosdb_account', id, {
        name: `${id.replace(/_/g, '-')}-cosmos`.slice(0, 44),
        resource_group_name: rg,
        location: loc,
        offer_type: 'Standard',
        kind: 'GlobalDocumentDB',
        consistency_policy: { consistency_level: 'Session' },
        geo_location: [{ location: loc, failover_priority: 0 }],
        capabilities: [{ name: 'EnableServerless' }],
      });
      addRes(ctx, 'azurerm_cosmosdb_sql_database', `${id}_db`, {
        name: `${id.replace(/_/g, '-')}-db`,
        resource_group_name: rg,
        account_name: `\${azurerm_cosmosdb_account.${id}.name}`,
      });
      addRes(ctx, 'azurerm_cosmosdb_sql_container', `${id}_container`, {
        name: `${id.replace(/_/g, '-')}-items`,
        resource_group_name: rg,
        account_name: `\${azurerm_cosmosdb_account.${id}.name}`,
        database_name: `\${azurerm_cosmosdb_sql_database.${id}_db.name}`,
        partition_key_path: pkPath,
        partition_key_version: 2,
      });
      ctx.outputs[`${id}_endpoint`] = { value: `\${azurerm_cosmosdb_account.${id}.endpoint}` };
      ctx.outputs[`${id}_key`] = { value: `\${azurerm_cosmosdb_account.${id}.primary_key}`, sensitive: true };
      return true;
    }

    case 'Database.DocumentDB': {
      addRes(ctx, 'azurerm_cosmosdb_account', id, {
        name: `${id.replace(/_/g, '-')}-cosmos`.slice(0, 44),
        resource_group_name: rg,
        location: loc,
        offer_type: 'Standard',
        kind: 'MongoDB',
        consistency_policy: { consistency_level: 'Session' },
        geo_location: [{ location: loc, failover_priority: 0 }],
        capabilities: [{ name: 'EnableMongo' }, { name: 'EnableServerless' }],
        mongo_server_version: '6.0',
      });
      ctx.outputs[`${id}_endpoint`] = { value: `\${azurerm_cosmosdb_account.${id}.endpoint}` };
      ctx.outputs[`${id}_connection_string`] = { value: `\${azurerm_cosmosdb_account.${id}.connection_strings[0]}`, sensitive: true };
      return true;
    }

    case 'Database.SQL': {
      const engine = (p.engine as string) ?? 'postgres';
      const adminUser = 'dbadmin';
      const adminPw = p.adminPassword
        ? String(resolveDeep(p.adminPassword, reg))
        : 'ChangeMe123!Tf';
      if (engine === 'mysql') {
        addRes(ctx, 'azurerm_mysql_flexible_server', id, {
          name: `${id.replace(/_/g, '-')}-mysql`.slice(0, 63),
          resource_group_name: rg,
          location: loc,
          administrator_login: adminUser,
          administrator_password: adminPw,
          sku_name: 'B_Standard_B1ms',
          version: '8.0.21',
          zone: '1',
        });
        addRes(ctx, 'azurerm_mysql_flexible_database', `${id}_db`, {
          name: (p.databaseName as string) ?? id.replace(/_/g, ''),
          resource_group_name: rg,
          server_name: `\${azurerm_mysql_flexible_server.${id}.name}`,
          charset: 'utf8mb4',
          collation: 'utf8mb4_general_ci',
        });
        ctx.outputs[`${id}_fqdn`] = { value: `\${azurerm_mysql_flexible_server.${id}.fqdn}` };
      } else {
        addRes(ctx, 'azurerm_postgresql_flexible_server', id, {
          name: `${id.replace(/_/g, '-')}-pg`.slice(0, 63),
          resource_group_name: rg,
          location: loc,
          administrator_login: adminUser,
          administrator_password: adminPw,
          version: '14',
          sku_name: 'B_Standard_B1ms',
          storage_mb: 32768,
          zone: '1',
        });
        addRes(ctx, 'azurerm_postgresql_flexible_server_database', `${id}_db`, {
          name: (p.databaseName as string) ?? id.replace(/_/g, ''),
          server_id: `\${azurerm_postgresql_flexible_server.${id}.id}`,
        });
        ctx.outputs[`${id}_fqdn`] = { value: `\${azurerm_postgresql_flexible_server.${id}.fqdn}` };
      }
      return true;
    }

    case 'Database.Redis':
    case 'Cache.Redis': {
      addRes(ctx, 'azurerm_redis_cache', id, {
        name: `${id.replace(/_/g, '-')}-redis`.slice(0, 63),
        resource_group_name: rg,
        location: loc,
        capacity: 0,
        family: 'C',
        sku_name: 'Basic',
        enable_non_ssl_port: false,
        minimum_tls_version: '1.2',
      });
      ctx.outputs[`${id}_hostname`] = { value: `\${azurerm_redis_cache.${id}.hostname}` };
      ctx.outputs[`${id}_ssl_port`] = { value: `\${tostring(azurerm_redis_cache.${id}.ssl_port)}` };
      ctx.outputs[`${id}_key`] = { value: `\${azurerm_redis_cache.${id}.primary_access_key}`, sensitive: true };
      return true;
    }

    default:
      return false;
  }
}
