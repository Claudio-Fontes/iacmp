import { Stack, Network, Database, Fn, Policy, Storage, Compute, Secret, validateSemantics, cidrContains } from '../src';

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

describe('validateSemantics — integridade de referência', () => {
  test('Policy.IAM com attachTo inexistente é pego', () => {
    const s = new Stack('app');
    new Fn.Lambda(s, 'RealFn', { runtime: 'nodejs20', handler: 'h.handler', code: '.' });
    new Policy.IAM(s, 'P', { attachTo: 'TypoFn', attachType: 'lambda', statements: [{ effect: 'Allow', actions: ['s3:GetObject'] }] });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('TypoFn') && e.includes('attachTo'))).toBe(true);
  });

  test('Policy.IAM com attachTo válido passa', () => {
    const s = new Stack('app');
    new Fn.Lambda(s, 'RealFn', { runtime: 'nodejs20', handler: 'h.handler', code: '.' });
    new Policy.IAM(s, 'P', { attachTo: 'RealFn', attachType: 'lambda', statements: [{ effect: 'Allow', actions: ['s3:GetObject'] }] });
    expect(validateSemantics([s])).toEqual([]);
  });

  test('ApiGateway routes[].lambdaId inexistente é pego', () => {
    const s = new Stack('app');
    new Fn.Lambda(s, 'ListFn', { runtime: 'nodejs20', handler: 'h.handler', code: '.' });
    new Fn.ApiGateway(s, 'Api', { name: 'API', routes: [
      { method: 'GET', path: '/items', lambdaId: 'ListFn' },
      { method: 'POST', path: '/items', lambdaId: 'CreateFn' }, // não existe
    ] });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('CreateFn') && e.includes('lambdaId'))).toBe(true);
  });

  test('ApiGateway authorizerLambdaId inexistente é pego', () => {
    const s = new Stack('app');
    new Fn.Lambda(s, 'ProtFn', { runtime: 'nodejs20', handler: 'h.handler', code: '.' });
    new Fn.ApiGateway(s, 'Api', { name: 'API', authorizerLambdaId: 'AuthFnTypo', routes: [
      { method: 'GET', path: '/x', lambdaId: 'ProtFn' },
    ] });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('AuthFnTypo'))).toBe(true);
  });

  test('CDN bucketRef inexistente é pego', () => {
    const s = new Stack('app');
    new Storage.Bucket(s, 'AppBucket', { websiteHosting: false });
    new Network.CDN(s, 'CDN', { origins: [{ id: 'o', domainName: 'x.s3.amazonaws.com', bucketRef: 'BucketTypo' }] });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('BucketTypo') && e.includes('bucketRef'))).toBe(true);
  });

  test('CDN bucketRef válido passa', () => {
    const s = new Stack('app');
    new Storage.Bucket(s, 'AppBucket', { websiteHosting: false });
    new Network.CDN(s, 'CDN', { origins: [{ id: 'o', domainName: 'x.s3.amazonaws.com', bucketRef: 'AppBucket' }] });
    expect(validateSemantics([s])).toEqual([]);
  });
});

describe('validateSemantics — refs de env var', () => {
  test('env var X.Endpoint com id inexistente é pego', () => {
    const s = new Stack('app');
    new Database.SQL(s, 'AppDB', { engine: 'postgres' });
    new Fn.Lambda(s, 'Fn', { runtime: 'nodejs20', handler: 'h.handler', code: '.',
      environment: { DB_HOST: 'Typo.Endpoint' } });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('Typo') && e.includes('DB_HOST'))).toBe(true);
  });

  test('env var X.Endpoint com id correto passa', () => {
    const s = new Stack('app');
    new Database.SQL(s, 'AppDB', { engine: 'postgres' });
    new Fn.Lambda(s, 'Fn', { runtime: 'nodejs20', handler: 'h.handler', code: '.',
      environment: { DB_HOST: 'AppDB.Endpoint', DB_PORT: 'AppDB.Port', DB_PASSWORD: 'AppDB.Password' } });
    expect(validateSemantics([s])).toEqual([]);
  });

  test('env var literal comum não dispara falso positivo', () => {
    const s = new Stack('app');
    new Fn.Lambda(s, 'Fn', { runtime: 'nodejs20', handler: 'h.handler', code: '.',
      environment: { LOG_LEVEL: 'info', NODE_ENV: 'production', REGION: 'us-east-1' } });
    expect(validateSemantics([s])).toEqual([]);
  });
});

describe('validateSemantics — Load Balancer', () => {
  test('ALB sem subnetIds é pego (caso openai21)', () => {
    const s = new Stack('app');
    new Network.VPC(s, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    new Network.LoadBalancer(s, 'AppLB', { vpcId: 'AppVpc', type: 'application',
      listeners: [{ port: 443, protocol: 'HTTPS' }], targetGroups: [{ name: 'tg', port: 80, protocol: 'HTTP' }] });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('AppLB') && e.includes('subnetIds'))).toBe(true);
  });

  test('ALB com subnets em 2 AZs passa', () => {
    const s = new Stack('app');
    new Network.VPC(s, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    new Network.Subnet(s, 'Pub1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', public: true, availabilityZone: 'us-east-1a' });
    new Network.Subnet(s, 'Pub2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', public: true, availabilityZone: 'us-east-1b' });
    new Network.LoadBalancer(s, 'AppLB', { vpcId: 'AppVpc', type: 'application', subnetIds: ['Pub1', 'Pub2'],
      listeners: [{ port: 443, protocol: 'HTTPS' }], targetGroups: [{ name: 'tg', port: 80, protocol: 'HTTP' }] });
    expect(validateSemantics([s])).toEqual([]);
  });

  test('ALB com subnets na mesma AZ é pego', () => {
    const s = new Stack('app');
    new Network.VPC(s, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    new Network.Subnet(s, 'Pub1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', public: true, availabilityZone: 'us-east-1a' });
    new Network.Subnet(s, 'Pub2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', public: true, availabilityZone: 'us-east-1a' });
    new Network.LoadBalancer(s, 'AppLB', { vpcId: 'AppVpc', type: 'application', subnetIds: ['Pub1', 'Pub2'],
      listeners: [{ port: 443, protocol: 'HTTPS' }], targetGroups: [{ name: 'tg', port: 80, protocol: 'HTTP' }] });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('AZ'))).toBe(true);
  });
});

describe('validateSemantics — separação por camada', () => {
  test('monolito com 3+ camadas (security+compute+network) é pego (caso openai28)', () => {
    const s = new Stack('api-backend');
    new Secret.Vault(s, 'JwtSecret', { description: 'jwt' });
    new Fn.Lambda(s, 'AuthFn', { runtime: 'nodejs20', handler: 'h.handler', code: '.' });
    new Fn.ApiGateway(s, 'Api', { name: 'API', routes: [{ method: 'GET', path: '/x', lambdaId: 'AuthFn' }] });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('monolito') && e.includes('api-backend'))).toBe(true);
  });

  test('2 camadas (compute+database) é aceitável — não bloqueia', () => {
    const s = new Stack('app');
    new Fn.Lambda(s, 'Fn', { runtime: 'nodejs20', handler: 'h.handler', code: '.' });
    new Database.DynamoDB(s, 'Table', { partitionKey: 'id' });
    expect(validateSemantics([s]).filter(e => e.includes('monolito'))).toEqual([]);
  });

  test('uma camada (só network) não bloqueia mesmo com vários recursos', () => {
    const s = new Stack('net');
    new Network.VPC(s, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    new Network.Subnet(s, 'Sub', { vpcId: 'Vpc', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1a' });
    new Network.SecurityGroup(s, 'Sg', { vpcId: 'Vpc' });
    expect(validateSemantics([s]).filter(e => e.includes('monolito'))).toEqual([]);
  });

  test('stacks separadas (cada camada num arquivo) passa', () => {
    const net = new Stack('vpc'); new Network.VPC(net, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    const sec = new Stack('secret'); new Secret.Vault(sec, 'S', { description: 'x' });
    const comp = new Stack('api'); new Fn.Lambda(comp, 'Fn', { runtime: 'nodejs20', handler: 'h.handler', code: '.' });
    expect(validateSemantics([net, sec, comp]).filter(e => e.includes('monolito'))).toEqual([]);
  });
});

describe('validateSemantics — Compute em VPC', () => {
  test('Fargate sem subnets é pego (falha silenciosa no deploy)', () => {
    const s = new Stack('app');
    new Compute.Container(s, 'Api', { image: 'x:latest', cpu: 256, memory: 512, port: 3000 });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('Api') && e.includes('subnetIds'))).toBe(true);
  });

  test('Fargate com subnets passa', () => {
    const s = new Stack('app');
    new Compute.Container(s, 'Api', { image: 'x:latest', cpu: 256, memory: 512, port: 3000, subnetIds: ['subnet-a', 'subnet-b'] });
    expect(validateSemantics([s])).toEqual([]);
  });

  test('EKS sem subnets é pego', () => {
    const s = new Stack('app');
    new Compute.Kubernetes(s, 'Cluster', {});
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('Cluster') && e.includes('EKS'))).toBe(true);
  });
});

describe('validateSemantics — websiteHosting + OAC', () => {
  test('bucket websiteHosting:true referenciado por CDN via bucketRef é pego (caso openai34)', () => {
    const s = new Stack('site');
    new Storage.Bucket(s, 'SiteBucket', { websiteHosting: true });
    new Network.CDN(s, 'CDN', { origins: [{ id: 'o', domainName: 'x', bucketRef: 'SiteBucket' }] });
    const errors = validateSemantics([s]);
    expect(errors.some(e => e.includes('SiteBucket') && e.includes('websiteHosting'))).toBe(true);
  });

  test('bucket privado (websiteHosting:false) + CDN OAC passa', () => {
    const s = new Stack('site');
    new Storage.Bucket(s, 'SiteBucket', { websiteHosting: false });
    new Network.CDN(s, 'CDN', { origins: [{ id: 'o', domainName: 'x', bucketRef: 'SiteBucket' }] });
    expect(validateSemantics([s]).filter(e => e.includes('websiteHosting'))).toEqual([]);
  });

  test('websiteHosting:true SEM CDN (site direto) não bloqueia', () => {
    const s = new Stack('site');
    new Storage.Bucket(s, 'SiteBucket', { websiteHosting: true });
    expect(validateSemantics([s]).filter(e => e.includes('websiteHosting'))).toEqual([]);
  });
});

describe('validateSemantics — free tier', () => {
  function dbOnly(props: any): Stack[] {
    const net = new Stack('net');
    new Network.VPC(net, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
    new Network.Subnet(net, 'Sub1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1a' });
    new Network.Subnet(net, 'Sub2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', availabilityZone: 'us-east-1b' });
    new Network.SecurityGroup(net, 'DBSG', { vpcId: 'AppVpc',
      ingressRules: [{ protocol: 'tcp', fromPort: 5432, toPort: 5432, cidr: '10.0.0.0/16' }] });
    const db = new Stack('db');
    new Database.SQL(db, 'AppDB', { subnetIds: ['Sub1', 'Sub2'], securityGroupIds: ['DBSG'], ...props });
    return [net, db];
  }

  test('free: bloqueia engine Aurora', () => {
    const errors = validateSemantics(dbOnly({ engine: 'aurora-postgresql' }), { accountTier: 'free' });
    expect(errors.some(e => e.includes('Aurora') && e.includes('free tier'))).toBe(true);
  });

  test('free: bloqueia backupRetentionDays > 0', () => {
    const errors = validateSemantics(dbOnly({ engine: 'postgres', backupRetentionDays: 7 }), { accountTier: 'free' });
    expect(errors.some(e => e.includes('backupRetentionDays'))).toBe(true);
  });

  test('free: bloqueia storageEncrypted true', () => {
    const errors = validateSemantics(dbOnly({ engine: 'postgres', storageEncrypted: true }), { accountTier: 'free' });
    expect(errors.some(e => e.includes('storageEncrypted'))).toBe(true);
  });

  test('free: postgres simples passa', () => {
    expect(validateSemantics(dbOnly({ engine: 'postgres' }), { accountTier: 'free' })).toEqual([]);
  });

  test('standard: Aurora + backup + cripto passam', () => {
    const errors = validateSemantics(
      dbOnly({ engine: 'aurora-postgresql', backupRetentionDays: 7, storageEncrypted: true }),
      { accountTier: 'standard' },
    );
    expect(errors).toEqual([]);
  });

  test('sem profile: assume free e bloqueia Aurora', () => {
    const errors = validateSemantics(dbOnly({ engine: 'aurora-mysql' }));
    expect(errors.some(e => e.includes('Aurora'))).toBe(true);
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
