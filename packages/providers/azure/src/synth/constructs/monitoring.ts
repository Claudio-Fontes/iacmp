import { BaseConstruct, isRef } from '@iacmp/core';
import { expr, tag, toSym, crossParamName, SynthContext } from './shared';

export function synthesizeMonitoring(construct: BaseConstruct, ctx: SynthContext): void {
  const { resources, outputs, crossParams } = ctx;
  const props = (construct.props ?? {}) as Record<string, unknown>;
  const sym = toSym(construct.id);

  switch (construct.type) {
    case 'Monitoring.Alarm': {
      const operatorMap: Record<string, string> = { GreaterThanThreshold: 'GreaterThan', LessThanThreshold: 'LessThan', GreaterThanOrEqualToThreshold: 'GreaterThanOrEqual', LessThanOrEqualToThreshold: 'LessThanOrEqual' };
      const rawAlarmActions = (props.alarmActions as unknown[]) ?? [];
      let alarmActionList: Array<Record<string, unknown>> = [];
      if (rawAlarmActions.length > 0) {
        const agSym = `${sym}Ag`;
        const agName = `${construct.id}-ag`;
        const azureFunctionReceivers: Array<Record<string, unknown>> = [];
        for (const action of rawAlarmActions) {
          if (isRef(action as Record<string, unknown>)) {
            const ref = action as { constructId: string; attribute: string };
            const target = ctx.idx.get(ref.constructId);
            if (target && (target.type === 'Function.Lambda' || target.type === 'Compute.Container')) {
              const tSym = toSym(ref.constructId);
              // Function.Lambda = Microsoft.Web/sites (host defaultHostName);
              // Compute.Container = Container App (host configuration.ingress.fqdn).
              const host = target.type === 'Function.Lambda'
                ? expr(`\${${tSym}.properties.defaultHostName}`)
                : expr(`\${${tSym}.properties.configuration.ingress.fqdn}`);
              azureFunctionReceivers.push({
                name: `fn-${ref.constructId}`,
                functionAppResourceId: expr(`${tSym}.id`),
                functionName: ref.constructId,
                httpTriggerUrl: expr(`'https://${host}/api/alert'`),
                useCommonAlertSchema: true,
              });
            }
          }
        }
        resources.push({ sym: agSym, type: 'Microsoft.Insights/actionGroups', apiVersion: '2023-01-01', name: agName, location: "'global'", tags: tag(construct.id), properties: { groupShortName: 'alert-ag', enabled: true, emailReceivers: [], smsReceivers: [], webhookReceivers: [], azureFunctionReceivers } });
        alarmActionList = [{ actionGroupId: expr(`${agSym}.id`) }];
      }
      const allowedMins = [1, 5, 15, 30, 60, 360, 720, 1440];
      const toInterval = (secs: number): string => {
        const mins = Math.round(secs / 60) || 1;
        const clamped = allowedMins.reduce((a, b) => Math.abs(b - mins) < Math.abs(a - mins) ? b : a);
        if (clamped >= 1440) return 'P1D';
        if (clamped >= 60) return `PT${clamped / 60}H`;
        return `PT${clamped}M`;
      };
      const periodSecs = (props.periodSeconds as number) ?? 60;
      const evalPeriods = (props.evaluationPeriods as number) ?? 1;
      const evalFreq = toInterval(periodSecs);
      const windowSizeVal = toInterval(periodSecs * evalPeriods);
      // Alvo do alarme: preferir o recurso apontado pela dimension (ex:
      // dimensions.FunctionName: ref('CheckerFn','Name')); senão, a 1ª
      // Function/Container do PROJETO. Usa globalIdx — o alvo quase sempre está
      // em OUTRA stack (compute) que não a de monitoring.
      const dims = (props.dimensions as Record<string, unknown>) ?? {};
      const dimTargetId = Object.values(dims)
        .map(v => (isRef(v as Record<string, unknown>) ? (v as { constructId: string }).constructId : v))
        .find((v): v is string => typeof v === 'string' && ctx.globalIdx.has(v));
      const alarmTarget = (dimTargetId ? ctx.globalIdx.get(dimTargetId) : undefined)
        ?? [...ctx.globalIdx.values()].find(c => c.type === 'Function.Lambda' || c.type === 'Compute.Container');

      // Namespace + métrica dependem do TIPO do alvo. Function.Lambda vira
      // Microsoft.Web/sites (Consumption Y1/Dynamic — App Service clássico);
      // Compute.Container vira Microsoft.App/containerApps. As métricas de
      // erro/latência têm nomes distintos em cada namespace.
      const isFunctionApp = alarmTarget?.type === 'Function.Lambda';
      const funcMetricMap: Record<string, string> = {
        Errors: 'Http5xx', p99: 'AverageResponseTime', Latency: 'AverageResponseTime',
        RequestDuration: 'AverageResponseTime', Invocations: 'FunctionExecutionCount',
        Count: 'Requests', ThrottledRequests: 'Http429',
      };
      const containerMetricMap: Record<string, string> = {
        Errors: 'Requests', p99: 'Requests', Latency: 'Requests',
        ThrottledRequests: 'Requests', Duration: 'TotalCpuUsage', Invocations: 'Requests',
        ConcurrentExecutions: 'Replicas', Count: 'Requests', RequestDuration: 'Requests',
      };

      let alarmScopes: unknown[];
      let alarmMetricNamespace: string;
      let alarmCondition: string | undefined;
      if (alarmTarget) {
        alarmMetricNamespace = isFunctionApp ? 'Microsoft.Web/sites' : 'Microsoft.App/containerApps';
        if (ctx.idx.has(alarmTarget.id)) {
          // mesma stack → símbolo local
          alarmScopes = [expr(`${toSym(alarmTarget.id)}.id`)];
        } else {
          // outra stack → param cross-stack, casado com o output 'Id' que a
          // Function/Container exporta (outputName(id,'Id') = crossParamName).
          const idParam = crossParamName(alarmTarget.id, 'Id');
          crossParams.set(idParam, 'string');
          alarmScopes = [expr(idParam)];
        }
      } else {
        const alarmScopeParam = `${sym}ScopeId`;
        crossParams.set(alarmScopeParam, 'string:optional');
        alarmScopes = [expr(alarmScopeParam)];
        alarmMetricNamespace = 'Microsoft.App/containerApps';
        alarmCondition = `${alarmScopeParam} != ''`;
      }
      const alarmCriteriaType = 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria';
      const rawMetricName = props.metricName as string;
      const metricNameMap = isFunctionApp ? funcMetricMap : containerMetricMap;
      const azureMetricName = metricNameMap[rawMetricName] ?? (isFunctionApp ? 'Http5xx' : 'Requests');
      // timeAggregation do Azure aceita SÓ [Average, Minimum, Maximum, Total, Count].
      // O 'Sum' do prompt (convenção CloudWatch/AWS) vira 'Total'.
      const aggMap: Record<string, string> = { Sum: 'Total', Average: 'Average', Minimum: 'Minimum', Maximum: 'Maximum', Count: 'Count', SampleCount: 'Count' };
      const timeAgg = aggMap[(props.statistic as string) ?? 'Average'] ?? 'Average';
      resources.push({ sym, type: 'Microsoft.Insights/metricAlerts', apiVersion: '2018-03-01', name: construct.id, location: "'global'", condition: alarmCondition, tags: tag(construct.id), properties: { description: `Alarm for ${props.metricName}`, severity: 2, enabled: true, scopes: alarmScopes, evaluationFrequency: evalFreq, windowSize: windowSizeVal, criteria: { 'odata.type': alarmCriteriaType, allOf: [{ name: 'criterion1', criterionType: 'StaticThresholdCriterion', metricName: azureMetricName, metricNamespace: alarmMetricNamespace, operator: operatorMap[(props.comparisonOperator as string) ?? 'GreaterThanThreshold'] ?? 'GreaterThan', threshold: props.threshold as number, timeAggregation: timeAgg, dimensions: [] }] }, actions: alarmActionList } });
      break;
    }

    case 'Monitoring.Dashboard': {
      const widgets = (props.widgets as Array<Record<string, unknown>>) ?? [];
      resources.push({ sym, type: 'Microsoft.Portal/dashboards', apiVersion: '2020-09-01-preview', name: construct.id, location: 'location', tags: { 'hidden-title': construct.id }, properties: { lenses: [{ order: 0, parts: widgets.map((w, i) => ({ position: { x: (i % 3) * 4, y: Math.floor(i / 3) * 4, colSpan: 4, rowSpan: 4 }, metadata: { type: 'Extension/Microsoft_Azure_Monitoring/PartType/MetricsChartPart', settings: { content: { options: { chart: { metrics: [{ name: w.metricName, resourceMetadata: {} }] } }, title: w.title as string } } } })) }] } });
      break;
    }

    case 'Logging.Stream': {
      const wsName = `${construct.id}-law`;
      resources.push({ sym, type: 'Microsoft.OperationalInsights/workspaces', apiVersion: '2022-10-01', name: wsName, location: 'location', tags: tag(construct.id), properties: { sku: { name: 'PerGB2018' }, retentionInDays: (props.retentionDays as number) ?? 30, features: { enableLogAccessUsingOnlyResourcePermissions: true } } });
      break;
    }

    case 'Custom.Resource': {
      const bicepCustom = props.bicep as { type: string; apiVersion: string; properties: Record<string, unknown>; sku?: Record<string, unknown>; kind?: string } | undefined;
      const armCustom = props.arm as { type: string; apiVersion: string; properties: Record<string, unknown>; sku?: Record<string, unknown>; kind?: string } | undefined;
      const custom = bicepCustom ?? armCustom;
      if (!custom) break;
      resources.push({ sym, type: custom.type, apiVersion: custom.apiVersion, name: (props.name as string) ?? construct.id, location: 'location', tags: tag(construct.id), sku: custom.sku, kind: custom.kind, properties: custom.properties });
      break;
    }
  }
}
