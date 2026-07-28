import { BaseConstruct } from '@iacmp/core';
import { AzureTFCtx, addRes, toTFId, RG_NAME, RG_LOCATION } from '../common';

/** Messaging.Queue/Topic → Service Bus; Messaging.Stream → Event Hubs. */
export function synthMessaging(c: BaseConstruct, ctx: AzureTFCtx): boolean {
  const p = (c.props ?? {}) as Record<string, unknown>;
  const id = toTFId(c.id);
  const rg = RG_NAME;
  const loc = RG_LOCATION;

  switch (c.type) {
    case 'Messaging.Queue': {
      const nsId = `${id}_ns`;
      addRes(ctx, 'azurerm_servicebus_namespace', nsId, {
        name: `${id.replace(/_/g, '-')}-ns`.slice(0, 50),
        resource_group_name: rg,
        location: loc,
        sku: 'Standard',
      });
      addRes(ctx, 'azurerm_servicebus_queue', id, {
        name: id.replace(/_/g, '-'),
        namespace_id: `\${azurerm_servicebus_namespace.${nsId}.id}`,
      });
      ctx.outputs[`${id}_name`] = { value: `\${azurerm_servicebus_queue.${id}.name}` };
      ctx.outputs[`${id}_connection_string`] = {
        value: `\${azurerm_servicebus_namespace.${nsId}.default_primary_connection_string}`,
        sensitive: true,
      };
      return true;
    }

    case 'Messaging.Topic': {
      const nsId = `${id}_ns`;
      addRes(ctx, 'azurerm_servicebus_namespace', nsId, {
        name: `${id.replace(/_/g, '-')}-ns`.slice(0, 50),
        resource_group_name: rg,
        location: loc,
        sku: 'Standard',
      });
      addRes(ctx, 'azurerm_servicebus_topic', id, {
        name: id.replace(/_/g, '-'),
        namespace_id: `\${azurerm_servicebus_namespace.${nsId}.id}`,
      });
      const subs = (p.subscriptions as Array<{ protocol: string; endpoint: string }>) ?? [];
      for (let i = 0; i < subs.length; i++) {
        const subName = (subs[i].protocol ?? `sub${i}`).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);
        addRes(ctx, 'azurerm_servicebus_subscription', `${id}_sub${i}`, {
          name: subName,
          topic_id: `\${azurerm_servicebus_topic.${id}.id}`,
          max_delivery_count: 10,
        });
      }
      ctx.outputs[`${id}_name`] = { value: `\${azurerm_servicebus_topic.${id}.name}` };
      ctx.outputs[`${id}_connection_string`] = {
        value: `\${azurerm_servicebus_namespace.${nsId}.default_primary_connection_string}`,
        sensitive: true,
      };
      return true;
    }

    case 'Messaging.Stream': {
      const nsId = `${id}_eh_ns`;
      addRes(ctx, 'azurerm_eventhub_namespace', nsId, {
        name: `${id.replace(/_/g, '-')}-ehns`.slice(0, 50),
        resource_group_name: rg,
        location: loc,
        sku: 'Standard',
        capacity: 1,
      });
      addRes(ctx, 'azurerm_eventhub', id, {
        name: id.replace(/_/g, '-'),
        namespace_name: `\${azurerm_eventhub_namespace.${nsId}.name}`,
        resource_group_name: rg,
        partition_count: (p.shards as number) ?? 2,
        message_retention: 1,
      });
      ctx.outputs[`${id}_name`] = { value: `\${azurerm_eventhub.${id}.name}` };
      ctx.outputs[`${id}_connection_string`] = {
        value: `\${azurerm_eventhub_namespace.${nsId}.default_primary_connection_string}`,
        sensitive: true,
      };
      return true;
    }

    default:
      return false;
  }
}
