import { Stack } from '@iacmp/core';
import { synthesize } from './synth/hcl';

export class TerraformProvider {
  readonly name = 'terraform';

  // allStacks: paridade de assinatura com AWSProvider (visão global pra
  // resolução cross-stack) — ainda não usado neste provider.
  synthesize(stack: Stack, _allStacks?: Stack[]): string {
    return synthesize(stack);
  }
}
