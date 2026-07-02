import { BaseConstruct } from '@iacmp/core';
import type { CloudFormationResource, SynthContext } from '../types';
import { alarmActionsBlock } from '../resolvers';
import { resourceRef } from '../graph';

export function synthMonitoring(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> | null {
  const props = construct.props as Record<string, unknown>;
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  switch (construct.type) {
    case 'Monitoring.Alarm': {
      const dimensions = props.dimensions as Record<string, string> | undefined;
      return [[logicalId, {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          AlarmName: construct.id,
          MetricName: props.metricName as string,
          Namespace: (props.namespace as string) ?? 'AWS/Lambda',
          Threshold: props.threshold as number,
          EvaluationPeriods: (props.evaluationPeriods as number) ?? 2,
          Period: (props.periodSeconds as number) ?? 60,
          ComparisonOperator: (props.comparisonOperator as string) ?? 'GreaterThanThreshold',
          Statistic: (props.statistic as string) ?? 'Average',
          TreatMissingData: (props.treatMissingData as string) ?? 'notBreaching',
          ...alarmActionsBlock('AlarmActions', props.alarmActions, ctx),
          ...alarmActionsBlock('OKActions', props.okActions, ctx),
          ...(dimensions ? { Dimensions: Object.entries(dimensions).map(([k, v]) => ({ Name: k, Value: v })) } : {}),
        },
      }]];
    }

    case 'Monitoring.Dashboard': {
      const widgets = (props.widgets as Array<Record<string, unknown>>) ?? [];
      const dashBody = {
        widgets: widgets.map((w, i) => ({
          type: w.type === 'text' ? 'text' : 'metric',
          x: (i % 3) * 8,
          y: Math.floor(i / 3) * 6,
          width: 8,
          height: 6,
          properties: w.type === 'text'
            ? { markdown: w.markdown ?? w.title }
            : {
                title: w.title as string,
                metrics: [[
                  (w.namespace as string) ?? 'AWS/Lambda',
                  w.metricName as string,
                  ...(w.dimensions ? Object.entries(w.dimensions as Record<string, string>).flat() : []),
                ]],
                period: (w.period as number) ?? 60,
                stat: (w.stat as string) ?? 'Average',
                view: 'timeSeries',
              },
        })),
      };
      return [[logicalId, {
        Type: 'AWS::CloudWatch::Dashboard',
        Properties: {
          DashboardName: construct.id,
          DashboardBody: JSON.stringify(dashBody),
        },
      }]];
    }

    case 'Logging.Stream': {
      const filters = (props.subscriptionFilters as Array<Record<string, unknown>>) ?? [];
      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::Logs::LogGroup',
        Properties: {
          LogGroupName: `/iacmp/${construct.id}`,
          RetentionInDays: (props.retentionDays as number) ?? 30,
          ...(props.kmsKeyId ? { KmsKeyId: props.kmsKeyId } : {}),
        },
      }]];
      for (const f of filters) {
        entries.push([`${logicalId}${(f.name as string).replace(/[^a-zA-Z0-9]/g, '')}Filter`, {
          Type: 'AWS::Logs::SubscriptionFilter',
          Properties: {
            LogGroupName: resourceRef(logicalId, 'Id'),
            FilterName: f.name as string,
            FilterPattern: f.filterPattern as string,
            DestinationArn: f.destinationArn as string,
          },
        }]);
      }
      return entries;
    }

    case 'Custom.Resource': {
      const cfn = props.cloudformation as { type: string; properties: Record<string, unknown> } | undefined;
      if (!cfn) return [];
      return [[logicalId, { Type: cfn.type, Properties: cfn.properties }]];
    }

    default: return null;
  }
}
