export { AzureProvider } from './provider';
export { emitBicep, extractAzureFunctionMeta } from './synth/bicep';
export type { AzureFunctionMeta } from './synth/bicep';
export { validateAzureResources, estimateNameLength, AZURE_METRICS_BY_NAMESPACE, AZURE_TIME_AGGREGATIONS, AZURE_ALERT_OPERATORS, AZURE_NAME_MAX } from './synth/validation';
