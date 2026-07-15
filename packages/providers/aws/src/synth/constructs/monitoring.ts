import { BaseConstruct, isRef, ref, type Ref } from '@iacmp/core';
import type { CloudFormationResource, SynthContext } from '../types';
import { alarmActionsBlock, resolveRef } from '../resolvers';
import { resourceRef } from '../graph';

// Resolve o VALUE de uma dimension de métrica (ex: FunctionName). Aceita:
// - ref('LambdaId', 'Name') explícito → resolve via RESOLVE_MAP (mesma/outra stack)
// - string bare que é o id de uma Function.Lambda → resolve para o nome físico
//   real (prefixado com o projectName), nunca o id lógico cru — o nome lógico
//   NÃO bate com a métrica emitida pela Lambda de verdade (bug: alarme nunca
//   recebe datapoints porque a dimension não corresponde ao FunctionName real).
// - qualquer outra string (dimension não ligada a um construct) → passa literal.
function resolveDimensionValue(value: unknown, ctx: SynthContext): unknown {
  if (isRef(value)) return resolveRef(value as Ref, ctx);
  if (typeof value !== 'string') return value;
  const entry = ctx.registry.get(value);
  if (entry?.type === 'Function.Lambda') {
    return resolveRef(ref(value, 'Name'), ctx);
  }
  return value;
}

function resolveCustomProps(value: unknown, ctx: SynthContext): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => resolveCustomProps(v, ctx));
  const obj = value as Record<string, unknown>;
  // ref() object (produzido pelo ref() do @iacmp/core nos props do Custom.Resource)
  if (isRef(obj as unknown)) {
    try { return resolveRef(obj as unknown as Ref, ctx); } catch { return obj; }
  }
  // { 'Fn::ImportValue': 'ConstructId.Attribute' } — atalho de dot-notation
  if ('Fn::ImportValue' in obj && typeof obj['Fn::ImportValue'] === 'string') {
    const raw = obj['Fn::ImportValue'] as string;
    const dot = raw.lastIndexOf('.');
    if (dot > 0) {
      const constructId = raw.slice(0, dot);
      const attribute = raw.slice(dot + 1);
      if (ctx.registry.has(constructId)) {
        try {
          return resolveRef({ kind: 'iacmp:ref', constructId, attribute } as Ref, ctx);
        } catch { /* não resolvível — passa adiante sem alterar */ }
      }
    }
    return obj;
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveCustomProps(v, ctx)]));
}

export function synthMonitoring(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> | null {
  const props = construct.props as Record<string, unknown>;
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  switch (construct.type) {
    case 'Monitoring.Alarm': {
      const dimensions = props.dimensions as Record<string, unknown> | undefined;
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
          ...(dimensions ? { Dimensions: Object.entries(dimensions).map(([k, v]) => ({ Name: k, Value: resolveDimensionValue(v, ctx) })) } : {}),
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
                region: '${AWS::Region}',
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
          DashboardBody: { 'Fn::Sub': JSON.stringify(dashBody) },
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
      const resolved = resolveCustomProps(cfn.properties, ctx) as Record<string, unknown>;
      return [[logicalId, { Type: cfn.type, Properties: resolved }]];
    }

    default: return null;
  }
}
