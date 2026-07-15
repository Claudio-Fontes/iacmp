import { Stack, prepareStacksForSynth } from '@iacmp/core';
import { emitGCPTerraform } from './synth/gcp-terraform';

export class GCPProvider {
  readonly name = 'gcp';

  synthesize(stack: Stack, allStacks?: Stack[]): string {
    // Validação semântica provider-agnóstica com o universo completo (o MESMO
    // ponto de entrada do AWS/Azure). Só roda com allStacks — refs cross-stack
    // exigem ver todas as stacks; chamadas isoladas (unit test) pulam.
    if (allStacks && allStacks.length > 0) {
      prepareStacksForSynth(allStacks);
    }
    return emitGCPTerraform(stack);
  }
}
