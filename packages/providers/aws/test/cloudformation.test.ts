import { Stack, Compute, Storage, Network, Database, Fn, Cache, Messaging, Secret, Custom } from '@iacmp/core';
import { AWSProvider } from '../src';

describe('AWSProvider', () => {
  let stack: Stack;
  let provider: AWSProvider;

  beforeEach(() => {
    stack = new Stack('test-stack', { region: 'us-east-1' });
    provider = new AWSProvider();
  });

  test('sintetiza stack vazia', () => {
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.AWSTemplateFormatVersion).toBe('2010-09-09');
    expect(tpl.Resources).toEqual({});
  });

  test('Compute.Instance → AWS::EC2::Instance', () => {
    new Compute.Instance(stack, 'Web', { instanceType: 'small', image: 'ubuntu-22.04' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Web.Type).toBe('AWS::EC2::Instance');
    expect(tpl.Resources.Web.Properties.InstanceType).toBe('t3.small');
  });

  test('Storage.Bucket → AWS::S3::Bucket com versioning', () => {
    new Storage.Bucket(stack, 'Assets', { versioning: true });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Assets.Type).toBe('AWS::S3::Bucket');
    expect(tpl.Resources.Assets.Properties.VersioningConfiguration.Status).toBe('Enabled');
  });

  test('Storage.Bucket → AWS::S3::Bucket sem versioning', () => {
    new Storage.Bucket(stack, 'Assets', { versioning: false });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Assets.Properties.VersioningConfiguration.Status).toBe('Suspended');
  });

  test('Network.VPC → AWS::EC2::VPC', () => {
    new Network.VPC(stack, 'Rede', { cidr: '192.168.0.0/16' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Rede.Type).toBe('AWS::EC2::VPC');
    expect(tpl.Resources.Rede.Properties.CidrBlock).toBe('192.168.0.0/16');
  });

  test('Database.SQL mysql → AWS::RDS::DBInstance', () => {
    new Database.SQL(stack, 'DB', { engine: 'mysql' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DB.Type).toBe('AWS::RDS::DBInstance');
    expect(tpl.Resources.DB.Properties.Engine).toBe('mysql');
  });

  test('Fn.Lambda → AWS::Lambda::Function', () => {
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Handler.Type).toBe('AWS::Lambda::Function');
    expect(tpl.Resources.Handler.Properties.Runtime).toBe('nodejs20.x');
  });

  test('instanceType mapping: small→t3.small, medium→t3.medium, large→t3.large', () => {
    (['small', 'medium', 'large'] as const).forEach((size, i) => {
      const s = new Stack(`s${i}`);
      new Compute.Instance(s, 'W', { instanceType: size, image: 'img' });
      const tpl = provider.synthesize(s) as any;
      const expected = { small: 't3.small', medium: 't3.medium', large: 't3.large' }[size];
      expect(tpl.Resources.W.Properties.InstanceType).toBe(expected);
    });
  });

  test('Database.SQL postgres → Engine: postgres', () => {
    new Database.SQL(stack, 'DB', { engine: 'postgres' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DB.Properties.Engine).toBe('postgres');
  });

  test('Database.SQL oracle → Engine começa com oracle-', () => {
    new Database.SQL(stack, 'DB', { engine: 'oracle' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DB.Properties.Engine).toMatch(/^oracle-/);
  });

  test('Database.SQL sqlserver → Engine começa com sqlserver-', () => {
    new Database.SQL(stack, 'DB', { engine: 'sqlserver' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DB.Properties.Engine).toMatch(/^sqlserver-/);
  });

  test('Database.SQL mariadb → Engine: mariadb', () => {
    new Database.SQL(stack, 'DB', { engine: 'mariadb' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DB.Properties.Engine).toBe('mariadb');
  });

  test('Compute.Instance windows-2022 → ImageId contém Windows_Server-2022', () => {
    new Compute.Instance(stack, 'Win', { instanceType: 'small', image: 'windows-2022' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Win.Properties.ImageId).toContain('Windows_Server-2022');
  });

  test('Compute.Instance amazon-linux-2023 → ImageId contém al2023', () => {
    new Compute.Instance(stack, 'AL', { instanceType: 'small', image: 'amazon-linux-2023' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.AL.Properties.ImageId).toContain('al2023');
  });

  test('Cache.Redis → AWS::ElastiCache::ReplicationGroup', () => {
    new Cache.Redis(stack, 'RedisCache', { nodeType: 'small' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.RedisCache.Type).toBe('AWS::ElastiCache::ReplicationGroup');
  });

  test('Messaging.Queue → AWS::SQS::Queue', () => {
    new Messaging.Queue(stack, 'MyQueue', {});
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.MyQueue.Type).toBe('AWS::SQS::Queue');
  });

  test('Fn.Lambda python3.12 → runtime contém python', () => {
    new Fn.Lambda(stack, 'PyHandler', { runtime: 'python3.12', handler: 'main.handler', code: 'dist/' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.PyHandler.Properties.Runtime).toContain('python');
  });

  test('Secret.Vault → AWS::SecretsManager::Secret', () => {
    new Secret.Vault(stack, 'MySecret', {});
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.MySecret.Type).toBe('AWS::SecretsManager::Secret');
  });

  // ── Regressao TEST-02 ────────────────────────────────────────────────
  test('regressao: Database.SQL → DeletionPolicy presente (Snapshot por default)', () => {
    new Database.SQL(stack, 'DB', { engine: 'mysql' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DB.DeletionPolicy).toBe('Snapshot');
  });

  test('regressao: Database.SQL com deletionProtection → DeletionPolicy Retain', () => {
    new Database.SQL(stack, 'DB', { engine: 'mysql', deletionProtection: true });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DB.DeletionPolicy).toBe('Retain');
  });

  test('regressao: Database.DocumentDB → DeletionPolicy presente no cluster', () => {
    new Database.DocumentDB(stack, 'Docs', { instances: 1 });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DocsCluster.DeletionPolicy).toBe('Snapshot');
  });

  test('regressao: Database.DynamoDB → DeletionPolicy Retain', () => {
    new Database.DynamoDB(stack, 'Tab', { partitionKey: 'id' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Tab.DeletionPolicy).toBe('Retain');
  });

  test('regressao: Fn.Lambda Environment.Variables sai como objeto (nao envelope name/value)', () => {
    new Fn.Lambda(stack, 'Handler', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: 'dist/',
      environment: { FOO: 'bar', BAZ: 'qux' },
    });
    const tpl = provider.synthesize(stack) as any;
    const env = tpl.Resources.Handler.Properties.Environment;
    expect(env).toBeDefined();
    expect(env.Variables).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('regressao: Fn.Lambda sem environment → propriedade omitida', () => {
    new Fn.Lambda(stack, 'Handler', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: 'dist/',
    });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Handler.Properties.Environment).toBeUndefined();
  });

  test('regressao: Network.VPC com maxAzs=2 → gera 2 subnets publicas e 2 privadas', () => {
    new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 } as any);
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.VpcPublicSubnetA).toBeDefined();
    expect(tpl.Resources.VpcPublicSubnetB).toBeDefined();
    expect(tpl.Resources.VpcPublicSubnetC).toBeUndefined();
    expect(tpl.Resources.VpcPrivateSubnetA).toBeDefined();
    expect(tpl.Resources.VpcPrivateSubnetB).toBeDefined();
    expect(tpl.Resources.VpcIGW).toBeDefined();
  });

  test('regressao: Network.VPC com maxAzs=3 → gera 3 subnets publicas e 3 privadas', () => {
    new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 3 } as any);
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.VpcPublicSubnetA).toBeDefined();
    expect(tpl.Resources.VpcPublicSubnetB).toBeDefined();
    expect(tpl.Resources.VpcPublicSubnetC).toBeDefined();
    expect(tpl.Resources.VpcPublicSubnetD).toBeUndefined();
  });

  test('regressao: Network.VPC sem maxAzs → nao gera subnets filhas', () => {
    new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.VpcPublicSubnetA).toBeUndefined();
    expect(tpl.Resources.VpcIGW).toBeUndefined();
  });

  // ── SEC-04 + ARCH-06 ────────────────────────────────────────────────
  test('SEC-04: SG ingress sem CIDR emite warn mas mantem default 0.0.0.0/0', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    new Network.SecurityGroup(stack, 'SG', {
      vpcId: 'vpc-1',
      ingressRules: [{ protocol: 'tcp', fromPort: 22, toPort: 22 } as any],
    });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.SG.Properties.SecurityGroupIngress[0].CidrIp).toBe('0.0.0.0/0');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sem CIDR'));
    warnSpy.mockRestore();
  });

  test('ARCH-06: construct desconhecido emite warn e nao adiciona recurso', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    stack.addConstruct({ id: 'X', type: 'Foo.Bar', props: {} } as any);
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'Foo.Bar' nao suportado"));
    warnSpy.mockRestore();
  });

  test('Fn.ApiGateway com authorizerLambdaId → gera AWS::ApiGatewayV2::Authorizer e referencia nas rotas', () => {
    new Fn.Lambda(stack, 'AuthFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Fn.ApiGateway(stack, 'Api', {
      name: 'my-api',
      authorizerLambdaId: 'AuthFn',
      routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }],
    });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.ApiAuthorizer.Type).toBe('AWS::ApiGatewayV2::Authorizer');
    expect(tpl.Resources.ApiAuthorizer.Properties.AuthorizerUri['Fn::Sub']).toContain('AuthFn.Arn');
    const route = tpl.Resources.ApiGEThelloRoute;
    expect(route.Properties.AuthorizationType).toBe('CUSTOM');
    expect(route.Properties.AuthorizerId).toEqual({ Ref: 'ApiAuthorizer' });
  });

  test('Fn.ApiGateway sem authorizerLambdaId → não gera Authorizer', () => {
    new Fn.ApiGateway(stack, 'Api', { name: 'my-api', routes: [] });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.ApiAuthorizer).toBeUndefined();
  });

  test('Custom.Resource → gera resource CloudFormation a partir do props.cloudformation', () => {
    new Custom.Resource(stack, 'RotationSchedule', {
      cloudformation: {
        type: 'AWS::SecretsManager::RotationSchedule',
        properties: { SecretId: { Ref: 'MySecret' }, RotationRules: { AutomaticallyAfterDays: 30 } },
      },
    });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.RotationSchedule.Type).toBe('AWS::SecretsManager::RotationSchedule');
    expect(tpl.Resources.RotationSchedule.Properties.RotationRules.AutomaticallyAfterDays).toBe(30);
  });
});
