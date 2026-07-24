import { BaseConstruct } from '@iacmp/core';
import { TFOutput, toTfId, addResource } from './common.js';

export function synthMonitoring(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Monitoring.Alarm': {
      const dimensions = props.dimensions as Record<string, string> | undefined;
      const operatorMap: Record<string, string> = {
        GreaterThanThreshold: 'COMPARISON_GT',
        LessThanThreshold: 'COMPARISON_LT',
        GreaterThanOrEqualToThreshold: 'COMPARISON_GE',
        LessThanOrEqualToThreshold: 'COMPARISON_LE',
      };
      const dimFilter = dimensions
        ? Object.entries(dimensions).map(([k, v]) => `metric.labels.${k}="${v}"`).join(' AND ')
        : '';
      const filter = [
        `metric.type="cloudfunctions.googleapis.com/function/${props.metricName}"`,
        dimFilter,
      ].filter(Boolean).join(' AND ');

      const alarmActions = (props.alarmActions as string[]) ?? [];
      const notificationChannels = alarmActions.map((action, i) => {
        const topicId = toTfId(action.split('.')[0]);
        const channelId = `${id}_channel_${i}`;
        addResource(r, 'google_monitoring_notification_channel', channelId, {
          display_name: `${construct.id} channel ${i}`,
          type: 'pubsub',
          labels: { topic: `\${google_pubsub_topic.${topicId}.id}` },
        });
        return `\${google_monitoring_notification_channel.${channelId}.id}`;
      });

      addResource(r, 'google_monitoring_alert_policy', id, {
        display_name: construct.id,
        conditions: [{
          display_name: `${props.metricName} condition`,
          condition_threshold: [{
            filter,
            comparison: operatorMap[(props.comparisonOperator as string) ?? 'GreaterThanThreshold'] ?? 'COMPARISON_GT',
            threshold_value: props.threshold as number,
            duration: `${((props.periodSeconds as number) ?? 60) * ((props.evaluationPeriods as number) ?? 2)}s`,
            aggregations: [{
              alignment_period: `${(props.periodSeconds as number) ?? 60}s`,
              per_series_aligner: 'ALIGN_MEAN',
            }],
          }],
        }],
        combiner: 'OR',
        enabled: true,
        notification_channels: notificationChannels,
      });
      return true;
    }

    case 'Monitoring.Dashboard': {
      const widgets = (props.widgets as Array<Record<string, unknown>>) ?? [];
      const dashboardJson = JSON.stringify({
        displayName: construct.id,
        gridLayout: {
          columns: 3,
          widgets: widgets.map(w => ({
            title: w.title as string,
          })),
        },
      });
      addResource(r, 'google_monitoring_dashboard', id, {
        dashboard_json: dashboardJson,
      });
      return true;
    }

    case 'Logging.Stream': {
      const filters = (props.subscriptionFilters as Array<Record<string, unknown>>) ?? [];
      const bucketId = construct.id.replace(/[^a-zA-Z0-9_-]/g, '-');
      addResource(r, 'google_logging_project_bucket_config', id, {
        project: '${var.project_id}',
        location: '${var.gcp_region}',
        bucket_id: bucketId,
        retention_days: (props.retentionDays as number) ?? 30,
      });
      for (const f of filters) {
        const sinkId = toTfId(`${construct.id}_sink_${f.name}`);
        addResource(r, 'google_logging_project_sink', sinkId, {
          name: `${construct.id}-sink-${(f.name as string).replace(/[^a-zA-Z0-9-]/g, '-')}`,
          destination: (f.destinationArn as string) ?? '',
          filter: f.filterPattern as string,
        });
      }
      return true;
    }

    case 'Custom.Resource': {
      const tf = props.terraform as { type: string; name: string; properties: Record<string, unknown> } | undefined;
      if (!tf) return true;
      const customId = toTfId(tf.name ?? construct.id);
      addResource(r, tf.type, customId, tf.properties);
      return true;
    }

    default:
      return false;
  }
}
