import type { BicepResource } from './constructs/shared';

/**
 * Validação semântica Azure que roda em SYNTH-TIME, offline, sobre os recursos
 * já montados — ANTES de emitir o Bicep. Pega a classe de bug que o
 * `az deployment group validate` NÃO pega (ele só valida o template: sintaxe
 * ARM, tipos, refs — não o conteúdo de control-plane/data-plane), e que só
 * apareceria depois de 15min de deploy real com um erro do ARM.
 *
 * Cada regra aqui nasceu de uma falha de deploy real da bateria. É a mesma
 * disciplina do validation.ts do AWS: promover cada bug de deploy a erro de
 * synth-time (2s, offline) em vez de descobri-lo no ARM.
 */

// ── Catálogo: métricas válidas por namespace ────────────────────────────────
// Só o Azure Monitor conhece isso — o validate de template não. FC1 (Flex
// Consumption = Microsoft.Web/sites) NÃO tem Http5xx/Requests/AverageResponseTime
// (essas são do App Service clássico); só expõe execução/recurso.
export const AZURE_METRICS_BY_NAMESPACE: Record<string, ReadonlySet<string>> = {
  'Microsoft.Web/sites': new Set([
    'MemoryWorkingSet', 'AverageMemoryWorkingSet', 'InstanceCount', 'CpuPercentage',
    'OnDemandFunctionExecutionCount', 'OnDemandFunctionExecutionUnits',
    'AlwaysReadyFunctionExecutionCount', 'AlwaysReadyFunctionExecutionUnits', 'AlwaysReadyUnits',
  ]),
  'Microsoft.App/containerApps': new Set([
    'Requests', 'Replicas', 'RestartCount', 'RxBytes', 'TxBytes',
    'CpuPercentage', 'MemoryPercentage', 'TotalCpuUsage', 'WorkingSetBytes',
  ]),
};

// timeAggregation aceito pelo Microsoft.Insights/metricAlerts (o 'Sum' do
// CloudWatch/AWS NÃO é válido — vira 'Total').
export const AZURE_TIME_AGGREGATIONS: ReadonlySet<string> = new Set([
  'Average', 'Minimum', 'Maximum', 'Total', 'Count',
]);

// operators válidos para StaticThresholdCriterion.
export const AZURE_ALERT_OPERATORS: ReadonlySet<string> = new Set([
  'Equals', 'GreaterThan', 'GreaterThanOrEqual', 'LessThan', 'LessThanOrEqual',
]);

interface AlertCriterion {
  metricName?: string;
  metricNamespace?: string;
  timeAggregation?: string;
  operator?: string;
}

/**
 * Valida os recursos Bicep gerados. Retorna a lista de erros (vazia = ok).
 * Não lança — quem chama (emitBicep) decide.
 */
export function validateAzureResources(resources: BicepResource[]): string[] {
  const errors: string[] = [];

  for (const r of resources) {
    if (r.type === 'Microsoft.Insights/metricAlerts') {
      validateMetricAlert(r, errors);
    }
  }

  return errors;
}

function validateMetricAlert(r: BicepResource, errors: string[]): void {
  const criteria = r.properties?.criteria as { allOf?: AlertCriterion[] } | undefined;
  const allOf = criteria?.allOf ?? [];
  const label = `metricAlert "${r.sym}"`;

  for (const c of allOf) {
    // timeAggregation dentro do enum válido
    if (c.timeAggregation && !AZURE_TIME_AGGREGATIONS.has(c.timeAggregation)) {
      errors.push(
        `${label}: timeAggregation '${c.timeAggregation}' inválido. ` +
        `Azure aceita só ${[...AZURE_TIME_AGGREGATIONS].join(', ')} (o 'Sum' do CloudWatch vira 'Total').`,
      );
    }
    // operator dentro do enum válido
    if (c.operator && !AZURE_ALERT_OPERATORS.has(c.operator)) {
      errors.push(
        `${label}: operator '${c.operator}' inválido. Azure aceita ${[...AZURE_ALERT_OPERATORS].join(', ')}.`,
      );
    }
    // métrica existe no namespace (só validamos namespaces conhecidos — outros
    // podem ter métricas que não catalogamos, e aí confiamos no synth).
    const ns = c.metricNamespace;
    const known = ns ? AZURE_METRICS_BY_NAMESPACE[ns] : undefined;
    if (known && c.metricName && !known.has(c.metricName)) {
      errors.push(
        `${label}: métrica '${c.metricName}' não existe no namespace '${ns}'. ` +
        `Métricas válidas: ${[...known].slice(0, 6).join(', ')}… ` +
        `(Function App FC1 não tem Http5xx/Requests — use OnDemandFunctionExecutionCount.)`,
      );
    }
  }
}
