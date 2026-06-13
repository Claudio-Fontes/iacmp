import { Stack } from '@iacmp/core';
import { synthesize, GCPDeployment } from './synth/deployment-manager';

export class GCPProvider {
  readonly name = 'gcp';

  synthesize(stack: Stack): GCPDeployment {
    return synthesize(stack);
  }
}
