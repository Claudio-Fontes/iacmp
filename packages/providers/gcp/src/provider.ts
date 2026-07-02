import { Stack } from '@iacmp/core';
import { emitGCPTerraform } from './synth/gcp-terraform';

export class GCPProvider {
  readonly name = 'gcp';

  synthesize(stack: Stack, _allStacks?: Stack[]): string {
    return emitGCPTerraform(stack);
  }
}
