import { Stack } from '@iacmp/core';
import { synthesize } from './synth/hcl';

export class TerraformProvider {
  readonly name = 'terraform';

  synthesize(stack: Stack): string {
    return synthesize(stack);
  }
}
