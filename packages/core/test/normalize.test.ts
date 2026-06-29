import { Stack, Network, Database, applyEnvironmentDefaults, validateSemantics } from '../src';

describe('applyEnvironmentDefaults — AZ de subnet', () => {
  test('preenche AZ distinta por VPC quando não informada', () => {
    const s = new Stack('net');
    new Network.VPC(s, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    const sub1 = new Network.Subnet(s, 'Sub1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24' });
    const sub2 = new Network.Subnet(s, 'Sub2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24' });

    applyEnvironmentDefaults([s], { accountTier: 'free', region: 'us-east-1' });

    expect((sub1.props as any).availabilityZone).toBe('us-east-1a');
    expect((sub2.props as any).availabilityZone).toBe('us-east-1b');
  });

  test('respeita AZ explícita (valor do usuário vence)', () => {
    const s = new Stack('net');
    new Network.VPC(s, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    const sub = new Network.Subnet(s, 'Sub1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1f' });

    applyEnvironmentDefaults([s], { accountTier: 'free', region: 'us-east-1' });

    expect((sub.props as any).availabilityZone).toBe('us-east-1f');
  });

  test('usa availabilityZones do perfil quando fornecidas', () => {
    const s = new Stack('net');
    new Network.VPC(s, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    const sub1 = new Network.Subnet(s, 'Sub1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24' });
    const sub2 = new Network.Subnet(s, 'Sub2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24' });

    applyEnvironmentDefaults([s], { accountTier: 'free', region: 'sa-east-1', availabilityZones: ['sa-east-1a', 'sa-east-1c'] });

    expect((sub1.props as any).availabilityZone).toBe('sa-east-1a');
    expect((sub2.props as any).availabilityZone).toBe('sa-east-1c');
  });

  test('região diferente reflete nas AZs derivadas', () => {
    const s = new Stack('net');
    new Network.VPC(s, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    const sub1 = new Network.Subnet(s, 'Sub1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24' });

    applyEnvironmentDefaults([s], { accountTier: 'free', region: 'eu-west-1' });

    expect((sub1.props as any).availabilityZone).toBe('eu-west-1a');
  });
});

describe('applyEnvironmentDefaults — porta do SG do banco', () => {
  test('adiciona a porta do engine quando o SG não a cobre', () => {
    const s = new Stack('net');
    new Network.VPC(s, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    const sg = new Network.SecurityGroup(s, 'DBSG', { vpcId: 'AppVpc',
      ingressRules: [{ protocol: 'tcp', fromPort: 3306, toPort: 3306, cidr: '10.0.0.0/16' }] });
    new Database.SQL(s, 'AppDB', { engine: 'postgres', securityGroupIds: ['DBSG'] });

    applyEnvironmentDefaults([s], { accountTier: 'free' });

    const rules = (sg.props as any).ingressRules;
    expect(rules.some((r: any) => r.fromPort === 5432 && r.toPort === 5432)).toBe(true);
    // CIDR derivado da VPC
    expect(rules.find((r: any) => r.fromPort === 5432).cidr).toBe('10.0.0.0/16');
  });

  test('não duplica quando a porta já é coberta', () => {
    const s = new Stack('net');
    new Network.SecurityGroup(s, 'DBSG', { vpcId: 'AppVpc',
      ingressRules: [{ protocol: 'tcp', fromPort: 5432, toPort: 5432, cidr: '10.0.0.0/16' }] });
    new Database.SQL(s, 'AppDB', { engine: 'postgres', securityGroupIds: ['DBSG'] });
    const sg = s.constructs.find(c => c.id === 'DBSG')!;

    applyEnvironmentDefaults([s], { accountTier: 'free' });

    expect((sg.props as any).ingressRules).toHaveLength(1);
  });

  test('SG sem regras ganha a porta do engine', () => {
    const s = new Stack('net');
    new Network.VPC(s, 'AppVpc', { cidr: '10.1.0.0/16', maxAzs: 0 });
    const sg = new Network.SecurityGroup(s, 'DBSG', { vpcId: 'AppVpc' });
    new Database.SQL(s, 'AppDB', { engine: 'mysql', securityGroupIds: ['DBSG'] });

    applyEnvironmentDefaults([s], { accountTier: 'free' });

    const rules = (sg.props as any).ingressRules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ protocol: 'tcp', fromPort: 3306, toPort: 3306, cidr: '10.1.0.0/16' });
  });
});

describe('normalização + validação compõem', () => {
  test('subnets sem AZ + SG sem porta: normalizar elimina os erros de validação', () => {
    const net = new Stack('net');
    new Network.VPC(net, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    new Network.Subnet(net, 'Sub1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24' });
    new Network.Subnet(net, 'Sub2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24' });
    new Network.SecurityGroup(net, 'DBSG', { vpcId: 'AppVpc' });
    const db = new Stack('db');
    new Database.SQL(db, 'AppDB', { engine: 'postgres', subnetIds: ['Sub1', 'Sub2'], securityGroupIds: ['DBSG'] });

    // antes de normalizar: erros de AZ e de porta
    expect(validateSemantics([net, db]).length).toBeGreaterThan(0);

    applyEnvironmentDefaults([net, db], { accountTier: 'free', region: 'us-east-1' });

    // depois: sem erros
    expect(validateSemantics([net, db])).toEqual([]);
  });
});
