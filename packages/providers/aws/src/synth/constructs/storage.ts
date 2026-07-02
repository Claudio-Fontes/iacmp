import { BaseConstruct } from '@iacmp/core';
import type { CloudFormationResource, SynthContext } from '../types';
import { resolveLambdaArnRef } from '../resolvers';

export function synthStorage(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> | null {
  const props = construct.props as Record<string, unknown>;
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  switch (construct.type) {
    case 'Storage.Bucket': {
      const lifecycleRules = (props.lifecycleRules as Array<Record<string, unknown>>) ?? [];
      const isWebsite = (props.websiteHosting as boolean) ?? false;
      // websiteHosting implica acesso público — sobrescreve publicAccess
      const isPublic = isWebsite || ((props.publicAccess as boolean) ?? false);

      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::S3::Bucket',
        DeletionPolicy: 'Retain',
        Properties: {
          ...(props.bucketName ? { BucketName: props.bucketName as string } : {}),
          VersioningConfiguration: props.versioning ? { Status: 'Enabled' } : { Status: 'Suspended' },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: !isPublic,
            BlockPublicPolicy: !isPublic,
            IgnorePublicAcls: !isPublic,
            RestrictPublicBuckets: !isPublic,
          },
          ...(isWebsite ? {
            WebsiteConfiguration: { IndexDocument: 'index.html', ErrorDocument: 'index.html' },
          } : {}),
          ...(lifecycleRules.length > 0 ? {
            LifecycleConfiguration: {
              Rules: lifecycleRules.map((r, i) => ({
                Id: `rule-${i}`,
                Status: 'Enabled',
                ...(r.prefix ? { Prefix: r.prefix } : {}),
                ...(r.expireAfterDays ? { ExpirationInDays: r.expireAfterDays } : {}),
                ...(r.transitionToGlacierDays ? {
                  Transitions: [{ TransitionInDays: r.transitionToGlacierDays, StorageClass: 'GLACIER' }],
                } : {}),
              })),
            },
          } : {}),
          ...((props.cors as Array<Record<string, unknown>> | undefined)?.length ? {
            CorsConfiguration: {
              CorsRules: (props.cors as Array<Record<string, unknown>>).map(c => ({
                AllowedMethods: c.allowedMethods,
                AllowedOrigins: (c.allowedOrigins as string[]) ?? ['*'],
                AllowedHeaders: (c.allowedHeaders as string[]) ?? ['*'],
                ...(c.maxAgeSeconds !== undefined ? { MaxAge: c.maxAgeSeconds } : {}),
              })),
            },
          } : {}),
        },
      }]];

      // Notificações S3 → Lambda (ObjectCreated etc). Gera a NotificationConfiguration
      // no bucket + uma Lambda::Permission por Lambda. Usa SourceAccount (não SourceArn)
      // na permission pra NÃO referenciar o bucket e evitar a dependência circular
      // clássica do S3; o bucket faz DependsOn das permissions pra S3 aceitar a config.
      const notifications = (props.eventNotifications as Array<Record<string, unknown>> | undefined) ?? [];
      if (notifications.length > 0) {
        const lambdaConfigs: Array<Record<string, unknown>> = [];
        const dependsOn: string[] = [];
        notifications.forEach((n, ni) => {
          const lambdaId = n.lambdaId as string;
          if (!ctx.lambdaConstructs.has(lambdaId)) {
            throw new Error(`Storage.Bucket "${construct.id}": eventNotifications[${ni}].lambdaId "${lambdaId}" não é uma Fn.Lambda. Aponte para o id de uma Function.Lambda.`);
          }
          const fnArn = resolveLambdaArnRef(lambdaId, ctx);
          const events = (n.events as string[] | undefined) ?? ['s3:ObjectCreated:*'];
          const filterRules: Array<Record<string, string>> = [];
          if (n.prefix) filterRules.push({ Name: 'prefix', Value: n.prefix as string });
          if (n.suffix) filterRules.push({ Name: 'suffix', Value: n.suffix as string });
          for (const ev of events) {
            lambdaConfigs.push({
              Event: ev,
              Function: fnArn,
              ...(filterRules.length > 0 ? { Filter: { S3Key: { Rules: filterRules } } } : {}),
            });
          }
          const permId = `${logicalId}InvokePermission${ni}`;
          entries.push([permId, {
            Type: 'AWS::Lambda::Permission',
            Properties: {
              Action: 'lambda:InvokeFunction',
              FunctionName: fnArn,
              Principal: 's3.amazonaws.com',
              SourceAccount: { Ref: 'AWS::AccountId' },
            },
          }]);
          dependsOn.push(permId);
        });
        const bucketRes = entries[0][1];
        (bucketRes.Properties as Record<string, unknown>).NotificationConfiguration = { LambdaConfigurations: lambdaConfigs };
        bucketRes.DependsOn = dependsOn;
      }

      // BucketPolicy de leitura pública para website hosting
      if (isWebsite) {
        entries.push([`${logicalId}Policy`, {
          Type: 'AWS::S3::BucketPolicy',
          Properties: {
            Bucket: { Ref: logicalId },
            PolicyDocument: {
              Statement: [{
                Effect: 'Allow',
                Principal: '*',
                Action: 's3:GetObject',
                Resource: { 'Fn::Sub': `arn:aws:s3:::$\{${logicalId}}/*` },
              }],
            },
          },
        }]);
      }

      return entries;
    }

    case 'Storage.FileSystem': {
      const accessPoints = (props.accessPoints as Array<Record<string, unknown>>) ?? [];
      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::EFS::FileSystem',
        Properties: {
          PerformanceMode: (props.performanceMode as string) ?? 'generalPurpose',
          ThroughputMode: (props.throughputMode as string) ?? 'bursting',
          Encrypted: (props.encrypted as boolean) ?? true,
          LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }],
          FileSystemTags: [{ Key: 'Name', Value: construct.id }],
        },
      }]];

      for (const ap of accessPoints) {
        const apId = `${logicalId}AP${(ap.name as string).replace(/[^a-zA-Z0-9]/g, '')}`;
        entries.push([apId, {
          Type: 'AWS::EFS::AccessPoint',
          Properties: {
            FileSystemId: { Ref: logicalId },
            RootDirectory: { Path: ap.path as string },
            ...(ap.uid ? { PosixUser: { Uid: String(ap.uid), Gid: String(ap.gid ?? ap.uid) } } : {}),
            AccessPointTags: [{ Key: 'Name', Value: ap.name as string }],
          },
        }]);
      }
      return entries;
    }

    case 'Storage.Archive': {
      return [[logicalId, {
        Type: 'AWS::S3::Bucket',
        Properties: {
          LifecycleConfiguration: {
            Rules: [{
              Id: 'archive-rule',
              Status: 'Enabled',
              Transitions: [{ TransitionInDays: 0, StorageClass: 'DEEP_ARCHIVE' }],
              ...(props.retentionDays ? { ExpirationInDays: props.retentionDays } : {}),
            }],
          },
          ObjectLockEnabled: (props.lockEnabled as boolean) ?? false,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true, BlockPublicPolicy: true,
            IgnorePublicAcls: true, RestrictPublicBuckets: true,
          },
        },
      }]];
    }

    default: return null;
  }
}
