import { BaseConstruct } from '@iacmp/core';
import { AzureTFCtx, addRes, toTFId, RG_NAME, RG_LOCATION } from '../common';
import { TFRegistry, resolveDeep } from '../refs';

/** Compute.Container → Container App + environment próprio (serverless, sem quota de VM). */
export function synthCompute(c: BaseConstruct, ctx: AzureTFCtx, reg: TFRegistry): boolean {
  if (c.type !== 'Compute.Container') return false;
  const p = (c.props ?? {}) as Record<string, unknown>;
  const id = toTFId(c.id);

  const envId = `${id}_cae`;
  addRes(ctx, 'azurerm_container_app_environment', envId, {
    name: `${id.replace(/_/g, '-')}-cae`,
    resource_group_name: RG_NAME,
    location: RG_LOCATION,
  });
  const image = (p.image as string) ?? 'nginx:latest';
  const cpu = (p.cpu as number) ?? 0.25;
  const memMb = (p.memory as number) ?? 512;
  const memory = memMb >= 1024 ? `${memMb / 1024}Gi` : `${memMb}Mi`;
  const port = (p.port as number) ?? 80;
  const env = (p.environment as Record<string, unknown>) ?? {};
  const envVars = Object.entries(env).map(([name, value]) => ({
    name,
    value: String(resolveDeep(value, reg) ?? ''),
  }));
  addRes(ctx, 'azurerm_container_app', id, {
    name: id.replace(/_/g, '-'),
    container_app_environment_id: `\${azurerm_container_app_environment.${envId}.id}`,
    resource_group_name: RG_NAME,
    revision_mode: 'Single',
    template: {
      container: [{
        name: id.replace(/_/g, '-'),
        image,
        cpu,
        memory,
        ...(envVars.length > 0 ? { env: envVars } : {}),
      }],
    },
    ingress: [{
      external_enabled: true,
      target_port: port,
      traffic_weight: [{ latest_revision: true, percentage: 100 }],
    }],
  });
  ctx.outputs[`${id}_fqdn`] = { value: `\${azurerm_container_app.${id}.ingress[0].fqdn}` };
  return true;
}
