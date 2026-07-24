import { BaseConstruct } from '@iacmp/core';
import { TFOutput, toTfId, addResource } from './common.js';

export function synthMessaging(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Messaging.Queue': {
      addResource(r, 'google_pubsub_topic', id, {
        name: construct.id,
        message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
      });
      addResource(r, 'google_pubsub_subscription', `${id}_sub`, {
        name: `${construct.id}-sub`,
        topic: `\${google_pubsub_topic.${id}.id}`,
        ack_deadline_seconds: (props.visibilityTimeoutSeconds as number) ?? 30,
        message_retention_duration: `${(props.messageRetentionSeconds as number) ?? 345600}s`,
      });
      return true;
    }

    case 'Messaging.Topic': {
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];
      addResource(r, 'google_pubsub_topic', id, {
        name: construct.id,
        message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
      });
      subscriptions.forEach((s, i) => {
        const subProps: Record<string, unknown> = {
          name: `${construct.id}-sub-${i}`,
          topic: `\${google_pubsub_topic.${id}.id}`,
          ack_deadline_seconds: 30,
        };
        if (s.protocol === 'https' || s.protocol === 'http') {
          subProps.push_config = [{ push_endpoint: s.endpoint }];
        } else if (s.protocol === 'lambda') {
          subProps.push_config = [{ push_endpoint: `\${google_cloudfunctions2_function.${toTfId(s.endpoint)}.service_config[0].uri}` }];
        }
        addResource(r, 'google_pubsub_subscription', `${id}_sub_${i}`, subProps);
      });
      return true;
    }

    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const busName = props.busName as string | undefined;
      if (busName && busName !== 'default') {
        const busId = toTfId(busName);
        addResource(r, 'google_pubsub_topic', busId, {
          name: busName,
          message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
        });
      }
      for (const rule of rules) {
        const topicName = `${construct.id}-${(rule.name as string) ?? 'rule'}`;
        const topicId = toTfId(topicName);
        addResource(r, 'google_pubsub_topic', topicId, {
          name: topicName,
          message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
        });
        if (rule.targetArn) {
          addResource(r, 'google_pubsub_subscription', `${topicId}_sub`, {
            name: `${topicName}-sub`,
            topic: `\${google_pubsub_topic.${topicId}.id}`,
            push_config: [{ push_endpoint: rule.targetArn as string }],
            ack_deadline_seconds: 30,
          });
        }
      }
      return true;
    }

    default:
      return false;
  }
}
