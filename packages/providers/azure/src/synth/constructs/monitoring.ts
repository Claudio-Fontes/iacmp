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
      // notificationTopicId: string ref a um construct de mensageria (Messaging.Topic/Stream)
      // ou Function.Lambda. Azure Monitor Action Groups não têm receiver nativo p/ Service Bus,
      // então Messaging.Topic é mapeado para Event Hub receiver se for Messaging.Stream, ou
      // webhook receiver (HTTPS POST p/ a REST API do SB) se for Messaging.Topic.
      const notificationTopicId = props.notificationTopicId as string | undefined;
      let alarmActionList: Array<Record<string, unknown>> = [];
      const hasActions = rawAlarmActions.length > 0 || !!notificationTopicId;
      if (hasActions) {
        const agSym = `${sym}Ag`;
        const agName = `${construct.id}-ag`;
        const azureFunctionReceivers: Array<Record<string, unknown>> = [];
        const eventHubReceivers: Array<Record<string, unknown>> = [];
        const webhookReceivers: Array<Record<string, unknown>> = [];
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
        if (notificationTopicId) {
          const topicConstruct = ctx.idx.get(notificationTopicId) ?? ctx.globalIdx.get(notificationTopicId);
          if (topicConstruct?.type === 'Messaging.Stream') {
            // Event Hub: Azure Monitor suporta eventHubReceivers nativamente
            const tSym = toSym(notificationTopicId);
            const nsSym = ctx.idx.has(notificationTopicId) ? `${tSym}Ns` : undefined;
            if (nsSym) {
              eventHubReceivers.push({
                name: `eh-${notificationTopicId}`,
                eventHubNameSpace: expr(`${nsSym}.name`),
                eventHubName: notificationTopicId,
                useCommonAlertSchema: true,
                tenantId: expr('subscription().tenantId'),
                subscriptionId: expr('subscription().subscriptionId'),
              });
            }
          } else if (topicConstruct?.type === 'Messaging.Topic' || topicConstruct?.type === 'Messaging.Queue') {
            // Service Bus: Azure Monitor não tem receiver nativo; webhook via REST API SB
            const tSym = toSym(notificationTopicId);
            const nsSym = ctx.idx.has(notificationTopicId) ? `${tSym}Ns` : undefined;
            if (nsSym) {
              webhookReceivers.push({
                name: `sb-${notificationTopicId}`,
                serviceUri: expr(`'https://\${${nsSym}.name}.servicebus.windows.net/${notificationTopicId}/messages'`),
                useCommonAlertSchema: true,
                useAadAuth: false,
              });
            }
          } else if (topicConstruct?.type === 'Function.Lambda' || topicConstruct?.type === 'Compute.Container') {
            const tSym = toSym(notificationTopicId);
            const host = topicConstruct.type === 'Function.Lambda'
              ? expr(`\${${tSym}.properties.defaultHostName}`)
              : expr(`\${${tSym}.properties.configuration.ingress.fqdn}`);
            azureFunctionReceivers.push({
              name: `fn-${notificationTopicId}`,
              functionAppResourceId: expr(`${tSym}.id`),
              functionName: notificationTopicId,
              httpTriggerUrl: expr(`'https://${host}/api/alert'`),
              useCommonAlertSchema: true,
            });
          }
        }
        resources.push({ sym: agSym, type: 'Microsoft.Insights/actionGroups', apiVersion: '2023-01-01', name: agName, location: "'global'", tags: tag(construct.id), properties: { groupShortName: 'alert-ag', enabled: true, emailReceivers: [], smsReceivers: [], webhookReceivers, azureFunctionReceivers, eventHubReceivers } });
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
      // CPU/memória em containerApps são ABSOLUTOS: UsageNanoCores (nanocores) e
      // WorkingSetBytes (bytes) — não existem métricas percentuais nem
      // 'TotalCpuUsage' (ARM rejeita: "Couldn't find a metric"; provado em deploy).
      const containerMetricMap: Record<string, string> = {
        Errors: 'Requests', p99: 'Requests', Latency: 'Requests',
        ThrottledRequests: 'Requests', Duration: 'UsageNanoCores', Invocations: 'Requests',
        ConcurrentExecutions: 'Replicas', Count: 'Requests', RequestDuration: 'Requests',
        CPUUtilization: 'UsageNanoCores', MemoryUtilization: 'WorkingSetBytes',
      };

      let alarmScopes: unknown[];
      let alarmMetricNamespace: string;
      let alarmCriteriaType: string;
      let alarmTargetType: string;
      let alarmCondition: string | undefined;
      if (alarmTarget) {
        alarmMetricNamespace = isFunctionApp ? 'Microsoft.Web/sites' : 'Microsoft.App/containerApps';
        alarmCriteriaType = 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria';
        alarmTargetType = alarmMetricNamespace;
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
        alarmMetricNamespace = (props.namespace as string) ?? 'Microsoft.App/containerApps';
        // Sem target no grafo global → tenta o primeiro recurso já declarado na
        // stack corrente como scope (single-resource). Resource-group-scope só é
        // usado como último recurso: Azure restringe os tipos permitidos para
        // MultipleResourceMultipleMetricCriteria e rejeita Web/sites e
        // App/containerApps com "currently not supported at resource group level".
        const firstLocal = ctx.resources.find(r => !r.type.startsWith('Microsoft.Insights/'));
        if (firstLocal) {
          alarmScopes = [expr(`${firstLocal.sym}.id`)];
          alarmCriteriaType = 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria';
          alarmTargetType = firstLocal.type;
        } else {
          alarmScopes = [expr('resourceGroup().id')];
          alarmCriteriaType = 'Microsoft.Azure.Monitor.MultipleResourceMultipleMetricCriteria';
          alarmTargetType = alarmMetricNamespace.startsWith('Microsoft.') ? alarmMetricNamespace : 'Microsoft.App/containerApps';
        }
      }
      // targetResourceType e targetResourceRegion são obrigatórios pela API do Azure
      // quando o scope é um resource group (MultipleResource). Emitir sempre é
      // seguro: no caso single-resource são ignorados, mas a presença não causa erro.
      const targetResourceType = alarmTargetType;
      const targetResourceRegion = expr("resourceGroup().location");
      const rawMetricName = props.metricName as string;
      const metricNameMap = isFunctionApp ? funcMetricMap : containerMetricMap;
      const azureMetricName = alarmTarget
        ? (metricNameMap[rawMetricName] ?? (isFunctionApp ? 'Http5xx' : 'Requests'))
        : (containerMetricMap[rawMetricName] ?? funcMetricMap[rawMetricName] ?? rawMetricName ?? 'Requests');
      // timeAggregation do Azure aceita SÓ [Average, Minimum, Maximum, Total, Count].
      // O 'Sum' do prompt (convenção CloudWatch/AWS) vira 'Total'.
      const aggMap: Record<string, string> = { Sum: 'Total', Average: 'Average', Minimum: 'Minimum', Maximum: 'Maximum', Count: 'Count', SampleCount: 'Count' };
      const timeAgg = aggMap[(props.statistic as string) ?? 'Average'] ?? 'Average';
      resources.push({ sym, type: 'Microsoft.Insights/metricAlerts', apiVersion: '2018-03-01', name: construct.id, location: "'global'", condition: alarmCondition, tags: tag(construct.id), properties: { description: `Alarm for ${props.metricName}`, severity: 2, enabled: true, scopes: alarmScopes, evaluationFrequency: evalFreq, windowSize: windowSizeVal, targetResourceType, targetResourceRegion, criteria: { 'odata.type': alarmCriteriaType, allOf: [{ name: 'criterion1', criterionType: 'StaticThresholdCriterion', metricName: azureMetricName, metricNamespace: alarmMetricNamespace, operator: operatorMap[(props.comparisonOperator as string) ?? 'GreaterThanThreshold'] ?? 'GreaterThan', threshold: props.threshold as number, timeAggregation: timeAgg, dimensions: [], skipMetricValidation: true }] }, actions: alarmActionList } });
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
