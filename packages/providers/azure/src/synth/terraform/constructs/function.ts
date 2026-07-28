import { BaseConstruct, isRef } from '@iacmp/core';
import type { Ref } from '@iacmp/core';
import { AzureTFCtx, addRes, toTFId, RG_NAME, RG_LOCATION } from '../common';
import { TFRegistry, resolveDeep, resolveRefStr } from '../refs';

/** Function.Lambda e Function.ApiGateway → Function App (plano Consumption compartilhado) e APIM. */
export function synthFunction(c: BaseConstruct, ctx: AzureTFCtx, reg: TFRegistry): boolean {
  const p = (c.props ?? {}) as Record<string, unknown>;
  const id = toTFId(c.id);
  const rg = RG_NAME;
  const loc = RG_LOCATION;

  switch (c.type) {
    case 'Function.Lambda': {
      if (!ctx.hasFunctionStorage) {
        ctx.hasFunctionStorage = true;
        addRes(ctx, 'azurerm_storage_account', 'fn_storage', {
          name: 'iacmpfnstorage',
          resource_group_name: rg,
          location: loc,
          account_tier: 'Standard',
          account_replication_type: 'LRS',
        });
      }
      if (!ctx.hasConsumptionPlan) {
        ctx.hasConsumptionPlan = true;
        addRes(ctx, 'azurerm_service_plan', 'consumption_plan', {
          name: 'iacmp-consumption-plan',
          resource_group_name: rg,
          location: loc,
          os_type: 'Linux',
          sku_name: 'Y1',
        });
      }

      const env = (p.environment as Record<string, unknown>) ?? {};
      const appSettings: Record<string, string> = {
        FUNCTIONS_EXTENSION_VERSION: '~4',
        FUNCTIONS_WORKER_RUNTIME: 'node',
        AzureWebJobsStorage: '${azurerm_storage_account.fn_storage.primary_connection_string}',
        WEBSITE_CONTENTAZUREFILECONNECTIONSTRING: '${azurerm_storage_account.fn_storage.primary_connection_string}',
        WEBSITE_CONTENTSHARE: `${id}-content`,
      };
      for (const [k, v] of Object.entries(env)) {
        const resolved = resolveDeep(v, reg);
        appSettings[k] = typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
      }

      const fnProps: Record<string, unknown> = {
        name: id.replace(/_/g, '-'),
        resource_group_name: rg,
        location: loc,
        service_plan_id: '${azurerm_service_plan.consumption_plan.id}',
        storage_account_name: '${azurerm_storage_account.fn_storage.name}',
        storage_account_access_key: '${azurerm_storage_account.fn_storage.primary_access_key}',
        app_settings: appSettings,
        site_config: { application_stack: { node_version: '20' } },
        identity: { type: 'SystemAssigned' },
        depends_on: ['azurerm_storage_account.fn_storage', 'azurerm_service_plan.consumption_plan'],
      };

      const subnetIds = p.subnetIds as Array<string | Ref> | undefined;
      if (subnetIds && subnetIds.length > 0) {
        const first = subnetIds[0];
        const subnetRef = isRef(first)
          ? resolveRefStr((first as Ref).constructId, 'SubnetId', reg)
          : String(first);
        fnProps.virtual_network_subnet_id = subnetRef;
      }

      addRes(ctx, 'azurerm_linux_function_app', id, fnProps);
      ctx.outputs[`${id}_fqdn`] = { value: `\${azurerm_linux_function_app.${id}.default_hostname}` };
      return true;
    }

    case 'Function.ApiGateway': {
      addRes(ctx, 'azurerm_api_management', id, {
        name: `${id.replace(/_/g, '-')}-apim`.slice(0, 50),
        resource_group_name: rg,
        location: loc,
        publisher_name: 'iacmp',
        publisher_email: 'admin@iacmp.dev',
        sku_name: 'Consumption_0',
      });
      ctx.outputs[`${id}_gateway_url`] = { value: `\${azurerm_api_management.${id}.gateway_url}` };
      return true;
    }

    default:
      return false;
  }
}
