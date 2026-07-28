import { BaseConstruct } from '@iacmp/core';
import { AzureTFCtx, addRes, toTFId, RG_NAME } from '../common';

/** Monitoring.Alarm → metric alert no escopo do resource group. */
export function synthMonitoring(c: BaseConstruct, ctx: AzureTFCtx): boolean {
  if (c.type !== 'Monitoring.Alarm') return false;
  const p = (c.props ?? {}) as Record<string, unknown>;
  const id = toTFId(c.id);

  const threshold = (p.threshold as number) ?? 80;
  const comparisonOperator = (p.comparisonOperator as string) ?? 'GreaterThanThreshold';
  const metricName = (p.metricName as string) ?? 'Percentage CPU';
  const operator = comparisonOperator.startsWith('LessThan') ? 'LessThan' : 'GreaterThan';
  addRes(ctx, 'azurerm_monitor_metric_alert', id, {
    name: `${id.replace(/_/g, '-')}-alert`,
    resource_group_name: RG_NAME,
    scopes: ['${azurerm_resource_group.main.id}'],
    criteria: [{
      metric_namespace: 'Microsoft.Compute/virtualMachines',
      metric_name: metricName,
      aggregation: 'Average',
      operator,
      threshold,
    }],
    severity: 2,
    frequency: 'PT1M',
    window_size: 'PT5M',
  });
  return true;
}
