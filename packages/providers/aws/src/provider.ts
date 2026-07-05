import { Stack, EnvironmentProfile } from '@iacmp/core';
import { synthesize, CloudFormationTemplate } from './synth/cloudformation';

export class AWSProvider {
  readonly name = 'aws';

  synthesize(stack: Stack, allStacks?: Stack[], profile?: EnvironmentProfile, projectName?: string): CloudFormationTemplate {
    return synthesize(stack, allStacks, profile, projectName);
  }
}
