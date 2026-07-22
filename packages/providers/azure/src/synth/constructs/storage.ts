import { BaseConstruct, isRef } from '@iacmp/core';
import type { Ref } from '@iacmp/core';
import { expr, tag, toSym, safeStorageName, crossParamName, outputName, SynthContext } from './shared';

export function synthesizeStorage(construct: BaseConstruct, ctx: SynthContext): void {
  const { resources, outputs, crossParams } = ctx;
  const props = (construct.props ?? {}) as Record<string, unknown>;
  const sym = toSym(construct.id);

  switch (construct.type) {
    case 'Storage.Bucket': {
      const safePfx = construct.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 11) || 'st';
      const storageNameExpr = expr(`'${safePfx}\${uniqueString(resourceGroup().id)}'`);
      // replication: 'geo' → RA-GRS: a plataforma replica para a região PAREADA
      // (par fixo do Azure, não configurável) e expõe endpoint secundário
      // somente-leitura — o equivalente idiomático (e free) do bucket de DR.
      const geoReplication = props.replication === 'geo';
      resources.push({
        sym,
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: storageNameExpr,
        location: 'location',
        kind: 'StorageV2',
        sku: { name: geoReplication ? 'Standard_RAGRS' : 'Standard_LRS' },
        tags: tag(construct.id),
        properties: {
          allowBlobPublicAccess: (props.publicAccess as boolean) ?? false,
          supportsHttpsTrafficOnly: true,
          minimumTlsVersion: 'TLS1_2',
        },
      });
      const corsRules = props.cors as Array<Record<string, unknown>> | undefined;
      if (props.versioning || (corsRules && corsRules.length > 0)) {
        const blobProps: Record<string, unknown> = {};
        if (props.versioning) blobProps.isVersioningEnabled = true;
        if (corsRules && corsRules.length > 0) {
          blobProps.cors = {
            corsRules: corsRules.map(c => ({
              allowedMethods: (c.allowedMethods as string[]) ?? ['GET'],
              allowedOrigins: (c.allowedOrigins as string[]) ?? ['*'],
              allowedHeaders: (c.allowedHeaders as string[]) ?? ['*'],
              exposedHeaders: (c.exposedHeaders as string[]) ?? ['*'],
              maxAgeInSeconds: (c.maxAgeSeconds as number) ?? 3600,
            })),
          };
        }
        resources.push({
          sym: `${sym}BlobService`,
          type: 'Microsoft.Storage/storageAccounts/blobServices',
          apiVersion: '2023-01-01',
          parent: sym,
          name: 'default',
          properties: blobProps,
        });
      }
      outputs.push({ name: outputName(construct.id, 'Id'), type: 'string', value: `${sym}.id` });
      outputs.push({ name: crossParamName(construct.id, 'Name'), type: 'string', value: `${sym}.name` });
      outputs.push({ name: crossParamName(construct.id, 'ConnectionString'), type: 'string', value: `'DefaultEndpointsProtocol=https;AccountName=\${${sym}.name};AccountKey=\${${sym}.listKeys().keys[0].value};EndpointSuffix=core.windows.net'` });
      // Static website — data-plane, impossível via ARM/Bicep. Emite outputs para que
      // o deploy.ts rode `az storage blob service-properties update` pós-deploy.
      const websiteHosting = props.websiteHosting;
      if (websiteHosting) {
        const wh = typeof websiteHosting === 'object' ? websiteHosting as Record<string, string> : {};
        const indexDoc = wh.indexDocument ?? 'index.html';
        const errorDoc = wh.errorDocument ?? '404.html';
        outputs.push({ name: outputName(construct.id, 'StaticWebsiteAccount'), type: 'string', value: `${sym}.name` });
        outputs.push({ name: outputName(construct.id, 'StaticWebsiteIndex'), type: 'string', value: `'${indexDoc}'` });
        outputs.push({ name: outputName(construct.id, 'StaticWebsite404'), type: 'string', value: `'${errorDoc}'` });
      }
      if (geoReplication) {
        // Endpoint de leitura da região pareada (RA-GRS) — o "bucket de DR".
        outputs.push({ name: crossParamName(construct.id, 'SecondaryEndpoint'), type: 'string', value: `${sym}.properties.secondaryEndpoints.blob` });
      }
      const eventNotifications = (props.eventNotifications as Array<Record<string, unknown>>) ?? [];
      if (eventNotifications.length > 0) {
        const topicSym = `${sym}EventTopic`;
        resources.push({
          sym: topicSym,
          type: 'Microsoft.EventGrid/systemTopics',
          apiVersion: '2022-06-15',
          name: `${safeStorageName(construct.id)}-evttopic`,
          location: 'location',
          tags: tag(construct.id),
          properties: {
            source: expr(`${sym}.id`),
            topicType: 'Microsoft.Storage.StorageAccounts',
          },
        });
        for (let ni = 0; ni < eventNotifications.length; ni++) {
          const notification = eventNotifications[ni];
          const lambdaIdRaw = notification.lambdaId;
          const lambdaId = isRef(lambdaIdRaw) ? (lambdaIdRaw as Ref).constructId : lambdaIdRaw as string;
          if (!lambdaId) continue;
          const lambdaConstruct = ctx.idx.get(lambdaId);
          const lambdaSym = toSym(lambdaId);
          let webhookUrl: string;
          let subCondition: string | undefined;
          if (lambdaConstruct) {
            if (lambdaConstruct.type === 'Function.Lambda') {
              webhookUrl = expr(`'https://\${${lambdaSym}.properties.defaultHostName}/events'`);
            } else {
              webhookUrl = expr(`'https://\${${lambdaSym}.properties.configuration.ingress.fqdn}/events'`);
            }
          } else {
            const fqdnParam = crossParamName(lambdaId, 'Fqdn');
            crossParams.set(fqdnParam, 'string:optional');
            webhookUrl = expr(`'https://\${${fqdnParam}}/events'`);
            subCondition = `!empty(${fqdnParam})`;
          }
          resources.push({
            sym: `${topicSym}Sub${ni}`,
            type: 'Microsoft.EventGrid/systemTopics/eventSubscriptions',
            apiVersion: '2022-06-15',
            parent: topicSym,
            name: `blob-created-${ni}`,
            ...(lambdaConstruct ? { dependsOn: [lambdaSym] } : {}),
            ...(subCondition ? { condition: subCondition } : {}),
            properties: {
              eventDeliverySchema: 'EventGridSchema',
              destination: {
                endpointType: 'WebHook',
                properties: { endpointUrl: webhookUrl },
              },
              filter: {
                includedEventTypes: ['Microsoft.Storage.BlobCreated'],
              },
            },
          });
        }
      }
      break;
    }

    case 'Storage.FileSystem': {
      const fsPfx = (construct.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 7) || 'fs') + 'sh';
      const storageNameExprFs = expr(`'${fsPfx}\${uniqueString(resourceGroup().id)}'`);
      const storageSym = `${sym}Storage`;
      const fileSvcSym = `${sym}FileService`;
      const shareSym = `${sym}Share`;
      resources.push({
        sym: storageSym,
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: storageNameExprFs,
        location: 'location',
        kind: 'StorageV2',
        sku: { name: 'Standard_LRS' },
        tags: tag(construct.id),
        properties: { supportsHttpsTrafficOnly: true },
      });
      resources.push({
        sym: fileSvcSym,
        type: 'Microsoft.Storage/storageAccounts/fileServices',
        apiVersion: '2023-01-01',
        parent: storageSym,
        name: 'default',
        properties: {},
      });
      resources.push({
        sym: shareSym,
        type: 'Microsoft.Storage/storageAccounts/fileServices/shares',
        apiVersion: '2023-01-01',
        parent: fileSvcSym,
        name: construct.id,
        properties: { shareQuota: 100, enabledProtocols: 'SMB', accessTier: 'Hot' },
      });
      break;
    }

    case 'Storage.Archive': {
      const storageName = safeStorageName(construct.id + 'arc');
      resources.push({
        sym,
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: storageName,
        location: 'location',
        kind: 'BlobStorage',
        sku: { name: 'Standard_LRS' },
        tags: tag(construct.id),
        properties: {
          accessTier: 'Archive',
          allowBlobPublicAccess: false,
          supportsHttpsTrafficOnly: true,
          minimumTlsVersion: 'TLS1_2',
        },
      });
      break;
    }
  }
}
