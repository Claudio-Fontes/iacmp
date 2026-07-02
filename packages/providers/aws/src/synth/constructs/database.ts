import { BaseConstruct, databaseDefaultsForTier } from '@iacmp/core';
import type { CloudFormationResource, SynthContext } from '../types';
import { resolveSubnetId, resolveSecurityGroupId } from '../resolvers';

const CACHE_NODE_TYPE_MAP: Record<string, string> = {
  small: 'cache.t3.micro',
  medium: 'cache.t3.medium',
  large: 'cache.r6g.large',
};

export function synthDatabase(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> | null {
  const props = construct.props as Record<string, unknown>;
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  switch (construct.type) {
    case 'Database.SQL': {
      const engine = props.engine as string;
      const edition = (props.edition as string) ?? '';
      const isAurora = engine === 'aurora-mysql' || engine === 'aurora-postgresql';

      // Aurora → DBCluster + DBInstance(s); demais → DBInstance single
      if (isAurora) {
        const auroraEngineMap: Record<string, { Engine: string; EngineVersion: string }> = {
          'aurora-mysql':      { Engine: 'aurora-mysql',      EngineVersion: '8.0.mysql_aurora.3.08.0' },
          'aurora-postgresql': { Engine: 'aurora-postgresql', EngineVersion: '16.6' },
        };
        const auroraEngine = auroraEngineMap[engine];
        const masterUser = 'dbadmin';
        const auroraSecretId = `${logicalId}Secret`;
        const clusterLogicalId = `${logicalId}Cluster`;
        const subnetIds = props.subnetIds as string[] | undefined;
        const instances = (props.instances as number) ?? 1;
        const deletionPolicy = (props.deletionProtection as boolean) ? 'Retain' : 'Snapshot';

        const auroraEntries: Array<[string, CloudFormationResource]> = [];

        auroraEntries.push([auroraSecretId, {
          Type: 'AWS::SecretsManager::Secret',
          Properties: {
            Name: `${ctx.currentStackName}-${construct.id}-aurora-password`,
            GenerateSecretString: {
              SecretStringTemplate: JSON.stringify({ username: masterUser }),
              GenerateStringKey: 'password',
              PasswordLength: 32,
              ExcludeCharacters: '"@/\\\'',
            },
          },
        }]);

        if (subnetIds && subnetIds.length > 0) {
          const subnetGroupId = `${logicalId}SubnetGroup`;
          auroraEntries.push([subnetGroupId, {
            Type: 'AWS::RDS::DBSubnetGroup',
            Properties: {
              DBSubnetGroupDescription: `Subnet group Aurora para ${construct.id}`,
              SubnetIds: subnetIds.map(id => resolveSubnetId(id, ctx)),
            },
          }]);

          const clusterProps: Record<string, unknown> = {
            DBClusterIdentifier: construct.id.toLowerCase(),
            Engine: auroraEngine.Engine,
            EngineVersion: auroraEngine.EngineVersion,
            MasterUsername: masterUser,
            MasterUserPassword: { 'Fn::Sub': `{{resolve:secretsmanager:\${${auroraSecretId}}:SecretString:password}}` },
            DBSubnetGroupName: { Ref: subnetGroupId },
            StorageEncrypted: (props.storageEncrypted as boolean) ?? true,
            BackupRetentionPeriod: (props.backupRetentionDays as number) ?? 7,
            DeletionProtection: (props.deletionProtection as boolean) ?? false,
            ...(props.securityGroupIds ? { VpcSecurityGroupIds: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
          };

          auroraEntries.push([clusterLogicalId, {
            Type: 'AWS::RDS::DBCluster',
            DeletionPolicy: deletionPolicy,
            Properties: clusterProps,
          }]);
        } else {
          // Sem subnets — cria cluster sem SubnetGroup (usa VPC default da conta)
          auroraEntries.push([clusterLogicalId, {
            Type: 'AWS::RDS::DBCluster',
            DeletionPolicy: deletionPolicy,
            Properties: {
              DBClusterIdentifier: construct.id.toLowerCase(),
              Engine: auroraEngine.Engine,
              EngineVersion: auroraEngine.EngineVersion,
              MasterUsername: masterUser,
              MasterUserPassword: { 'Fn::Sub': `{{resolve:secretsmanager:\${${auroraSecretId}}:SecretString:password}}` },
              StorageEncrypted: (props.storageEncrypted as boolean) ?? true,
              BackupRetentionPeriod: (props.backupRetentionDays as number) ?? 7,
              DeletionProtection: (props.deletionProtection as boolean) ?? false,
            },
          }]);
        }

        const instanceClass = (props.instanceType as string) ?? 'db.t3.medium';
        for (let i = 1; i <= instances; i++) {
          const instanceLogicalId = i === 1 ? logicalId : `${logicalId}Instance${i}`;
          auroraEntries.push([instanceLogicalId, {
            Type: 'AWS::RDS::DBInstance',
            DeletionPolicy: deletionPolicy,
            Properties: {
              DBClusterIdentifier: { Ref: clusterLogicalId },
              DBInstanceClass: instanceClass,
              Engine: auroraEngine.Engine,
            },
          }]);
        }

        return auroraEntries;
      }

      // ── RDS single-instance (mysql, postgres, mariadb, oracle, sqlserver) ──
      const engineMap: Record<string, { Engine: string; EngineVersion: string }> = {
        mysql:     { Engine: 'mysql',                                    EngineVersion: '8.0.46' },
        postgres:  { Engine: 'postgres',                                 EngineVersion: '17.10' },
        mariadb:   { Engine: 'mariadb',                                  EngineVersion: '11.8.8' },
        oracle:    { Engine: `oracle-${edition || 'se2'}`,               EngineVersion: '19.0.0.0.ru-2024-01.rur-2024-01.r1' },
        sqlserver: { Engine: `sqlserver-${edition || 'ex'}`,             EngineVersion: '15.00.4365.2.v1' },
      };
      const mapped = engineMap[engine] ?? engineMap['mysql'];

      const isOracle    = engine === 'oracle';
      const isSqlServer = engine === 'sqlserver';
      const licenseModel = (props.licenseModel as string)
        ?? (isOracle || isSqlServer ? 'license-included' : undefined);

      const masterUser = isSqlServer ? 'sqladmin' : 'dbadmin';
      const defaultInstance = (isOracle || isSqlServer) ? 'db.t3.small' : 'db.t3.micro';

      // Defaults DERIVADOS do tier da conta (free vs standard) — o usuário não
      // precisa mais escrever backupRetentionDays/storageEncrypted no .ts. Props
      // explícitas sempre vencem o default do tier.
      const dbDefaults = databaseDefaultsForTier(ctx.profile.accountTier);

      const rdsSecretId = `${logicalId}Secret`;
      const rdsProps: Record<string, unknown> = {
        DBInstanceClass:       (props.instanceType as string) ?? defaultInstance,
        Engine:                mapped.Engine,
        EngineVersion:         mapped.EngineVersion,
        AllocatedStorage:      String(props.storageGb ?? 20),
        MultiAZ:               (props.multiAz as boolean) ?? false,
        MasterUsername:        masterUser,
        MasterUserPassword:    { 'Fn::Sub': `{{resolve:secretsmanager:\${${rdsSecretId}}:SecretString:password}}` },
        StorageEncrypted:      (props.storageEncrypted as boolean) ?? dbDefaults.storageEncrypted,
        BackupRetentionPeriod: props.backupRetentionDays ?? dbDefaults.backupRetentionDays,
        DeletionProtection:    (props.deletionProtection as boolean) ?? false,
      };
      if (licenseModel) rdsProps['LicenseModel'] = licenseModel;

      const sqlSubnetIds = props.subnetIds as string[] | undefined;
      const sqlEntries: Array<[string, CloudFormationResource]> = [];
      sqlEntries.push([rdsSecretId, {
        Type: 'AWS::SecretsManager::Secret',
        Properties: {
          Name: `${ctx.currentStackName}-${construct.id}-db-password`,
          GenerateSecretString: {
            SecretStringTemplate: JSON.stringify({ username: masterUser }),
            GenerateStringKey: 'password',
            PasswordLength: 32,
            ExcludeCharacters: '"@/\\\'',
          },
        },
      }]);
      if (sqlSubnetIds && sqlSubnetIds.length > 0) {
        const subnetGroupId = `${logicalId}SubnetGroup`;
        sqlEntries.push([subnetGroupId, {
          Type: 'AWS::RDS::DBSubnetGroup',
          Properties: {
            DBSubnetGroupDescription: `Subnet group para ${construct.id}`,
            SubnetIds: sqlSubnetIds.map(id => resolveSubnetId(id, ctx)),
          },
        }]);
        rdsProps['DBSubnetGroupName'] = { Ref: subnetGroupId };
        if (props.securityGroupIds) rdsProps['VPCSecurityGroups'] = (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx));
      }

      sqlEntries.push([logicalId, {
        Type: 'AWS::RDS::DBInstance',
        DeletionPolicy: (props.deletionProtection as boolean) ? 'Retain' : ((props.snapshotOnDelete as boolean) ? 'Snapshot' : 'Delete'),
        Properties: rdsProps,
      }]);
      return sqlEntries;
    }

    case 'Database.DocumentDB': {
      const instances = (props.instances as number) ?? 1;
      const clusterLogicalId = `${logicalId}Cluster`;
      const docDbSubnetIds = props.subnetIds as string[] | undefined;
      const entries: Array<[string, CloudFormationResource]> = [];

      const docDbSecretId = `${logicalId}Secret`;
      entries.push([docDbSecretId, {
        Type: 'AWS::SecretsManager::Secret',
        Properties: {
          Name: `${ctx.currentStackName}-${construct.id}-docdb-password`,
          GenerateSecretString: {
            SecretStringTemplate: JSON.stringify({ username: 'docdbadmin' }),
            GenerateStringKey: 'password',
            PasswordLength: 32,
            ExcludeCharacters: '"@/\\\'',
          },
        },
      }]);
      const docDbClusterProps: Record<string, unknown> = {
        DBClusterIdentifier: construct.id.toLowerCase(),
        MasterUsername: 'docdbadmin',
        MasterUserPassword: { 'Fn::Sub': `{{resolve:secretsmanager:\${${docDbSecretId}}:SecretString:password}}` },
        StorageEncrypted: true,
        BackupRetentionPeriod: (props.backupRetentionDays as number) ?? 1,
        DeletionProtection: (props.deletionProtection as boolean) ?? false,
      };
      if (docDbSubnetIds && docDbSubnetIds.length > 0) {
        const subnetGroupId = `${clusterLogicalId}SubnetGroup`;
        entries.push([subnetGroupId, {
          Type: 'AWS::DocDB::DBSubnetGroup',
          Properties: {
            DBSubnetGroupDescription: `Subnet group para ${construct.id}`,
            SubnetIds: docDbSubnetIds.map(id => resolveSubnetId(id, ctx)),
          },
        }]);
        docDbClusterProps['DBSubnetGroupName'] = { Ref: subnetGroupId };
        if (props.securityGroupIds) docDbClusterProps['VpcSecurityGroupIds'] = (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx));
      }

      entries.push([clusterLogicalId, {
        Type: 'AWS::DocDB::DBCluster',
        DeletionPolicy: (props.deletionProtection as boolean) ? 'Retain' : ((props.snapshotOnDelete as boolean) ? 'Snapshot' : 'Delete'),
        Properties: docDbClusterProps,
      }]);
      for (let i = 0; i < instances; i++) {
        entries.push([`${logicalId}Instance${i + 1}`, {
          Type: 'AWS::DocDB::DBInstance',
          Properties: {
            DBClusterIdentifier: { Ref: clusterLogicalId },
            DBInstanceClass: (props.instanceType as string) ?? 'db.t3.medium',
            DBInstanceIdentifier: `${construct.id.toLowerCase()}-${i + 1}`,
          },
        }]);
      }
      return entries;
    }

    case 'Database.DynamoDB': {
      const billingMode = (props.billingMode as string) ?? 'PAY_PER_REQUEST';
      const gsis = (props.globalSecondaryIndexes as Array<Record<string, unknown>>) ?? [];
      const attrDefs = [
        { AttributeName: props.partitionKey as string, AttributeType: (props.partitionKeyType as string) ?? 'S' },
        ...(props.sortKey ? [{ AttributeName: props.sortKey as string, AttributeType: (props.sortKeyType as string) ?? 'S' }] : []),
        ...gsis.map(g => ({ AttributeName: g.partitionKey as string, AttributeType: (g.partitionKeyType as string) ?? 'S' })),
        ...gsis.filter(g => g.sortKey).map(g => ({ AttributeName: g.sortKey as string, AttributeType: (g.sortKeyType as string) ?? 'S' })),
      ].filter((v, i, a) => a.findIndex(x => x.AttributeName === v.AttributeName) === i);

      return [[logicalId, {
        Type: 'AWS::DynamoDB::Table',
        DeletionPolicy: 'Retain',
        Properties: {
          TableName: construct.id,
          BillingMode: billingMode,
          ...(billingMode === 'PROVISIONED' ? {
            ProvisionedThroughput: { ReadCapacityUnits: props.readCapacity ?? 5, WriteCapacityUnits: props.writeCapacity ?? 5 },
          } : {}),
          AttributeDefinitions: attrDefs,
          KeySchema: [
            { AttributeName: props.partitionKey as string, KeyType: 'HASH' },
            ...(props.sortKey ? [{ AttributeName: props.sortKey as string, KeyType: 'RANGE' }] : []),
          ],
          ...(gsis.length > 0 ? {
            GlobalSecondaryIndexes: gsis.map(g => ({
              IndexName: g.name as string,
              KeySchema: [
                { AttributeName: g.partitionKey as string, KeyType: 'HASH' },
                ...(g.sortKey ? [{ AttributeName: g.sortKey as string, KeyType: 'RANGE' }] : []),
              ],
              Projection: { ProjectionType: 'ALL' },
              ...(billingMode === 'PROVISIONED' ? {
                ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
              } : {}),
            })),
          } : {}),
          ...(props.ttlAttribute ? { TimeToLiveSpecification: { AttributeName: props.ttlAttribute, Enabled: true } } : {}),
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: (props.pointInTimeRecovery as boolean) ?? true },
          ...(props.streamEnabled ? { StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' } } : {}),
        },
      }]];
    }

    case 'Cache.Redis': {
      const numNodes = (props.numCacheNodes as number) ?? 1;
      const autoFailover = (props.automaticFailoverEnabled as boolean) ?? false;
      const redisSubnetIds = props.subnetIds as string[] | undefined;
      const redisEntries: Array<[string, CloudFormationResource]> = [];

      // Cria o CacheSubnetGroup a partir de subnetIds (como Memcached). Sem isso,
      // passar um id de subnet direto em CacheSubnetGroupName falha no deploy —
      // ElastiCache exige um SubnetGroup, não uma subnet.
      let cacheSubnetGroupName: unknown;
      if (redisSubnetIds && redisSubnetIds.length > 0) {
        const subnetGroupId = `${logicalId}SubnetGroup`;
        redisEntries.push([subnetGroupId, {
          Type: 'AWS::ElastiCache::SubnetGroup',
          Properties: {
            Description: `Subnet group para ${construct.id}`,
            SubnetIds: redisSubnetIds.map(id => resolveSubnetId(id, ctx)),
          },
        }]);
        cacheSubnetGroupName = { Ref: subnetGroupId };
      } else if (props.subnetGroupName) {
        cacheSubnetGroupName = props.subnetGroupName;
      }

      redisEntries.push([logicalId, {
        Type: 'AWS::ElastiCache::ReplicationGroup',
        Properties: {
          ReplicationGroupDescription: `Redis ${construct.id}`,
          ReplicationGroupId: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
          CacheNodeType: CACHE_NODE_TYPE_MAP[(props.nodeType as string) ?? 'small'] ?? 'cache.t3.micro',
          Engine: 'redis',
          EngineVersion: (props.version as string) ?? '7.0',
          NumCacheClusters: numNodes,
          AutomaticFailoverEnabled: autoFailover && numNodes > 1,
          AtRestEncryptionEnabled: (props.atRestEncryptionEnabled as boolean) ?? true,
          TransitEncryptionEnabled: (props.transitEncryptionEnabled as boolean) ?? true,
          ...(cacheSubnetGroupName ? { CacheSubnetGroupName: cacheSubnetGroupName } : {}),
          ...(props.securityGroupIds ? { SecurityGroupIds: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
        },
      }]);
      return redisEntries;
    }

    case 'Cache.Memcached': {
      const memSubnetIds = props.subnetIds as string[] | undefined;
      const memEntries: Array<[string, CloudFormationResource]> = [];
      const memProps: Record<string, unknown> = {
        ClusterName: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
        Engine: 'memcached',
        CacheNodeType: CACHE_NODE_TYPE_MAP[(props.nodeType as string) ?? 'small'] ?? 'cache.t3.micro',
        NumCacheNodes: (props.numCacheNodes as number) ?? 2,
      };
      if (memSubnetIds && memSubnetIds.length > 0) {
        const subnetGroupId = `${logicalId}SubnetGroup`;
        memEntries.push([subnetGroupId, {
          Type: 'AWS::ElastiCache::SubnetGroup',
          Properties: {
            Description: `Subnet group para ${construct.id}`,
            SubnetIds: memSubnetIds.map(id => resolveSubnetId(id, ctx)),
          },
        }]);
        memProps['CacheSubnetGroupName'] = { Ref: subnetGroupId };
        if (props.securityGroupIds) memProps['VpcSecurityGroupIds'] = (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx));
      } else {
        if (props.subnetGroupName) memProps['CacheSubnetGroupName'] = props.subnetGroupName;
        if (props.securityGroupIds) memProps['VpcSecurityGroupIds'] = (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx));
      }
      memEntries.push([logicalId, {
        Type: 'AWS::ElastiCache::CacheCluster',
        Properties: memProps,
      }]);
      return memEntries;
    }

    case 'Secret.Vault': {
      return [[logicalId, {
        Type: 'AWS::SecretsManager::Secret',
        Properties: {
          Name: construct.id,
          Description: (props.description as string) ?? `Secret ${construct.id}`,
          ...(props.kmsKeyId ? { KmsKeyId: props.kmsKeyId } : {}),
          ...(props.replicaRegions ? { ReplicaRegions: (props.replicaRegions as string[]).map(r => ({ Region: r })) } : {}),
        },
      }]];
    }

    case 'Certificate.TLS': {
      const sans = (props.subjectAlternativeNames as string[]) ?? [];
      return [[logicalId, {
        Type: 'AWS::CertificateManager::Certificate',
        Properties: {
          DomainName: props.domainName as string,
          ValidationMethod: (props.validationMethod as string) ?? 'DNS',
          ...(sans.length > 0 ? { SubjectAlternativeNames: sans } : {}),
          Tags: [{ Key: 'Name', Value: construct.id }],
        },
      }]];
    }

    default: return null;
  }
}
