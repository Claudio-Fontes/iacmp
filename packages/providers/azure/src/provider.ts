import { Stack } from '@iacmp/core';
import { emitBicep } from './synth/bicep';

export class AzureProvider {
  readonly name = 'azure';

  synthesize(stack: Stack, _allStacks?: Stack[], opts?: { accountTier?: 'free' | 'standard' }): string {
    return emitBicep(stack, opts);
  }
}
