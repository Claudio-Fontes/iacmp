import { Stack, prepareStacksForSynth, type EnvironmentProfile } from '@iacmp/core';
import { emitGCPTerraform, emitGCPResources, emitGCPProviders } from './synth/gcp-terraform';

// `cloud: 'gcp'` é o que `validateSemantics`/`prepareStacksForSynth` (core)
// usam para suprimir regras AWS-only (ex: RDS/ALB/EKS exigindo ≥2 AZs nas
// subnets, round-robin de AZ) — mesmo mecanismo que o Azure já usa
// (`emitBicep` passa `{ accountTier, cloud: 'azure' }`, ver bicep.ts). Sem
// isso, `prepareStacksForSynth` trata `profile.cloud` ausente como AWS
// (backward compat — ver validate.ts), e um Database.SQL GCP com 1 subnet
// falhava o synth por uma regra que não existe no Cloud SQL.
const DEFAULT_GCP_PROFILE: EnvironmentProfile = { accountTier: 'free', cloud: 'gcp' };

export class GCPProvider {
  readonly name = 'gcp';

  synthesize(stack: Stack, allStacks?: Stack[], profile?: EnvironmentProfile): string {
    // Validação semântica provider-agnóstica com o universo completo (o MESMO
    // ponto de entrada do AWS/Azure). Só roda com allStacks — refs cross-stack
    // exigem ver todas as stacks; chamadas isoladas (unit test) pulam.
    if (allStacks && allStacks.length > 0) {
      prepareStacksForSynth(allStacks, { ...DEFAULT_GCP_PROFILE, ...profile, cloud: 'gcp' });
    }
    return emitGCPTerraform(stack, allStacks && allStacks.length > 0 ? allStacks : [stack]);
  }

  /**
   * `resource{}`/`output{}` de UMA stack, sem os blocos `terraform`/`provider`/
   * `variable` (ver synthesizeProviders) — o que `iacmp synth` grava em
   * `<stackName>.tf.json` para projetos multi-stack (ver docs/em emit/gcp-terraform.ts).
   */
  synthesizeResources(stack: Stack, allStacks?: Stack[], profile?: EnvironmentProfile): string {
    const universe = allStacks && allStacks.length > 0 ? allStacks : [stack];
    if (allStacks && allStacks.length > 0) {
      prepareStacksForSynth(allStacks, { ...DEFAULT_GCP_PROFILE, ...profile, cloud: 'gcp' });
    }
    return emitGCPResources(stack, universe);
  }

  /**
   * Blocos `terraform{required_providers}` + `provider{}` + `variable{}`
   * compartilhados do projeto inteiro — UMA vez por diretório de synth (ver
   * `_providers.tf.json` em synth.ts), união dos requisitos de TODAS as stacks.
   */
  synthesizeProviders(allStacks: Stack[]): string {
    return emitGCPProviders(allStacks);
  }
}
