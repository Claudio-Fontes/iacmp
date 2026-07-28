import { BaseConstruct } from '@iacmp/core';
import { AzureTFCtx, addRes, toTFId, RG_NAME, RG_LOCATION } from '../common';
import { TFRegistry, resolveDeep } from '../refs';

/** Policy.IAM → role assignment; Secret.Vault → Key Vault + secrets. */
export function synthSecurity(c: BaseConstruct, ctx: AzureTFCtx, reg: TFRegistry): boolean {
  const p = (c.props ?? {}) as Record<string, unknown>;
  const id = toTFId(c.id);

  switch (c.type) {
    case 'Policy.IAM': {
      const attachTo = p.attachTo as string | undefined;
      if (attachTo) {
        addRes(ctx, 'azurerm_role_assignment', `${id}_assignment`, {
          scope: '${azurerm_resource_group.main.id}',
          role_definition_name: 'Contributor',
          principal_id: `\${azurerm_linux_function_app.${toTFId(attachTo)}.identity[0].principal_id}`,
        });
      }
      return true;
    }

    case 'Secret.Vault': {
      ctx.needsClientConfig = true;
      addRes(ctx, 'azurerm_key_vault', id, {
        name: `${id.replace(/_/g, '-').slice(0, 20)}-kv`,
        resource_group_name: RG_NAME,
        location: RG_LOCATION,
        tenant_id: '${data.azurerm_client_config.current.tenant_id}',
        sku_name: 'standard',
        soft_delete_retention_days: 7,
        purge_protection_enabled: false,
        access_policy: [{
          tenant_id: '${data.azurerm_client_config.current.tenant_id}',
          object_id: '${data.azurerm_client_config.current.object_id}',
          secret_permissions: ['Get', 'List', 'Set', 'Delete', 'Purge'],
        }],
      });
      const secrets = (p.secrets as Record<string, unknown>) ?? {};
      for (const [name, value] of Object.entries(secrets)) {
        const secretId = `${id}_secret_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
        addRes(ctx, 'azurerm_key_vault_secret', secretId, {
          name: name.replace(/_/g, '-').slice(0, 127),
          value: String(resolveDeep(value, reg) ?? ''),
          key_vault_id: `\${azurerm_key_vault.${id}.id}`,
        });
      }
      ctx.outputs[`${id}_uri`] = { value: `\${azurerm_key_vault.${id}.vault_uri}` };
      return true;
    }

    default:
      return false;
  }
}
