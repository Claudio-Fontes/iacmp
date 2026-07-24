import { Stack } from '@iacmp/core';
import { emitBicep } from './synth/bicep';

export class AzureProvider {
  readonly name = 'azure';

  synthesize(stack: Stack, allStacks?: Stack[], opts?: {
    accountTier?: 'free' | 'standard';
    sharedApim?: { name: string; resourceGroup: string; projectResourceGroup?: string };
    projectName?: string;
    moduleFilesOut?: Array<{ filename: string; content: string }>;
  }): string {
    return emitBicep(stack, { ...opts, allStacks });
  }
}
