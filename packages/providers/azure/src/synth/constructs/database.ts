import { BaseConstruct } from '@iacmp/core';
import { expr, tag, toSym, crossParamName, outputName, SynthContext } from './shared';

function flexibleServerSku(accountTier: 'free' | 'standard'): { name: string; tier: string } {
  return accountTier === 'free'
    ? { name: 'Standard_B1ms', tier: 'Burstable' }
    : { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' };
}

export function synthesizeDatabase(construct: BaseConstruct, ctx: SynthContext): void {
  const { resources, outputs, needsAdminPassword, accountTier } = ctx;
  const props = (construct.props ?? {}) as Record<string, unknown>;
  const sym = toSym(construct.id);

  switch (construct.type) {
    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const serverName = `${construct.id.toLowerCase()}-server`;
      const storageBytes = (props.storageGb as number ?? 20) * 1024 * 1024 * 1024;
      const zoneRedundant = accountTier === 'free' ? false : ((props.multiAz as boolean) ?? false);
      const dbSku = flexibleServerSku(accountTier);
      needsAdminPassword.value = true;

      const fwRule = { sym: `${sym}Fw`, type: `${'x'}`, apiVersion: '', parent: sym, name: 'AllowAzure', properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' } };
      if (engine === 'mysql') {
        resources.push({ sym, type: 'Microsoft.DBforMySQL/flexibleServers', apiVersion: '2023-06-30', name: serverName, location: 'location', tags: tag(construct.id), sku: dbSku, properties: { administratorLogin: 'dbadmin', administratorLoginPassword: expr('adminPassword'), version: '8.0.21', storage: { storageSizeGB: props.storageGb ?? 20, autoGrow: 'Enabled' }, backup: { backupRetentionDays: Math.max(Number(props.backupRetentionDays ?? 7), 7), geoRedundantBackup: 'Disabled' }, highAvailability: { mode: zoneRedundant ? 'ZoneRedundant' : 'Disabled' } } });
        resources.push({ ...fwRule, type: 'Microsoft.DBforMySQL/flexibleServers/firewallRules', apiVersion: '2023-06-30' });
        outputs.push({ name: outputName(construct.id, 'Endpoint'), type: 'string', value: `${sym}.properties.fullyQualifiedDomainName` });
        outputs.push({ name: outputName(construct.id, 'Port'), type: 'string', value: `'3306'` });
        outputs.push({ name: outputName(construct.id, 'Username'), type: 'string', value: `'dbadmin'` });
        break;
      }
      if (engine === 'postgres') {
        const pgStorageRaw = Number(props.storageGb ?? 32);
        const pgStorageGB = pgStorageRaw < 32 ? 32 : pgStorageRaw;
        resources.push({ sym, type: 'Microsoft.DBforPostgreSQL/flexibleServers', apiVersion: '2023-06-01-preview', name: serverName, location: 'location', tags: tag(construct.id), sku: dbSku, properties: { administratorLogin: 'dbadmin', administratorLoginPassword: expr('adminPassword'), version: '15', storage: { storageSizeGB: pgStorageGB }, backup: { backupRetentionDays: Math.max(Number(props.backupRetentionDays ?? 7), 7), geoRedundantBackup: 'Disabled' }, highAvailability: { mode: zoneRedundant ? 'ZoneRedundant' : 'Disabled' } } });
        resources.push({ ...fwRule, type: 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules', apiVersion: '2023-06-01-preview' });
        outputs.push({ name: outputName(construct.id, 'Endpoint'), type: 'string', value: `${sym}.properties.fullyQualifiedDomainName` });
        outputs.push({ name: outputName(construct.id, 'Port'), type: 'string', value: `'5432'` });
        outputs.push({ name: outputName(construct.id, 'Username'), type: 'string', value: `'dbadmin'` });
        break;
      }
      if (engine === 'mariadb') {
        resources.push({ sym, type: 'Microsoft.DBforMariaDB/servers', apiVersion: '2018-06-01', name: serverName, location: 'location', tags: tag(construct.id), sku: { name: 'GP_Gen5_2', tier: 'GeneralPurpose', capacity: 2, family: 'Gen5' }, properties: { administratorLogin: 'mariadbadmin', administratorLoginPassword: expr('adminPassword'), version: '10.3', storageProfile: { storageMB: (props.storageGb as number ?? 20) * 1024, backupRetentionDays: Math.max(Number(props.backupRetentionDays ?? 7), 7), geoRedundantBackup: 'Disabled' } } });
        break;
      }
      if (engine === 'oracle') {
        resources.push({ sym, type: 'Oracle.Database/cloudExadataInfrastructures', apiVersion: '2023-09-01', name: serverName, location: 'location', tags: tag(construct.id), properties: { displayName: construct.id, shape: 'Exadata.X9M', computeCount: 2, storageCount: 3 } });
        break;
      }
      // sqlserver (default)
      const edition = (props.edition as string) ?? 'Standard';
      const dbSym = `${sym}Db`;
      resources.push({ sym, type: 'Microsoft.Sql/servers', apiVersion: '2023-02-01-preview', name: serverName, location: 'location', tags: tag(construct.id), properties: { administratorLogin: 'sqladmin', administratorLoginPassword: expr('adminPassword'), version: '12.0' } });
      resources.push({ sym: dbSym, type: 'Microsoft.Sql/servers/databases', apiVersion: '2023-02-01-preview', parent: sym, name: construct.id, location: 'location', sku: { name: edition === 'ee' ? 'BusinessCritical' : 'Standard', tier: edition === 'ee' ? 'BusinessCritical' : 'Standard' }, properties: { collation: 'SQL_Latin1_General_CP1_CI_AS', maxSizeBytes: storageBytes, zoneRedundant } });
      outputs.push({ name: outputName(construct.id, 'Endpoint'), type: 'string', value: `${sym}.properties.fullyQualifiedDomainName` });
      outputs.push({ name: outputName(construct.id, 'Port'), type: 'string', value: `'1433'` });
      outputs.push({ name: outputName(construct.id, 'Username'), type: 'string', value: `'sqladmin'` });
      break;
    }

    case 'Database.DocumentDB': {
      needsAdminPassword.value = true;
      resources.push({ sym, type: 'Microsoft.DocumentDB/databaseAccounts', apiVersion: '2023-04-15', name: expr(`'${construct.id.toLowerCase()}-\${uniqueString(resourceGroup().id)}'`), location: 'location', tags: tag(construct.id), properties: { databaseAccountOfferType: 'Standard', enableFreeTier: accountTier === 'free', kind: 'MongoDB', locations: [{ locationName: expr('location'), failoverPriority: 0, isZoneRedundant: false }], backupPolicy: { type: 'Periodic', periodicModeProperties: { backupIntervalInMinutes: 1440, backupRetentionIntervalInHours: 168 } }, enableAutomaticFailover: (props.deletionProtection as boolean) ?? false } });
      const dbSym = `${sym}Db`;
      const dbName = `${construct.id.toLowerCase()}-db`;
      resources.push({
        sym: dbSym,
        type: 'Microsoft.DocumentDB/databaseAccounts/mongodbDatabases',
        apiVersion: '2023-04-15',
        parent: sym,
        name: dbName,
        properties: { resource: { id: dbName }, options: {} },
      });
      resources.push({
        sym: `${sym}Coll`,
        type: 'Microsoft.DocumentDB/databaseAccounts/mongodbDatabases/collections',
        apiVersion: '2023-04-15',
        parent: dbSym,
        name: 'documents',
        properties: { resource: { id: 'documents' }, options: {} },
      });
      outputs.push({ name: crossParamName(construct.id, 'Endpoint'), type: 'string', value: `${sym}.properties.documentEndpoint` });
      outputs.push({ name: crossParamName(construct.id, 'ConnectionString'), type: 'string', value: `${sym}.listConnectionStrings().connectionStrings[0].connectionString` });
      break;
    }

    case 'Database.DynamoDB': {
      resources.push({
        sym,
        type: 'Microsoft.DocumentDB/databaseAccounts',
        apiVersion: '2023-04-15',
        name: expr(`'${construct.id.toLowerCase()}-\${uniqueString(resourceGroup().id)}'`),
        location: 'location',
        kind: 'GlobalDocumentDB',
        tags: tag(construct.id),
        properties: {
          databaseAccountOfferType: 'Standard',
          capabilities: [{ name: 'EnableTable' }],
          locations: [{ locationName: expr('location'), failoverPriority: 0, isZoneRedundant: false }],
          backupPolicy: { type: 'Periodic', periodicModeProperties: { backupIntervalInMinutes: 1440, backupRetentionIntervalInHours: 168 } },
        },
      });
      const tableSym = `${sym}Table`;
      resources.push({
        sym: tableSym,
        type: 'Microsoft.DocumentDB/databaseAccounts/tables',
        apiVersion: '2023-04-15',
        parent: sym,
        name: construct.id,
        properties: {
          resource: { id: construct.id },
          options: {},
        },
      });
      outputs.push({ name: outputName(construct.id, 'Endpoint'), type: 'string', value: `${sym}.properties.documentEndpoint` });
      outputs.push({ name: crossParamName(construct.id, 'Name'), type: 'string', value: `'${construct.id}'` });
      outputs.push({ name: crossParamName(construct.id, 'Arn'), type: 'string', value: `${sym}.id` });
      outputs.push({
        name: crossParamName(construct.id, 'ConnectionString'),
        type: 'string',
        value: `'DefaultEndpointsProtocol=https;AccountName=\${${sym}.name};AccountKey=\${${sym}.listKeys().primaryMasterKey};TableEndpoint=https://\${${sym}.name}.table.cosmos.azure.com:443/;'`,
      });
      break;
    }
  }
}
