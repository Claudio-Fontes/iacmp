/**
 * Stack compartilhada (VPC + Security Group) — deployada UMA VEZ pros outros
 * testes reaproveitarem subnets/SG reais em vez de cada um criar sua própria
 * VPC (a conta tem cota default de 5 VPCs por região). Sem NAT Gateway de
 * propósito (custaria ~US$0.045/h extra) — compute de teste vai na subnet
 * PÚBLICA, atalho válido só pra teste, nunca recomendado pra produção real.
 */
export const FOUNDATION_STACK_NAME = 'iacmp-e2e-foundation';

export function foundationStackJs(): string {
  return `const { Stack, Network } = require('@iacmp/core');
const stack = new Stack('${FOUNDATION_STACK_NAME}');
new Network.VPC(stack, 'Vpc', { cidr: '10.42.0.0/16', maxAzs: 2 });
new Network.SecurityGroup(stack, 'Sg', {
  vpcId: { Ref: 'Vpc' },
  description: 'iacmp e2e foundation - shared test security group',
  ingressRules: [
    { protocol: 'tcp', fromPort: 22, toPort: 22, cidr: '10.42.0.0/16', description: 'SSH dentro da VPC de teste' },
    { protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '0.0.0.0/0', description: 'HTTP pros testes de ALB/web' },
    { protocol: 'tcp', fromPort: 443, toPort: 443, cidr: '0.0.0.0/0', description: 'HTTPS pros testes de ALB/web' },
  ],
});
module.exports = stack;
`;
}

export interface FoundationOutputs {
  vpcId: string;
  securityGroupId: string;
  publicSubnetIds: string[];
  privateSubnetIds: string[];
}

/** Extrai os IDs reais da stack já deployada, lendo os Outputs (ver Fase A: VPC/Subnet/SG agora exportam Outputs). */
export function parseFoundationOutputs(outputs: Array<{ OutputKey: string; OutputValue: string }>): FoundationOutputs {
  const byKey = new Map(outputs.map(o => [o.OutputKey, o.OutputValue]));
  const vpcId = byKey.get('VpcVpcId');
  const securityGroupId = byKey.get('SgGroupId');
  if (!vpcId || !securityGroupId) {
    throw new Error(`Outputs da foundation incompletos: ${JSON.stringify(outputs)}`);
  }
  const publicSubnetIds = [...byKey.entries()]
    .filter(([k]) => /^VpcPublicSubnet.+SubnetId$/.test(k))
    .map(([, v]) => v);
  const privateSubnetIds = [...byKey.entries()]
    .filter(([k]) => /^VpcPrivateSubnet.+SubnetId$/.test(k))
    .map(([, v]) => v);
  return { vpcId, securityGroupId, publicSubnetIds, privateSubnetIds };
}
