import { Stack } from '@iacmp/core';
import { synthesize, ARMTemplate } from './synth/arm';

export class AzureProvider {
  readonly name = 'azure';

  synthesize(stack: Stack): ARMTemplate {
    return synthesize(stack);
  }
}
