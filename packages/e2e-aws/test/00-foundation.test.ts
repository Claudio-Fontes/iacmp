import { makeProject, rmrf, deployReal, destroyReal, describeStack } from '../support/runner';
import { FOUNDATION_STACK_NAME, foundationStackJs, parseFoundationOutputs } from '../support/foundation';

/**
 * Primeiro teste real de toda a Fase B/C: valida que o harness consegue
 * deployar e destruir um recurso de verdade na AWS de ponta a ponta antes de
 * confiar nele pros ~200 testes restantes (EKS/RDS/etc). VPC é o recurso mais
 * barato/rápido possível (sem NAT Gateway) — por isso vem primeiro.
 */
describe('foundation (VPC + Security Group) — deploy/destroy real na AWS', () => {
  test('sobe a VPC compartilhada, confirma CREATE_COMPLETE e os IDs reais nos Outputs, depois destroi', () => {
    const dir = makeProject({
      provider: 'aws',
      // O nome real da stack CloudFormation vem do NOME DO ARQUIVO (não do
      // `new Stack('...')` interno) — mantemos os dois iguais de propósito
      // pra não ter ambiguidade em nenhum dos ~200 testes.
      stacks: { [`${FOUNDATION_STACK_NAME}.js`]: foundationStackJs() },
    });

    try {
      deployReal(dir);

      const { StackStatus, Outputs } = describeStack(FOUNDATION_STACK_NAME);
      expect(StackStatus).toBe('CREATE_COMPLETE');

      const out = parseFoundationOutputs(Outputs);
      expect(out.vpcId).toMatch(/^vpc-/);
      expect(out.securityGroupId).toMatch(/^sg-/);
      expect(out.publicSubnetIds).toHaveLength(2);
      expect(out.privateSubnetIds).toHaveLength(2);
      for (const id of [...out.publicSubnetIds, ...out.privateSubnetIds]) {
        expect(id).toMatch(/^subnet-/);
      }
    } finally {
      destroyReal(dir);
      rmrf(dir);
    }
  });
});
