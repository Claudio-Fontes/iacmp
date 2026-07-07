import { BaseConstruct } from '@iacmp/core';
import { expr, tag, toSym, crossParamName, SynthContext } from './shared';

export function synthesizeMessaging(construct: BaseConstruct, ctx: SynthContext): void {
  const { resources, outputs } = ctx;
  const props = (construct.props ?? {}) as Record<string, unknown>;
  const sym = toSym(construct.id);

  switch (construct.type) {
    case 'Messaging.Queue': {
      const sbQPfx = construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'sb';
      const nsName = expr(`'${sbQPfx}-\${uniqueString(resourceGroup().id)}'`);
      const nsSym = `${sym}Ns`;
      const qSym = `${sym}Queue`;
      resources.push({ sym: nsSym, type: 'Microsoft.ServiceBus/namespaces', apiVersion: '2022-10-01-preview', name: nsName, location: 'location', tags: tag(construct.id), sku: { name: 'Standard', tier: 'Standard' }, properties: {} });
      resources.push({ sym: qSym, type: 'Microsoft.ServiceBus/namespaces/queues', apiVersion: '2022-10-01-preview', parent: nsSym, name: construct.id, properties: { lockDuration: `PT${(props.visibilityTimeoutSeconds as number) ?? 30}S`, maxSizeInMegabytes: 1024, requiresDuplicateDetection: false, requiresSession: false, defaultMessageTimeToLive: `P${Math.floor(((props.messageRetentionSeconds as number) ?? 345600) / 86400)}D`, deadLetteringOnMessageExpiration: false } });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${nsSym}.id` });
      outputs.push({ name: crossParamName(construct.id, 'Url'), type: 'string', value: `'sb://\${${nsSym}.name}.servicebus.windows.net/'` });
      outputs.push({ name: crossParamName(construct.id, 'ConnectionString'), type: 'string', value: `listKeys(resourceId('Microsoft.ServiceBus/namespaces/authorizationRules', ${nsSym}.name, 'RootManageSharedAccessKey'), '2022-10-01-preview').primaryConnectionString` });
      break;
    }

    case 'Messaging.Stream': {
      const nsName = `${construct.id.toLowerCase()}-ns`;
      const nsSym = `${sym}Ns`;
      resources.push({
        sym: nsSym, type: 'Microsoft.EventHub/namespaces', apiVersion: '2022-10-01-preview',
        name: nsName, location: 'location', tags: tag(construct.id),
        sku: { name: 'Standard', tier: 'Standard', capacity: 1 }, properties: {}
      });
      resources.push({
        sym, type: 'Microsoft.EventHub/namespaces/eventhubs', apiVersion: '2022-10-01-preview',
        parent: nsSym, name: construct.id,
        properties: {
          messageRetentionInDays: Math.ceil(((props.retentionHours as number) ?? 24) / 24),
          partitionCount: (props.shardCount as number) ?? 2
        }
      });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${sym}.id` });
      outputs.push({ name: `${construct.id}Name`, type: 'string', value: `'${construct.id}'` });
      break;
    }

    case 'Messaging.Topic': {
      const sbTPfx = construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'sb';
      const nsName = expr(`'${sbTPfx}-\${uniqueString(resourceGroup().id)}'`);
      const nsSym = `${sym}Ns`;
      const topicSym = `${sym}Topic`;
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];
      resources.push({ sym: nsSym, type: 'Microsoft.ServiceBus/namespaces', apiVersion: '2022-10-01-preview', name: nsName, location: 'location', tags: tag(construct.id), sku: { name: 'Standard', tier: 'Standard' }, properties: {} });
      resources.push({ sym: topicSym, type: 'Microsoft.ServiceBus/namespaces/topics', apiVersion: '2022-10-01-preview', parent: nsSym, name: construct.id, properties: { defaultMessageTimeToLive: 'P14D', requiresDuplicateDetection: false } });
      subscriptions.forEach((s, i) => {
        const subName = ((s.name as string) || (s.endpoint as string) || `sub-${i}`).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        const subProps: Record<string, unknown> = { lockDuration: 'PT30S', deadLetteringOnMessageExpiration: false };
        resources.push({ sym: `${sym}Sub${i}`, type: 'Microsoft.ServiceBus/namespaces/topics/subscriptions', apiVersion: '2022-10-01-preview', parent: topicSym, name: subName, properties: subProps });
      });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${nsSym}.id` });
      outputs.push({ name: `${construct.id}ConnectionString`, type: 'string', value: `listKeys(resourceId('Microsoft.ServiceBus/namespaces/authorizationRules', ${nsSym}.name, 'RootManageSharedAccessKey'), '2022-10-01-preview').primaryConnectionString` });
      break;
    }
  }
}
