export { GCPProvider } from './provider';
export { emitGCPTerraform, emitGCPResources, emitGCPProviders, extractGCPFunctionMeta, extractGCPContainerMeta } from './synth/gcp-terraform';
export type { GCPFunctionMeta, GCPContainerMeta } from './synth/gcp-terraform';
// toTfId: mesma sanitização de logicalId → tfId usada pelo synth (ver
// constructs/common.ts) — reexportada para o deploy (packages/cli/src/deploy/gcp.ts)
// localizar o resource `google_cloudfunctions2_function.<tfId>` no tf.json a
// partir do `GCPFunctionMeta.constructId`, sem duplicar a regra de sanitização.
export { toTfId } from './synth/constructs/common';
