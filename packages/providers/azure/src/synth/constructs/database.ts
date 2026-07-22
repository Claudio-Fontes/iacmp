import { BaseConstruct } from '@iacmp/core';
import { expr, tag, toSym, crossParamName, outputName, SynthContext, resolveSubnetForVnetIntegration, cidrPrefixLength } from './shared';

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

      // Fim do silêncio: subnetIds/securityGroupIds em combinações que o provider
      // Azure ainda não traduz devem falhar o synth, nunca gerar infra pública
      // silenciosamente (era o bug: subnetIds era lido em lugar nenhum).
      const subnetIds = (props.subnetIds as string[] | undefined) ?? [];
      if (subnetIds.length > 0 && engine !== 'postgres') {
        throw new Error(
          `Database.SQL "${construct.id}": subnetIds só é suportado no provider Azure para engine 'postgres' ` +
          `(Postgres Flexible Server com VNet integration). Engine "${engine}" ainda não tem esse caminho ` +
          `implementado — troque para 'postgres' ou remova subnetIds.`,
        );
      }
      if (((props.securityGroupIds as string[] | undefined) ?? []).length > 0) {
        throw new Error(
          `Database.SQL "${construct.id}": securityGroupIds ainda não é suportado no provider Azure — o synth não ` +
          `anexa o Network.SecurityGroup à subnet delegada. Remova securityGroupIds (o tráfego dentro da VNet já ` +
          `é permitido; controle acesso externo pela topologia da subnet).`,
        );
      }

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
        const pgProperties: Record<string, unknown> = {
          administratorLogin: 'dbadmin',
          administratorLoginPassword: expr('adminPassword'),
          version: '15',
          storage: { storageSizeGB: pgStorageGB },
          backup: { backupRetentionDays: Math.max(Number(props.backupRetentionDays ?? 7), 7), geoRedundantBackup: 'Disabled' },
          highAvailability: { mode: zoneRedundant ? 'ZoneRedundant' : 'Disabled' },
        };

        let vnetDependsOn: string[] | undefined;
        if (subnetIds.length > 0) {
          const subnetId = subnetIds[0];
          if (subnetIds.length > 1) {
            console.warn(`[azure] Database.SQL "${construct.id}": Postgres Flexible Server aceita 1 subnet delegada; usando "${subnetId}" e ignorando as demais.`);
          }
          const resolved = resolveSubnetForVnetIntegration(subnetId, ctx);
          const prefix = cidrPrefixLength(resolved.cidr);
          if (prefix !== undefined && prefix > 28) {
            throw new Error(
              `Database.SQL "${construct.id}": subnet "${subnetId}" (${resolved.cidr}) é menor que /28 — Postgres ` +
              `Flexible Server exige subnet dedicada de no mínimo /28 (16 IPs).`,
            );
          }
          // Zone name no formato "<id>.private.postgres.database.azure.com" — a Azure exige
          // sufixo ".postgres.database.azure.com"; a forma de 2 rótulos evita a restrição de
          // "não pode ser igual ao nome do servidor" que a forma de 1 rótulo teria.
          const dnsZoneSym = `${sym}Dns`;
          const dnsLinkSym = `${sym}DnsLink`;
          resources.push({
            sym: dnsZoneSym,
            type: 'Microsoft.Network/privateDnsZones',
            apiVersion: '2020-06-01',
            name: `${construct.id.toLowerCase()}.private.postgres.database.azure.com`,
            location: "'global'",
            tags: tag(construct.id),
            properties: {},
          });
          resources.push({
            sym: dnsLinkSym,
            type: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks',
            apiVersion: '2020-06-01',
            parent: dnsZoneSym,
            name: `${construct.id.toLowerCase()}-link`,
            location: "'global'",
            properties: {
              registrationEnabled: false,
              virtualNetwork: { id: resolved.vpcResourceIdExpr },
            },
          });
          pgProperties.network = {
            delegatedSubnetResourceId: resolved.subnetResourceIdExpr,
            privateDnsZoneArmResourceId: expr(`${dnsZoneSym}.id`),
          };
          vnetDependsOn = [dnsLinkSym];
        }

        resources.push({
          sym,
          type: 'Microsoft.DBforPostgreSQL/flexibleServers',
          apiVersion: '2023-06-01-preview',
          name: serverName,
          location: 'location',
          tags: tag(construct.id),
          sku: dbSku,
          properties: pgProperties,
          ...(vnetDependsOn ? { dependsOn: vnetDependsOn } : {}),
        });
        // Com subnet delegada (VNet integration) o servidor não tem endpoint público —
        // NENHUMA firewall rule pública é criada nesse modo.
        if (subnetIds.length === 0) {
          resources.push({ ...fwRule, type: 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules', apiVersion: '2023-06-01-preview' });
        }
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
      // Azure: DynamoDB → Cosmos DB MongoDB API (não Table API)
      const dbName = `${construct.id.toLowerCase()}-db`;
      resources.push({
        sym,
        type: 'Microsoft.DocumentDB/databaseAccounts',
        apiVersion: '2023-04-15',
        name: expr(`'${construct.id.toLowerCase()}-\${uniqueString(resourceGroup().id)}'`),
        location: 'location',
        kind: 'MongoDB',
        tags: tag(construct.id),
        properties: {
          databaseAccountOfferType: 'Standard',
          apiProperties: { serverVersion: '4.2' },
          locations: [{ locationName: expr('location'), failoverPriority: 0, isZoneRedundant: false }],
          backupPolicy: { type: 'Periodic', periodicModeProperties: { backupIntervalInMinutes: 1440, backupRetentionIntervalInHours: 168 } },
        },
      });
      const dbSym = `${sym}Db`;
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
        name: construct.id.toLowerCase(),
        properties: { resource: { id: construct.id.toLowerCase() }, options: {} },
      });
      outputs.push({ name: outputName(construct.id, 'Endpoint'), type: 'string', value: `${sym}.properties.documentEndpoint` });
      outputs.push({ name: crossParamName(construct.id, 'Name'), type: 'string', value: `'${construct.id.toLowerCase()}'` });
      outputs.push({ name: crossParamName(construct.id, 'Arn'), type: 'string', value: `${sym}.id` });
      outputs.push({
        name: crossParamName(construct.id, 'ConnectionString'),
        type: 'string',
        value: `${sym}.listConnectionStrings().connectionStrings[0].connectionString`,
      });
      break;
    }
  }
}
