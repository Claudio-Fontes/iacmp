import { Stack, Network, Database, Fn, validateSemantics, cidrContains } from '../src';

function vpcStack(maxAzs = 0): Stack {
  const s = new Stack('app-vpc');
  new Network.VPC(s, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs });
  new Network.Subnet(s, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', public: false, availabilityZone: 'us-east-1a' });
  new Network.Subnet(s, 'PrivateSubnet2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', public: false, availabilityZone: 'us-east-1b' });
  new Network.SecurityGroup(s, 'DBSG', { vpcId: 'AppVpc', description: 'db',
    ingressRules: [{ protocol: 'tcp', fromPort: 5432, toPort: 5432, cidr: '10.0.0.0/16' }] });
  return s;
}

function dbStack(): Stack {
  const s = new Stack('app-db');
  new Database.SQL(s, 'AppDB', {
    engine: 'postgres',
    subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],
    securityGroupIds: ['DBSG'],
  });
  return s;
}

describe('validateSemantics', () => {
  test('arquitetura correta não gera erros', () => {
    expect(validateSemantics([vpcStack(), dbStack()])).toEqual([]);
  });

  test('detecta porta de SG incompatível com engine', () => {
    const vpc = new Stack('app-vpc');
    new Network.VPC(vpc, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    new Network.Subnet(vpc, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1a' });
    new Network.Subnet(vpc, 'PrivateSubnet2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', availabilityZone: 'us-east-1b' });
    // engine postgres (5432) mas SG abre 3306
    new Network.SecurityGroup(vpc, 'DBSG', { vpcId: 'AppVpc',
      ingressRules: [{ protocol: 'tcp', fromPort: 3306, toPort: 3306, cidr: '10.0.0.0/16' }] });
    const errors = validateSemantics([vpc, dbStack()]);
    expect(errors.some(e => e.includes('porta 5432'))).toBe(true);
  });

  test('aceita regra que cobre a porta num range', () => {
    const vpc = new Stack('app-vpc');
    new Network.VPC(vpc, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    new Network.Subnet(vpc, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1a' });
    new Network.Subnet(vpc, 'PrivateSubnet2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', availabilityZone: 'us-east-1b' });
    new Network.SecurityGroup(vpc, 'DBSG', { vpcId: 'AppVpc',
      ingressRules: [{ protocol: 'tcp', fromPort: 5000, toPort: 6000, cidr: '10.0.0.0/16' }] });
    expect(validateSemantics([vpc, dbStack()])).toEqual([]);
  });

  test('detecta RDS com subnets na mesma AZ', () => {
    const vpc = new Stack('app-vpc');
    new Network.VPC(vpc, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    new Network.Subnet(vpc, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1a' });
    new Network.Subnet(vpc, 'PrivateSubnet2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', availabilityZone: 'us-east-1a' });
    new Network.SecurityGroup(vpc, 'DBSG', { vpcId: 'AppVpc',
      ingressRules: [{ protocol: 'tcp', fromPort: 5432, toPort: 5432 }] });
    const errors = validateSemantics([vpc, dbStack()]);
    expect(errors.some(e => e.includes('Availability Zone'))).toBe(true);
  });

  test('detecta RDS com subnets sem AZ explícita', () => {
    const vpc = new Stack('app-vpc');
    new Network.VPC(vpc, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    new Network.Subnet(vpc, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24' });
    new Network.Subnet(vpc, 'PrivateSubnet2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24' });
    new Network.SecurityGroup(vpc, 'DBSG', { vpcId: 'AppVpc',
      ingressRules: [{ protocol: 'tcp', fromPort: 5432, toPort: 5432 }] });
    const errors = validateSemantics([vpc, dbStack()]);
    expect(errors.some(e => e.includes('Availability Zone'))).toBe(true);
  });

  test('detecta maxAzs > 0 com subnets explícitas', () => {
    const errors = validateSemantics([vpcStack(2), dbStack()]);
    expect(errors.some(e => e.includes('maxAzs'))).toBe(true);
  });

  test('detecta CIDR de subnet fora do CIDR da VPC', () => {
    const s = new Stack('app-vpc');
    new Network.VPC(s, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    new Network.Subnet(s, 'BadSubnet', { vpcId: 'AppVpc', cidr: '192.168.1.0/24', availabilityZone: 'us-east-1a' });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('fora do CIDR'))).toBe(true);
  });

  test('detecta referência quebrada', () => {
    const s = new Stack('app');
    new Fn.Lambda(s, 'Fn1', { runtime: 'nodejs20', handler: 'h.handler', code: '.', vpcId: 'NaoExiste', subnetIds: ['SubX'] });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('NaoExiste'))).toBe(true);
    expect(errors.some(e => e.includes('SubX'))).toBe(true);
  });

  test('aceita id literal de infra existente', () => {
    const s = new Stack('app');
    new Fn.Lambda(s, 'Fn1', { runtime: 'nodejs20', handler: 'h.handler', code: '.', vpcId: 'vpc-12345', subnetIds: ['subnet-abc', 'subnet-def'] });
    expect(validateSemantics([s])).toEqual([]);
  });
});

describe('cidrContains', () => {
  test('contido', () => {
    expect(cidrContains('10.0.0.0/16', '10.0.1.0/24')).toBe(true);
    expect(cidrContains('10.0.0.0/16', '10.0.0.0/16')).toBe(true);
  });
  test('não contido', () => {
    expect(cidrContains('10.0.0.0/16', '192.168.1.0/24')).toBe(false);
    expect(cidrContains('10.0.0.0/24', '10.0.0.0/16')).toBe(false); // inner maior
  });
});
