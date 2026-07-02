import { Stack, EnvironmentProfile, DEFAULT_PROFILE } from '@iacmp/core';
import {
  buildGraph,
  emitCloudFormation,
  emitTerraform,
  validateResourceReferences,
  validateNoNullValues,
} from '@iacmp/provider-aws';

export class TerraformProvider {
  readonly name = 'terraform';

  synthesize(stack: Stack, allStacks?: Stack[], profile: EnvironmentProfile = DEFAULT_PROFILE): string {
    const graph = buildGraph(stack, allStacks, profile);
    const cfnTemplate = emitCloudFormation(graph);
    validateResourceReferences(cfnTemplate.Resources);
    validateNoNullValues(cfnTemplate.Resources);
    const tfJson = emitTerraform(cfnTemplate);
    return JSON.stringify(tfJson, null, 2);
  }
}
