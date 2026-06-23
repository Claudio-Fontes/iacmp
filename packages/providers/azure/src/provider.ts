import { Stack } from '@iacmp/core';
import { synthesize, ARMTemplate } from './synth/arm';

export class AzureProvider {
  readonly name = 'azure';

  // allStacks: paridade de assinatura com AWSProvider (visão global pra
  // resolução cross-stack) — ainda não usado neste provider.
  synthesize(stack: Stack, _allStacks?: Stack[]): ARMTemplate {
    return synthesize(stack);
  }
}
