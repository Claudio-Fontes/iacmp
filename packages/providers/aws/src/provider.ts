import { Stack } from '@iacmp/core';
import { synthesize, CloudFormationTemplate } from './synth/cloudformation';

export class AWSProvider {
  readonly name = 'aws';

  synthesize(stack: Stack, allStacks?: Stack[]): CloudFormationTemplate {
    return synthesize(stack, allStacks);
  }
}
