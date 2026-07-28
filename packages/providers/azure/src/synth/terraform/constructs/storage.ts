import { BaseConstruct } from '@iacmp/core';
import { AzureTFCtx, addRes, toTFId, RG_NAME, RG_LOCATION } from '../common';

/** Storage.Bucket → Storage Account + container privado/blob. */
export function synthStorage(c: BaseConstruct, ctx: AzureTFCtx): boolean {
  if (c.type !== 'Storage.Bucket') return false;
  const p = (c.props ?? {}) as Record<string, unknown>;
  const id = toTFId(c.id);

  const safeName = (c.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18) || 'bucket') + 'sa';
  addRes(ctx, 'azurerm_storage_account', id, {
    name: safeName,
    resource_group_name: RG_NAME,
    location: RG_LOCATION,
    account_tier: 'Standard',
    account_replication_type: p.replication === 'geo' ? 'RAGRS' : 'LRS',
    allow_nested_items_to_be_public: (p.publicAccess as boolean) ?? false,
    min_tls_version: 'TLS1_2',
    blob_properties: p.versioning ? { versioning_enabled: true } : undefined,
  });
  addRes(ctx, 'azurerm_storage_container', `${id}_container`, {
    name: id.replace(/_/g, '-'),
    storage_account_id: `\${azurerm_storage_account.${id}.id}`,
    container_access_type: (p.publicAccess as boolean) ? 'blob' : 'private',
  });
  ctx.outputs[`${id}_name`] = { value: `\${azurerm_storage_account.${id}.name}` };
  ctx.outputs[`${id}_connection_string`] = { value: `\${azurerm_storage_account.${id}.primary_connection_string}`, sensitive: true };
  return true;
}
