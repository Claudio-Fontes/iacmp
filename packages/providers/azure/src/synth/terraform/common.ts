export type TFResources = Record<string, Record<string, Record<string, unknown>>>;
export type TFOutputs = Record<string, { value: string; sensitive?: boolean }>;

export interface AzureTFCtx {
  resources: TFResources;
  outputs: TFOutputs;
  hasFunctionStorage: boolean;
  hasConsumptionPlan: boolean;
  needsClientConfig: boolean;
}

export function toTFId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

export function addRes(ctx: AzureTFCtx, type: string, id: string, props: Record<string, unknown>): void {
  if (!ctx.resources[type]) ctx.resources[type] = {};
  ctx.resources[type][id] = props;
}

export function newCtx(): AzureTFCtx {
  return { resources: {}, outputs: {}, hasFunctionStorage: false, hasConsumptionPlan: false, needsClientConfig: false };
}

/** Referências fixas ao resource group único do projeto (criado em _providers.tf.json). */
export const RG_NAME = '${azurerm_resource_group.main.name}';
export const RG_LOCATION = '${azurerm_resource_group.main.location}';
