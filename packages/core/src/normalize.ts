import { Stack, BaseConstruct } from './stack';
import { EnvironmentProfile, DEFAULT_PROFILE } from './profile';
import { SQLEngine } from './constructs/database';
import { defaultPortForEngine } from './knowledge/database';

/**
 * Passada de NORMALIZAÇÃO: preenche, in-place, defaults de infraestrutura que
 * podem ser DERIVADOS do perfil/contexto — antes da validação e do synth. O
 * objetivo é que o usuário (e a IA) não precisem mais escrever esses valores no
 * .ts, e que os bugs recorrentes (subnet sem AZ, SG sem a porta do banco)
 * deixem de existir na origem, não só sejam detectados depois.
 *
 * Roda sobre TODAS as stacks do projeto. É idempotente: rodar de novo não muda
 * nada (props já preenchidas são respeitadas — valor explícito sempre vence).
 */
export function applyEnvironmentDefaults(
  stacks: Stack[],
  profile: EnvironmentProfile = DEFAULT_PROFILE,
): void {
  const byId = new Map<string, BaseConstruct>();
  for (const s of stacks) for (const c of s.constructs) byId.set(c.id, c);

  applySubnetAzDefaults(stacks, profile);
  applyDatabaseSecurityGroupPort(stacks, byId);
}

/**
 * Subnets sem `availabilityZone` recebem uma AZ derivada do perfil, distribuída
 * em round-robin por VPC na ordem de declaração — de modo que duas subnets de
 * uma mesma VPC caiam em AZs distintas (requisito de DB Subnet Group do RDS).
 */
function applySubnetAzDefaults(stacks: Stack[], profile: EnvironmentProfile): void {
  const azList =
    profile.availabilityZones && profile.availabilityZones.length > 0
      ? profile.availabilityZones
      : deriveAzList(profile.region ?? 'us-east-1');

  const subnetsByVpc = new Map<string, BaseConstruct[]>();
  for (const s of stacks) {
    for (const c of s.constructs) {
      if (c.type !== 'Network.Subnet') continue;
      const vpcId = ((c.props as Record<string, unknown>).vpcId as string) ?? '__novpc__';
      const list = subnetsByVpc.get(vpcId) ?? [];
      list.push(c);
      subnetsByVpc.set(vpcId, list);
    }
  }

  for (const subnets of subnetsByVpc.values()) {
    subnets.forEach((sub, i) => {
      const p = sub.props as Record<string, unknown>;
      if (!p.availabilityZone) p.availabilityZone = azList[i % azList.length];
    });
  }
}

/**
 * Para cada Database.SQL, garante que os Security Groups que o protegem abram a
 * porta do engine. Se nenhuma ingressRule cobre a porta, adiciona uma para o
 * CIDR da VPC do SG (ou 10.0.0.0/16 como fallback). Só ADICIONA — nunca remove
 * regras que o usuário declarou.
 */
function applyDatabaseSecurityGroupPort(stacks: Stack[], byId: Map<string, BaseConstruct>): void {
  for (const s of stacks) {
    for (const c of s.constructs) {
      if (c.type !== 'Database.SQL') continue;
      const dp = c.props as Record<string, unknown>;
      const port = defaultPortForEngine(dp.engine as SQLEngine);
      const sgIds = (dp.securityGroupIds as string[] | undefined) ?? [];
      for (const sgId of sgIds) {
        const sg = byId.get(sgId);
        if (!sg || sg.type !== 'Network.SecurityGroup') continue;
        const sgp = sg.props as Record<string, unknown>;
        const rules = (sgp.ingressRules as Array<Record<string, unknown>> | undefined) ?? [];
        const covered = rules.some(r => ruleCoversPort(r, port));
        if (!covered) {
          const vpcCidr = resolveVpcCidr(sgp.vpcId as string | undefined, byId) ?? '10.0.0.0/16';
          rules.push({ protocol: 'tcp', fromPort: port, toPort: port, cidr: vpcCidr });
          sgp.ingressRules = rules;
        }
      }
    }
  }
}

/** Deriva AZs a/b/c a partir de uma região (convenção AWS); o perfil pode
 *  sobrescrever via availabilityZones para outros providers/casos. */
function deriveAzList(region: string): string[] {
  return ['a', 'b', 'c'].map(letter => `${region}${letter}`);
}

function resolveVpcCidr(vpcId: string | undefined, byId: Map<string, BaseConstruct>): string | undefined {
  if (!vpcId) return undefined;
  const vpc = byId.get(vpcId);
  if (!vpc || vpc.type !== 'Network.VPC') return undefined;
  return (vpc.props as Record<string, unknown>).cidr as string | undefined;
}

function ruleCoversPort(rule: Record<string, unknown>, port: number): boolean {
  if (rule.protocol === '-1') return true;
  const from = rule.fromPort as number | undefined;
  const to = rule.toPort as number | undefined;
  if (from === undefined || to === undefined) return false;
  return from <= port && port <= to;
}
