import { Stack } from '@iacmp/core';
import { synthesize, GCPDeployment } from './synth/deployment-manager';

export class GCPProvider {
  readonly name = 'gcp';

  // allStacks: paridade de assinatura com AWSProvider (visão global pra
  // resolução cross-stack) — ainda não usado neste provider.
  synthesize(stack: Stack, _allStacks?: Stack[]): GCPDeployment {
    return synthesize(stack);
  }
}
