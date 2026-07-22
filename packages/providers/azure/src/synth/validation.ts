import type { BicepResource } from './constructs/shared';
import { isExpr, rawExpr } from './constructs/shared';

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
// Só o Azure Monitor conhece isso — o validate de template não. Function.Lambda
// vira Microsoft.Web/sites em Consumption (Y1/Dynamic) — métricas de App
// Service clássico (Http5xx/Requests/AverageResponseTime/FunctionExecutionCount).
export const AZURE_METRICS_BY_NAMESPACE: Record<string, ReadonlySet<string>> = {
  'Microsoft.Web/sites': new Set([
    'MemoryWorkingSet', 'AverageMemoryWorkingSet', 'CpuTime', 'CpuPercentage',
    'Http101', 'Http2xx', 'Http3xx', 'Http401', 'Http403', 'Http404', 'Http406', 'Http429', 'Http4xx', 'Http5xx',
    'AverageResponseTime', 'Requests', 'FunctionExecutionCount', 'FunctionExecutionUnits',
    'BytesReceived', 'BytesSent', 'HealthCheckStatus', 'Threads', 'HttpResponseTime',
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

// ── Catálogo: comprimento máximo de nome por tipo ───────────────────────────
// Limites rígidos do ARM que o `az validate` é inconsistente em pegar (às vezes
// só falha no deploy real com "name too long"). O risco concreto é o Cosmos
// (Microsoft.DocumentDB): monta o nome como `${id}-${uniqueString}` SEM slice —
// um construct.id longo estoura 44 chars. Storage/Function/APIM/Redis já cortam.
export const AZURE_NAME_MAX: Record<string, { max: number; label: string }> = {
  'Microsoft.Storage/storageAccounts': { max: 24, label: 'Storage account' },
  'Microsoft.KeyVault/vaults': { max: 24, label: 'Key Vault' },
  'Microsoft.DocumentDB/databaseAccounts': { max: 44, label: 'Cosmos DB account' },
  'Microsoft.Cache/redisEnterprise': { max: 60, label: 'Redis Enterprise' },
  'Microsoft.ApiManagement/service': { max: 50, label: 'API Management' },
};

// Resolve o comprimento de um nome de recurso em synth-time. uniqueString()
// SEMPRE retorna 13 chars (constante do ARM), então `'x-${uniqueString(...)}'` é
// mensurável offline. Retorna null quando o nome não é estimável com segurança
// (outra interpolação além de uniqueString) — nesse caso não arriscamos falso-positivo.
export function estimateNameLength(name: unknown): number | null {
  if (typeof name !== 'string') return null;
  let s = name;
  if (isExpr(s)) {
    const m = /^'(.*)'$/.exec(rawExpr(s));
    if (!m) return null; // expressão que não é string-interpolada → não estimável
    s = m[1];
  }
  s = s.replace(/\$\{uniqueString\([^}]*\)\}/g, 'x'.repeat(13));
  if (s.includes('${')) return null; // sobrou interpolação não-resolvível
  return s.length;
}

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
    validateResourceName(r, errors);
  }

  return errors;
}

function validateResourceName(r: BicepResource, errors: string[]): void {
  const rule = AZURE_NAME_MAX[r.type];
  if (!rule) return;
  const len = estimateNameLength(r.name);
  if (len !== null && len > rule.max) {
    errors.push(
      `${rule.label} "${r.sym}": nome resolve para ${len} chars (máx ${rule.max} no Azure). ` +
      `uniqueString() já ocupa 13 — encurte o id do construct ou aplique slice no prefixo.`,
    );
  }
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
        `Métricas válidas: ${[...known].slice(0, 6).join(', ')}… `,
      );
    }
  }
}
