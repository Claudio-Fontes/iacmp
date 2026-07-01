import { Stack, Compute, Storage, Network, Database, Fn, Cache, Messaging, Secret, Custom, Policy, Workflow, Events } from '@iacmp/core';
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

  test('Fn.Lambda → Code é o caminho local como string (não { ZipFile }) — formato que `aws cloudformation package` resolve para S3', () => {
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Handler.Properties.Code).toBe('dist/');
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
  test('regressao: Database.SQL → DeletionPolicy Delete por default, Snapshot requer snapshotOnDelete:true', () => {
    new Database.SQL(stack, 'DB', { engine: 'mysql' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DB.DeletionPolicy).toBe('Delete');
  });

  test('regressao: Database.SQL com deletionProtection → DeletionPolicy Retain', () => {
    new Database.SQL(stack, 'DB', { engine: 'mysql', deletionProtection: true });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DB.DeletionPolicy).toBe('Retain');
  });

  test('regressao: Database.DocumentDB → DeletionPolicy Delete por default, Snapshot requer snapshotOnDelete:true', () => {
    new Database.DocumentDB(stack, 'Docs', { instances: 1 });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DocsCluster.DeletionPolicy).toBe('Delete');
  });

  test('regressao: Database.DynamoDB → DeletionPolicy Retain', () => {
    new Database.DynamoDB(stack, 'Tab', { partitionKey: 'id' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Tab.DeletionPolicy).toBe('Retain');
  });

  test('Database.DynamoDB sem partitionKeyType/sortKeyType → AttributeType default \'S\' (compat)', () => {
    new Database.DynamoDB(stack, 'Tab', { partitionKey: 'id', sortKey: 'ts' });
    const tpl = provider.synthesize(stack) as any;
    const attrs = tpl.Resources.Tab.Properties.AttributeDefinitions;
    expect(attrs).toEqual(expect.arrayContaining([
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'ts', AttributeType: 'S' },
    ]));
  });

  test('Database.DynamoDB com partitionKeyType: \'N\' → AttributeType N (regressao: tipo sempre era hardcoded como String)', () => {
    new Database.DynamoDB(stack, 'Tab', { partitionKey: 'id', partitionKeyType: 'N' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Tab.Properties.AttributeDefinitions).toEqual([
      { AttributeName: 'id', AttributeType: 'N' },
    ]);
  });

  test('Database.DynamoDB com sortKeyType e GSI com partitionKeyType próprios', () => {
    new Database.DynamoDB(stack, 'Tab', {
      partitionKey: 'id',
      partitionKeyType: 'N',
      sortKey: 'createdAt',
      sortKeyType: 'S',
      globalSecondaryIndexes: [{ name: 'byStatus', partitionKey: 'status', partitionKeyType: 'S' }],
    });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Tab.Properties.AttributeDefinitions).toEqual(expect.arrayContaining([
      { AttributeName: 'id', AttributeType: 'N' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
    ]));
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

  test('regressao: Network.VPC com maxAzs → exporta SubnetId real das subnets publicas/privadas auto-geradas como Outputs', () => {
    new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 } as any);
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Outputs.VpcPublicSubnetASubnetId).toEqual({
      Value: { Ref: 'VpcPublicSubnetA' },
      Export: { Name: 'test-stack-Vpc-PublicA-SubnetId' },
    });
    expect(tpl.Outputs.VpcPrivateSubnetASubnetId).toEqual({
      Value: { Ref: 'VpcPrivateSubnetA' },
      Export: { Name: 'test-stack-Vpc-PrivateA-SubnetId' },
    });
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

  test('regressao: Fn.ApiGateway sem description → propriedade Description omitida (não string vazia — ApiGateway rejeita com 400)', () => {
    new Fn.ApiGateway(stack, 'Api', { name: 'my-api', type: 'REST', routes: [] });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Api.Properties.Description).toBeUndefined();
  });

  test('Fn.ApiGateway com description → propriedade Description presente', () => {
    new Fn.ApiGateway(stack, 'Api', { name: 'my-api', type: 'REST', description: 'minha api', routes: [] });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Api.Properties.Description).toBe('minha api');
  });

  test('Fn.ApiGateway sem authorizerLambdaId → não gera Authorizer', () => {
    new Fn.ApiGateway(stack, 'Api', { name: 'my-api', routes: [] });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.ApiAuthorizer).toBeUndefined();
  });

  test('Fn.ApiGateway type HTTP → gera AWS::Lambda::Permission pra cada lambda referenciada (rota e authorizer)', () => {
    new Fn.Lambda(stack, 'AuthFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Fn.ApiGateway(stack, 'Api', {
      name: 'my-api',
      authorizerLambdaId: 'AuthFn',
      routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }],
    });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.HelloFnApiPermission.Type).toBe('AWS::Lambda::Permission');
    expect(tpl.Resources.HelloFnApiPermission.Properties.Principal).toBe('apigateway.amazonaws.com');
    expect(tpl.Resources.AuthFnApiPermission.Type).toBe('AWS::Lambda::Permission');
  });

  test('Fn.ApiGateway type HTTP → Permission é deduplicada quando a mesma lambda atende duas rotas', () => {
    new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Fn.ApiGateway(stack, 'Api', {
      name: 'my-api',
      routes: [
        { method: 'GET', path: '/hello', lambdaId: 'HelloFn' },
        { method: 'POST', path: '/hello', lambdaId: 'HelloFn' },
      ],
    });
    const tpl = provider.synthesize(stack) as any;
    const permissionKeys = Object.keys(tpl.Resources).filter(k => tpl.Resources[k].Type === 'AWS::Lambda::Permission');
    expect(permissionKeys).toEqual(['HelloFnApiPermission']);
  });

  describe('Fn.ApiGateway type REST (API Gateway v1)', () => {
    test('gera Resource/Method/Deployment/Stage reais (não ApiGatewayV2)', () => {
      new Fn.Lambda(stack, 'SaveFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      new Fn.Lambda(stack, 'GetFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      new Fn.ApiGateway(stack, 'Api', {
        name: 'my-api',
        type: 'REST',
        stageName: 'prod',
        routes: [
          { method: 'POST', path: '/messages', lambdaId: 'SaveFn' },
          { method: 'GET', path: '/messages/{id}', lambdaId: 'GetFn' },
        ],
      });
      const tpl = provider.synthesize(stack) as any;

      expect(tpl.Resources.Api.Type).toBe('AWS::ApiGateway::RestApi');

      // Resource tree: /messages e /messages/{id} compartilham o segmento "messages"
      const resourceTypes = Object.entries(tpl.Resources).filter(([, r]: any) => r.Type === 'AWS::ApiGateway::Resource');
      expect(resourceTypes).toHaveLength(2);
      const messagesResource = resourceTypes.find(([, r]: any) => r.Properties.PathPart === 'messages')![0];
      const idResource = resourceTypes.find(([, r]: any) => r.Properties.PathPart === '{id}')!;
      expect((idResource[1] as any).Properties.ParentId).toEqual({ Ref: messagesResource });

      // Method aninha a Integration (não cria um recurso Integration separado, diferente do v2)
      const postMethod = Object.values(tpl.Resources).find((r: any) => r.Type === 'AWS::ApiGateway::Method' && r.Properties.HttpMethod === 'POST') as any;
      expect(postMethod.Properties.Integration.Type).toBe('AWS_PROXY');
      expect(postMethod.Properties.Integration.Uri['Fn::Sub']).toContain('SaveFn.Arn');

      // Deployment depende de todos os Methods; Stage referencia o Deployment
      const deployment = Object.entries(tpl.Resources).find(([, r]: any) => r.Type === 'AWS::ApiGateway::Deployment')!;
      const methodIds = Object.entries(tpl.Resources).filter(([, r]: any) => r.Type === 'AWS::ApiGateway::Method').map(([id]) => id);
      expect((deployment[1] as any).DependsOn).toEqual(expect.arrayContaining(methodIds));

      expect(tpl.Resources.ApiStage.Type).toBe('AWS::ApiGateway::Stage');
      expect(tpl.Resources.ApiStage.Properties.DeploymentId).toEqual({ Ref: deployment[0] });
      expect(tpl.Resources.ApiStage.Properties.StageName).toBe('prod');
    });

    test('cors:true → gera Method OPTIONS com integração MOCK por resource', () => {
      new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      new Fn.ApiGateway(stack, 'Api', {
        name: 'my-api',
        type: 'REST',
        cors: true,
        routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }],
      });
      const tpl = provider.synthesize(stack) as any;
      const optionsMethod = Object.values(tpl.Resources).find((r: any) => r.Type === 'AWS::ApiGateway::Method' && r.Properties.HttpMethod === 'OPTIONS') as any;
      expect(optionsMethod).toBeDefined();
      expect(optionsMethod.Properties.Integration.Type).toBe('MOCK');
      expect(optionsMethod.Properties.Integration.IntegrationResponses[0].ResponseParameters['method.response.header.Access-Control-Allow-Origin']).toBe("'*'");
    });

    test('authorizerLambdaId → gera AWS::ApiGateway::Authorizer (v1, não v2) com IdentitySource string', () => {
      new Fn.Lambda(stack, 'AuthFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      new Fn.ApiGateway(stack, 'Api', {
        name: 'my-api',
        type: 'REST',
        authorizerLambdaId: 'AuthFn',
        routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }],
      });
      const tpl = provider.synthesize(stack) as any;
      expect(tpl.Resources.ApiAuthorizer.Type).toBe('AWS::ApiGateway::Authorizer');
      expect(typeof tpl.Resources.ApiAuthorizer.Properties.IdentitySource).toBe('string');
    });

    test('gera AWS::Lambda::Permission pras lambdas das rotas REST, igual ao HTTP', () => {
      new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      new Fn.ApiGateway(stack, 'Api', {
        name: 'my-api',
        type: 'REST',
        routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }],
      });
      const tpl = provider.synthesize(stack) as any;
      expect(tpl.Resources.HelloFnApiPermission.Type).toBe('AWS::Lambda::Permission');
      expect(tpl.Resources.HelloFnApiPermission.Properties.SourceArn['Fn::Sub']).toContain('execute-api');
    });
  });

  describe('Fn.ApiGateway — referência a Function.Lambda entre stacks (synthesize com allStacks)', () => {
    test('lambda na MESMA stack → referência local (Fn::Sub/Fn::GetAtt), nunca Fn::ImportValue', () => {
      new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      new Fn.ApiGateway(stack, 'Api', { name: 'my-api', routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }] });

      const tpl = provider.synthesize(stack, [stack]) as any;
      const integration = tpl.Resources.ApiGEThelloRouteIntegration;
      expect(integration.Properties.IntegrationUri['Fn::Sub']).toContain('HelloFn.Arn');
      expect(JSON.stringify(integration)).not.toContain('Fn::ImportValue');
    });

    test('lambda em OUTRA stack → Fn::ImportValue na stack do gateway + Outputs/Export na stack da lambda', () => {
      const lambdaStack = new Stack('lambda-stack');
      new Fn.Lambda(lambdaStack, 'HelloFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      new Fn.ApiGateway(stack, 'Api', { name: 'my-api', routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }] });

      const allStacks = [stack, lambdaStack];
      const apiTpl = provider.synthesize(stack, allStacks) as any;
      const lambdaTpl = provider.synthesize(lambdaStack, allStacks) as any;

      const integration = apiTpl.Resources.ApiGEThelloRouteIntegration;
      expect(integration.Properties.IntegrationUri['Fn::Sub'][1].LambdaArn).toEqual({ 'Fn::ImportValue': 'lambda-stack-HelloFn-Arn' });

      const permission = apiTpl.Resources.HelloFnApiPermission;
      expect(permission.Properties.FunctionName).toEqual({ 'Fn::ImportValue': 'lambda-stack-HelloFn-Arn' });

      expect(lambdaTpl.Outputs.HelloFnArn).toEqual({
        Value: { 'Fn::GetAtt': ['HelloFn', 'Arn'] },
        Export: { Name: 'lambda-stack-HelloFn-Arn' },
      });
    });

    test('lambdaId que não existe em nenhuma stack → lança erro claro', () => {
      new Fn.ApiGateway(stack, 'Api', { name: 'my-api', routes: [{ method: 'GET', path: '/x', lambdaId: 'NaoExiste' }] });
      expect(() => provider.synthesize(stack, [stack])).toThrow('NaoExiste');
    });

    test('authorizerLambdaId em outra stack também resolve via Fn::ImportValue', () => {
      const lambdaStack = new Stack('lambda-stack');
      new Fn.Lambda(lambdaStack, 'AuthFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      new Fn.ApiGateway(stack, 'Api', { name: 'my-api', authorizerLambdaId: 'AuthFn', routes: [] });

      const apiTpl = provider.synthesize(stack, [stack, lambdaStack]) as any;
      expect(apiTpl.Resources.ApiAuthorizer.Properties.AuthorizerUri['Fn::Sub'][1].LambdaArn).toEqual({ 'Fn::ImportValue': 'lambda-stack-AuthFn-Arn' });
    });
  });

  describe('Fn.Lambda — Role IAM assumível (regressão: role hardcoded "LambdaExecutionRole" não existia de verdade)', () => {
    test('sem Policy.IAM correspondente → gera role mínima padrão inline e referencia ela', () => {
      new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      const tpl = provider.synthesize(stack) as any;

      expect(tpl.Resources.HelloFn.Properties.Role).toEqual({ 'Fn::GetAtt': ['HelloFnDefaultRole', 'Arn'] });
      expect(tpl.Resources.HelloFnDefaultRole.Type).toBe('AWS::IAM::Role');
      expect(tpl.Resources.HelloFnDefaultRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service).toBe('lambda.amazonaws.com');
      expect(tpl.Resources.HelloFnDefaultRole.Properties.ManagedPolicyArns).toContain(
        'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
      );
      expect(JSON.stringify(tpl.Resources.HelloFn.Properties.Role)).not.toContain('LambdaExecutionRole');
    });

    test('com Policy.IAM (attachType: lambda) na MESMA stack → referencia a role do Policy.IAM, sem role default', () => {
      new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      new Policy.IAM(stack, 'HelloFnPolicy', {
        attachTo: 'HelloFn',
        attachType: 'lambda',
        statements: [{ effect: 'Allow', actions: ['dynamodb:GetItem'] }],
      });

      const tpl = provider.synthesize(stack) as any;
      expect(tpl.Resources.HelloFn.Properties.Role).toEqual({ 'Fn::GetAtt': ['HelloFnPolicyRole', 'Arn'] });
      expect(tpl.Resources.HelloFnDefaultRole).toBeUndefined();
    });

    test('com Policy.IAM (attachType: lambda) em OUTRA stack → Fn::ImportValue do RoleArn + Outputs/Export na stack da policy', () => {
      const policyStack = new Stack('policy-stack');
      new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'i.h', code: 'dist/' });
      new Policy.IAM(policyStack, 'HelloFnPolicy', {
        attachTo: 'HelloFn',
        attachType: 'lambda',
        statements: [{ effect: 'Allow', actions: ['dynamodb:GetItem'] }],
      });

      const allStacks = [stack, policyStack];
      const lambdaTpl = provider.synthesize(stack, allStacks) as any;
      const policyTpl = provider.synthesize(policyStack, allStacks) as any;

      expect(lambdaTpl.Resources.HelloFn.Properties.Role).toEqual({
        'Fn::ImportValue': 'policy-stack-HelloFnPolicyRole-RoleArn',
      });
      expect(policyTpl.Outputs.HelloFnPolicyRoleRoleArn).toEqual({
        Value: { 'Fn::GetAtt': ['HelloFnPolicyRole', 'Arn'] },
        Export: { Name: 'policy-stack-HelloFnPolicyRole-RoleArn' },
      });
    });
  });

  test('Custom.Resource → gera resource CloudFormation a partir do props.cloudformation', () => {
    new Secret.Vault(stack, 'MySecret', {});
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

  test('regressao: Custom.Resource com Fn::GetAtt pra recurso que não existe na stack → synth falha (em vez de só o aws cloudformation deploy)', () => {
    new Custom.Resource(stack, 'MessagesSeed', {
      cloudformation: {
        type: 'AWS::CloudFormation::CustomResource',
        properties: { ServiceToken: { 'Fn::GetAtt': ['MessagesSeedFn', 'Arn'] } },
      },
    });
    expect(() => provider.synthesize(stack)).toThrow(/MessagesSeedFn/);
  });

  describe('regressao: wiring de VPC/subnet/role real (antes: SubnetIds/Subnets hardcoded [], roles apontando pra nomes que nunca existiam)', () => {
    test('Compute.Instance com subnetId/securityGroupIds → propriedades presentes no EC2', () => {
      new Compute.Instance(stack, 'Web', {
        instanceType: 'small', image: 'ubuntu-22.04',
        subnetId: 'subnet-abc123', securityGroupIds: ['sg-abc123'],
      });
      const tpl = provider.synthesize(stack) as any;
      expect(tpl.Resources.Web.Properties.SubnetId).toBe('subnet-abc123');
      expect(tpl.Resources.Web.Properties.SecurityGroupIds).toEqual(['sg-abc123']);
    });

    test('Compute.Container (ECS) → Subnets reais (não []) e ExecutionRoleArn aponta pra role gerada de verdade', () => {
      new Compute.Container(stack, 'Api', {
        image: 'nginx:latest', subnetIds: ['subnet-a', 'subnet-b'], securityGroupIds: ['sg-x'],
      });
      const tpl = provider.synthesize(stack) as any;
      expect(tpl.Resources.ApiService.Properties.NetworkConfiguration.AwsvpcConfiguration.Subnets)
        .toEqual(['subnet-a', 'subnet-b']);
      expect(tpl.Resources.ApiService.Properties.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups)
        .toEqual(['sg-x']);
      expect(tpl.Resources.ApiTaskDef.Properties.ExecutionRoleArn).toEqual({ 'Fn::GetAtt': ['ApiExecutionRole', 'Arn'] });
      expect(tpl.Resources.ApiExecutionRole.Type).toBe('AWS::IAM::Role');
      expect(tpl.Resources.ApiExecutionRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service)
        .toBe('ecs-tasks.amazonaws.com');
      expect(JSON.stringify(tpl.Resources.ApiTaskDef.Properties.ExecutionRoleArn)).not.toContain('ecsTaskExecutionRole');
    });

    test('Compute.Kubernetes (EKS) → SubnetIds reais no cluster e nodegroup, roles geradas de verdade (não Fn::Sub pra nome inexistente)', () => {
      new Compute.Kubernetes(stack, 'MyCluster', { subnetIds: ['subnet-a', 'subnet-b'] });
      const tpl = provider.synthesize(stack) as any;
      expect(tpl.Resources.MyCluster.Properties.ResourcesVpcConfig.SubnetIds).toEqual(['subnet-a', 'subnet-b']);
      expect(tpl.Resources.MyClusterNodeGroup.Properties.Subnets).toEqual(['subnet-a', 'subnet-b']);

      expect(tpl.Resources.MyCluster.Properties.RoleArn).toEqual({ 'Fn::GetAtt': ['MyClusterClusterRole', 'Arn'] });
      expect(tpl.Resources.MyClusterClusterRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service)
        .toBe('eks.amazonaws.com');

      expect(tpl.Resources.MyClusterNodeGroup.Properties.NodeRole).toEqual({ 'Fn::GetAtt': ['MyClusterNodeRole', 'Arn'] });
      expect(tpl.Resources.MyClusterNodeRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service)
        .toBe('ec2.amazonaws.com');

      expect(JSON.stringify(tpl.Resources)).not.toContain('EKSClusterRole');
      expect(JSON.stringify(tpl.Resources)).not.toContain('EKSNodeRole');
    });

    test('Database.SQL (RDS) com subnetIds → gera DBSubnetGroup real e referencia DBSubnetGroupName/VPCSecurityGroups', () => {
      new Database.SQL(stack, 'Db', {
        engine: 'postgres', subnetIds: ['subnet-a', 'subnet-b'], securityGroupIds: ['sg-db'],
      });
      const tpl = provider.synthesize(stack) as any;
      expect(tpl.Resources.DbSubnetGroup.Type).toBe('AWS::RDS::DBSubnetGroup');
      expect(tpl.Resources.DbSubnetGroup.Properties.SubnetIds).toEqual(['subnet-a', 'subnet-b']);
      expect(tpl.Resources.Db.Properties.DBSubnetGroupName).toEqual({ Ref: 'DbSubnetGroup' });
      expect(tpl.Resources.Db.Properties.VPCSecurityGroups).toEqual(['sg-db']);
    });

    test('Database.SQL (RDS) sem subnetIds → não gera DBSubnetGroup (compat, conta com VPC default)', () => {
      new Database.SQL(stack, 'Db', { engine: 'postgres' });
      const tpl = provider.synthesize(stack) as any;
      expect(tpl.Resources.DbSubnetGroup).toBeUndefined();
      expect(tpl.Resources.Db.Properties.DBSubnetGroupName).toBeUndefined();
    });

    test('Database.DocumentDB com subnetIds → gera DBSubnetGroup real no cluster', () => {
      new Database.DocumentDB(stack, 'Docs', { instances: 1, subnetIds: ['subnet-a'], securityGroupIds: ['sg-docs'] });
      const tpl = provider.synthesize(stack) as any;
      expect(tpl.Resources.DocsClusterSubnetGroup.Type).toBe('AWS::DocDB::DBSubnetGroup');
      expect(tpl.Resources.DocsCluster.Properties.DBSubnetGroupName).toEqual({ Ref: 'DocsClusterSubnetGroup' });
      expect(tpl.Resources.DocsCluster.Properties.VpcSecurityGroupIds).toEqual(['sg-docs']);
    });

    test('Network.LoadBalancer target group → VpcId real (props.vpcId), não string vazia', () => {
      new Network.LoadBalancer(stack, 'Alb', {
        vpcId: 'vpc-real123',
        subnetIds: ['subnet-a', 'subnet-b'],
        targetGroups: [{ name: 'api-tg', port: 80, protocol: 'HTTP' }],
      });
      const tpl = provider.synthesize(stack) as any;
      const tg = tpl.Resources.AlbTGapitg;
      expect(tg.Properties.VpcId).toBe('vpc-real123');
    });

    test('Workflow.StepFunctions → RoleArn referencia role gerada de verdade (não Fn::Sub pra StepFunctionsExecutionRole inexistente)', () => {
      new Workflow.StepFunctions(stack, 'Flow', { steps: [{ name: 'Start' }] });
      const tpl = provider.synthesize(stack) as any;
      expect(tpl.Resources.Flow.Properties.RoleArn).toEqual({ 'Fn::GetAtt': ['FlowExecutionRole', 'Arn'] });
      expect(tpl.Resources.FlowExecutionRole.Type).toBe('AWS::IAM::Role');
      expect(tpl.Resources.FlowExecutionRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service)
        .toBe('states.amazonaws.com');
      expect(JSON.stringify(tpl.Resources.Flow.Properties.RoleArn)).not.toContain('StepFunctionsExecutionRole');
    });

    test('Network.VPC/Subnet/SecurityGroup → IDs exportados como Outputs (pra harness/outra stack referenciar de verdade)', () => {
      new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16' });
      new Network.Subnet(stack, 'Sub', { vpcId: 'vpc-x', cidr: '10.0.0.0/24' });
      new Network.SecurityGroup(stack, 'Sg', { vpcId: 'vpc-x' });
      const tpl = provider.synthesize(stack) as any;
      expect(tpl.Outputs.VpcVpcId).toEqual({ Value: { Ref: 'Vpc' }, Export: { Name: 'test-stack-Vpc-VpcId' } });
      expect(tpl.Outputs.SubSubnetId).toEqual({ Value: { Ref: 'Sub' }, Export: { Name: 'test-stack-Sub-SubnetId' } });
      expect(tpl.Outputs.SgGroupId).toEqual({
        Value: { 'Fn::GetAtt': ['Sg', 'GroupId'] },
        Export: { Name: 'test-stack-Sg-GroupId' },
      });
    });
  });

  // ── Aurora ────────────────────────────────────────────────────────────────

  test('Database.SQL aurora-mysql → gera DBCluster + DBInstance (não DBInstance single)', () => {
    new Database.SQL(stack, 'DB', { engine: 'aurora-mysql' });
    const tpl = provider.synthesize(stack, undefined, { accountTier: 'standard' }) as any;
    expect(tpl.Resources.DBCluster.Type).toBe('AWS::RDS::DBCluster');
    expect(tpl.Resources.DBCluster.Properties.Engine).toBe('aurora-mysql');
    expect(tpl.Resources.DBCluster.Properties.EngineVersion).toBe('8.0.mysql_aurora.3.08.0');
    expect(tpl.Resources.DB.Type).toBe('AWS::RDS::DBInstance');
    expect(tpl.Resources.DB.Properties.DBClusterIdentifier).toEqual({ Ref: 'DBCluster' });
    expect(tpl.Resources.DB.Properties.Engine).toBe('aurora-mysql');
  });

  test('Database.SQL aurora-postgresql → gera DBCluster com engine aurora-postgresql', () => {
    new Database.SQL(stack, 'DB', { engine: 'aurora-postgresql' });
    const tpl = provider.synthesize(stack, undefined, { accountTier: 'standard' }) as any;
    expect(tpl.Resources.DBCluster.Type).toBe('AWS::RDS::DBCluster');
    expect(tpl.Resources.DBCluster.Properties.Engine).toBe('aurora-postgresql');
    expect(tpl.Resources.DBCluster.Properties.EngineVersion).toBe('16.6');
    expect(tpl.Resources.DB.Type).toBe('AWS::RDS::DBInstance');
  });

  test('Database.SQL aurora-mysql com instances:2 → gera 2 DBInstance', () => {
    new Database.SQL(stack, 'DB', { engine: 'aurora-mysql', instances: 2 });
    const tpl = provider.synthesize(stack, undefined, { accountTier: 'standard' }) as any;
    expect(tpl.Resources.DB.Type).toBe('AWS::RDS::DBInstance');
    expect(tpl.Resources.DBInstance2.Type).toBe('AWS::RDS::DBInstance');
    expect(tpl.Resources.DBInstance2.Properties.DBClusterIdentifier).toEqual({ Ref: 'DBCluster' });
  });

  test('Database.SQL aurora-mysql com subnetIds → gera DBSubnetGroup e associa ao cluster', () => {
    new Database.SQL(stack, 'DB', {
      engine: 'aurora-mysql',
      subnetIds: ['subnet-1', 'subnet-2'],
      securityGroupIds: ['sg-1'],
    });
    const tpl = provider.synthesize(stack, undefined, { accountTier: 'standard' }) as any;
    expect(tpl.Resources.DBSubnetGroup.Type).toBe('AWS::RDS::DBSubnetGroup');
    expect(tpl.Resources.DBSubnetGroup.Properties.SubnetIds).toEqual(['subnet-1', 'subnet-2']);
    expect(tpl.Resources.DBCluster.Properties.DBSubnetGroupName).toEqual({ Ref: 'DBSubnetGroup' });
    expect(tpl.Resources.DBCluster.Properties.VpcSecurityGroupIds).toEqual(['sg-1']);
  });

  test('Database.SQL aurora-mysql → gera Secret para senha e referencia no cluster', () => {
    new Database.SQL(stack, 'DB', { engine: 'aurora-mysql' });
    const tpl = provider.synthesize(stack, undefined, { accountTier: 'standard' }) as any;
    expect(tpl.Resources.DBSecret.Type).toBe('AWS::SecretsManager::Secret');
    expect(tpl.Resources.DBCluster.Properties.MasterUserPassword).toMatchObject({
      'Fn::Sub': expect.stringContaining('DBSecret'),
    });
  });

  test('Database.SQL aurora-mysql com deletionProtection → DeletionPolicy Retain', () => {
    new Database.SQL(stack, 'DB', { engine: 'aurora-mysql', deletionProtection: true });
    const tpl = provider.synthesize(stack, undefined, { accountTier: 'standard' }) as any;
    expect(tpl.Resources.DBCluster.DeletionPolicy).toBe('Retain');
    expect(tpl.Resources.DB.DeletionPolicy).toBe('Retain');
  });

  test('Database.SQL aurora-mysql sem deletionProtection → DeletionPolicy Snapshot', () => {
    new Database.SQL(stack, 'DB', { engine: 'aurora-mysql' });
    const tpl = provider.synthesize(stack, undefined, { accountTier: 'standard' }) as any;
    expect(tpl.Resources.DBCluster.DeletionPolicy).toBe('Snapshot');
  });

  test('Database.SQL aurora → StorageEncrypted true por default', () => {
    new Database.SQL(stack, 'DB', { engine: 'aurora-mysql' });
    const tpl = provider.synthesize(stack, undefined, { accountTier: 'standard' }) as any;
    expect(tpl.Resources.DBCluster.Properties.StorageEncrypted).toBe(true);
  });

  test('Database.SQL aurora → BackupRetentionPeriod 7 por default', () => {
    new Database.SQL(stack, 'DB', { engine: 'aurora-mysql' });
    const tpl = provider.synthesize(stack, undefined, { accountTier: 'standard' }) as any;
    expect(tpl.Resources.DBCluster.Properties.BackupRetentionPeriod).toBe(7);
  });

  test('Database.SQL RDS tier free (default) → backup 0 e sem criptografia', () => {
    new Database.SQL(stack, 'DB', { engine: 'postgres' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DB.Properties.BackupRetentionPeriod).toBe(0);
    expect(tpl.Resources.DB.Properties.StorageEncrypted).toBe(false);
  });

  test('Database.SQL RDS tier standard → backup 7 e criptografia por default', () => {
    new Database.SQL(stack, 'DB', { engine: 'postgres' });
    const tpl = provider.synthesize(stack, [stack], { accountTier: 'standard' }) as any;
    expect(tpl.Resources.DB.Properties.BackupRetentionPeriod).toBe(7);
    expect(tpl.Resources.DB.Properties.StorageEncrypted).toBe(true);
  });

  test('Database.SQL RDS → prop explícita vence o default do tier (standard)', () => {
    // backup/cripto explícitos só são válidos em conta standard; em free a
    // validação semântica bloqueia (testada à parte em validate.test.ts).
    new Database.SQL(stack, 'DB', { engine: 'postgres', backupRetentionDays: 3, storageEncrypted: true });
    const tpl = provider.synthesize(stack, [stack], { accountTier: 'standard' }) as any;
    expect(tpl.Resources.DB.Properties.BackupRetentionPeriod).toBe(3);
    expect(tpl.Resources.DB.Properties.StorageEncrypted).toBe(true);
  });

  test('Database.SQL engine invalido → lança erro', () => {
    expect(() => new Database.SQL(stack, 'DB', { engine: 'mongodb' as any })).toThrow('engine inválido');
  });

  // ── Storage.Bucket websiteHosting ─────────────────────────────────────────

  test('Storage.Bucket com websiteHosting:true → WebsiteConfiguration + BucketPolicy pública', () => {
    new Storage.Bucket(stack, 'Site', { websiteHosting: true });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Site.Type).toBe('AWS::S3::Bucket');
    expect(tpl.Resources.Site.Properties.WebsiteConfiguration).toEqual({
      IndexDocument: 'index.html',
      ErrorDocument: 'index.html',
    });
    expect(tpl.Resources.Site.Properties.PublicAccessBlockConfiguration.BlockPublicAcls).toBe(false);
    expect(tpl.Resources.SitePolicy.Type).toBe('AWS::S3::BucketPolicy');
    expect(tpl.Resources.SitePolicy.Properties.PolicyDocument.Statement[0].Action).toBe('s3:GetObject');
    expect(tpl.Resources.SitePolicy.Properties.PolicyDocument.Statement[0].Principal).toBe('*');
  });

  test('Storage.Bucket com websiteHosting:true → DeletionPolicy Retain', () => {
    new Storage.Bucket(stack, 'Site', { websiteHosting: true });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Site.DeletionPolicy).toBe('Retain');
  });

  test('Storage.Bucket com bucketName → BucketName presente no template', () => {
    new Storage.Bucket(stack, 'Site', { websiteHosting: true, bucketName: 'meu-site-react' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Site.Properties.BucketName).toBe('meu-site-react');
  });

  test('Storage.Bucket sem websiteHosting → sem WebsiteConfiguration e sem BucketPolicy', () => {
    new Storage.Bucket(stack, 'Assets', {});
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Assets.Properties.WebsiteConfiguration).toBeUndefined();
    expect(tpl.Resources.AssetsPolicy).toBeUndefined();
  });

  // ── Network.CDN com bucketRef ─────────────────────────────────────────────

  test('Network.CDN com bucketRef → OAC + BucketPolicy CloudFront + S3OriginConfig', () => {
    new Storage.Bucket(stack, 'AppBucket', { websiteHosting: true });
    new Network.CDN(stack, 'AppCDN', {
      origins: [{ id: 'app', domainName: '', bucketRef: 'AppBucket' }],
    });
    const tpl = provider.synthesize(stack) as any;
    const oacKey = Object.keys(tpl.Resources).find(k => tpl.Resources[k].Type === 'AWS::CloudFront::OriginAccessControl');
    expect(oacKey).toBeDefined();
    expect(tpl.Resources[oacKey!].Properties.OriginAccessControlConfig.OriginAccessControlOriginType).toBe('s3');
    const policyKey = Object.keys(tpl.Resources).find(k =>
      tpl.Resources[k].Type === 'AWS::S3::BucketPolicy' && k !== 'AppBucketPolicy',
    );
    expect(policyKey).toBeDefined();
    expect(tpl.Resources[policyKey!].Properties.PolicyDocument.Statement[0].Principal).toEqual({ Service: 'cloudfront.amazonaws.com' });
    expect(tpl.Resources.AppCDN.Properties.DistributionConfig.Origins[0].S3OriginConfig).toBeDefined();
    expect(tpl.Resources.AppCDN.Properties.DistributionConfig.Origins[0].DomainName).toEqual({
      'Fn::GetAtt': ['AppBucket', 'RegionalDomainName'],
    });
  });

  test('Network.CDN sem bucketRef → CustomOriginConfig com HTTPPort:80', () => {
    new Network.CDN(stack, 'AppCDN', {
      origins: [{ id: 'api', domainName: 'api.example.com' }],
    });
    const tpl = provider.synthesize(stack) as any;
    const origin = tpl.Resources.AppCDN.Properties.DistributionConfig.Origins[0];
    expect(origin.CustomOriginConfig).toBeDefined();
    expect(origin.CustomOriginConfig.HTTPPort).toBe(80);
    expect(origin.CustomOriginConfig.HTTPSPort).toBe(443);
    expect(origin.S3OriginConfig).toBeUndefined();
  });

  test('Network.CDN com protocol http-only → OriginProtocolPolicy http-only', () => {
    new Network.CDN(stack, 'AppCDN', {
      origins: [{ id: 'site', domainName: 'bucket.s3-website-us-east-1.amazonaws.com', protocol: 'http-only' }],
    });
    const tpl = provider.synthesize(stack) as any;
    const origin = tpl.Resources.AppCDN.Properties.DistributionConfig.Origins[0];
    expect(origin.CustomOriginConfig.OriginProtocolPolicy).toBe('http-only');
  });

  // ── Fn.Lambda com VPC ─────────────────────────────────────────────────────

  test('Fn.Lambda com vpcId + subnetIds + securityGroupIds → VpcConfig no template', () => {
    new Fn.Lambda(stack, 'Handler', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: 'dist/',
      vpcId: 'vpc-123',
      subnetIds: ['subnet-a', 'subnet-b'],
      securityGroupIds: ['sg-xyz'],
    });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Handler.Properties.VpcConfig).toEqual({
      SubnetIds: ['subnet-a', 'subnet-b'],
      SecurityGroupIds: ['sg-xyz'],
    });
  });

  test('Fn.Lambda sem vpcId → VpcConfig ausente', () => {
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Handler.Properties.VpcConfig).toBeUndefined();
  });

  test('valor null em prop (propriedade inventada) → synth falha com caminho (caso openai26 secretArn)', () => {
    // Simula `resources: [vault.secretArn]` onde secretArn é undefined → null.
    new Policy.IAM(stack, 'P', {
      attachTo: 'SomeFn', attachType: 'lambda',
      statements: [{ effect: 'Allow', actions: ['secretsmanager:GetSecretValue'], resources: [undefined as any] }],
    });
    new Fn.Lambda(stack, 'SomeFn', { runtime: 'nodejs20', handler: 'h.handler', code: '.' });
    expect(() => provider.synthesize(stack)).toThrow(/null\/undefined/i);
  });

  test('Secret.Vault.SecretArn em env var → Ref para o Vault (não null)', () => {
    new Secret.Vault(stack, 'JwtSecret', { description: 'jwt' });
    new Fn.Lambda(stack, 'Fn', { runtime: 'nodejs20', handler: 'h.handler', code: '.',
      environment: { JWT_SECRET_ARN: 'JwtSecret.SecretArn' } });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Fn.Properties.Environment.Variables.JWT_SECRET_ARN).toEqual({ Ref: 'JwtSecret' });
  });

  test('Secret.Vault.SecretArn em Policy.IAM resources → Ref para o Vault', () => {
    new Secret.Vault(stack, 'JwtSecret', { description: 'jwt' });
    new Fn.Lambda(stack, 'AuthFn', { runtime: 'nodejs20', handler: 'h.handler', code: '.' });
    new Policy.IAM(stack, 'AuthPolicy', { attachTo: 'AuthFn', attachType: 'lambda',
      statements: [{ effect: 'Allow', actions: ['secretsmanager:GetSecretValue'], resources: ['JwtSecret.SecretArn'] }] });
    const tpl = provider.synthesize(stack) as any;
    const role = tpl.Resources.AuthPolicyRole;
    expect(role.Properties.Policies[0].PolicyDocument.Statement[0].Resource).toEqual([{ Ref: 'JwtSecret' }]);
  });

  test('Secret.Vault exporta SecretArn como Output (cross-stack)', () => {
    new Secret.Vault(stack, 'JwtSecret', { description: 'jwt' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Outputs.JwtSecretSecretArn).toEqual({
      Value: { Ref: 'JwtSecret' },
      Export: { Name: 'test-stack-JwtSecret-SecretArn' },
    });
  });

  test('ApiGateway com authorizerLambdaId POR ROTA → rota protegida CUSTOM, pública NONE (caso openai28)', () => {
    new Fn.Lambda(stack, 'AuthFn', { runtime: 'nodejs20', handler: 'a.handler', code: '.' });
    new Fn.Lambda(stack, 'HealthFn', { runtime: 'nodejs20', handler: 'h.handler', code: '.' });
    new Fn.Lambda(stack, 'ProfileFn', { runtime: 'nodejs20', handler: 'p.handler', code: '.' });
    new Fn.ApiGateway(stack, 'Api', { name: 'API', type: 'HTTP', routes: [
      { method: 'GET', path: '/health', lambdaId: 'HealthFn', authType: 'NONE' },
      { method: 'GET', path: '/profile', lambdaId: 'ProfileFn', authorizerLambdaId: 'AuthFn' },
    ] });
    const tpl = provider.synthesize(stack) as any;
    const routes = Object.values(tpl.Resources).filter((r: any) => r.Type === 'AWS::ApiGatewayV2::Route') as any[];
    const health = routes.find(r => r.Properties.RouteKey === 'GET /health');
    const profile = routes.find(r => r.Properties.RouteKey === 'GET /profile');
    expect(health.Properties.AuthorizationType).toBeUndefined(); // pública
    expect(profile.Properties.AuthorizationType).toBe('CUSTOM'); // protegida
    // authorizer da rota foi criado
    expect(Object.values(tpl.Resources).some((r: any) => r.Type === 'AWS::ApiGatewayV2::Authorizer')).toBe(true);
  });

  test('Fn.Lambda.eventSources → EventSourceMapping da fila SQS (caso openai31 worker)', () => {
    new Messaging.Queue(stack, 'TaskQueue', { visibilityTimeoutSeconds: 60 });
    new Fn.Lambda(stack, 'ProcessorFn', { runtime: 'nodejs20', handler: 'p.handler', code: '.',
      eventSources: [{ queueId: 'TaskQueue', batchSize: 10, bisectBatchOnFunctionError: true }] });
    const tpl = provider.synthesize(stack) as any;
    const esm = Object.values(tpl.Resources).find((r: any) => r.Type === 'AWS::Lambda::EventSourceMapping') as any;
    expect(esm).toBeDefined();
    expect(esm.Properties.EventSourceArn).toEqual({ 'Fn::GetAtt': ['TaskQueue', 'Arn'] });
    expect(esm.Properties.FunctionName).toEqual({ Ref: 'ProcessorFn' });
    expect(esm.Properties.BatchSize).toBe(10);
    // BisectBatchOnFunctionError NÃO é suportado para SQS — não deve aparecer
    expect(esm.Properties.BisectBatchOnFunctionError).toBeUndefined();
  });

  test('EventBridge cron/rate → ScheduleExpression + target Lambda + permissão (caso openai33)', () => {
    new Fn.Lambda(stack, 'ReportFn', { runtime: 'nodejs20', handler: 'r.handler', code: '.' });
    new Events.EventBridge(stack, 'Sched', { rules: [
      { name: 'Daily', cron: '0 8 * * ? *', targetLambdaId: 'ReportFn' },
      { name: 'Hourly', rate: '1 hour', targetLambdaId: 'ReportFn' },
    ] });
    const tpl = provider.synthesize(stack) as any;
    const rules = Object.values(tpl.Resources).filter((r: any) => r.Type === 'AWS::Events::Rule') as any[];
    const daily = rules.find(r => r.Properties.Name === 'Daily');
    const hourly = rules.find(r => r.Properties.Name === 'Hourly');
    expect(daily.Properties.ScheduleExpression).toBe('cron(0 8 * * ? *)');
    expect(hourly.Properties.ScheduleExpression).toBe('rate(1 hour)');
    expect(daily.Properties.Targets[0].Arn).toEqual({ 'Fn::GetAtt': ['ReportFn', 'Arn'] });
    const perms = Object.values(tpl.Resources).filter((r: any) => r.Type === 'AWS::Lambda::Permission') as any[];
    expect(perms.some(p => p.Properties.Principal === 'events.amazonaws.com')).toBe(true);
  });

  test('EventBridge rate normaliza singular/plural', () => {
    new Fn.Lambda(stack, 'F', { runtime: 'nodejs20', handler: 'f.handler', code: '.' });
    new Events.EventBridge(stack, 'S', { rules: [
      { name: 'R1', rate: '1 hours', targetLambdaId: 'F' },
      { name: 'R5', rate: '5 minute', targetLambdaId: 'F' },
    ] });
    const tpl = provider.synthesize(stack) as any;
    const rules = Object.values(tpl.Resources).filter((r: any) => r.Type === 'AWS::Events::Rule') as any[];
    expect(rules.find(r => r.Properties.Name === 'R1').Properties.ScheduleExpression).toBe('rate(1 hour)');
    expect(rules.find(r => r.Properties.Name === 'R5').Properties.ScheduleExpression).toBe('rate(5 minutes)');
  });

  test('Storage.Bucket cors → CorsConfiguration (caso openai32 upload)', () => {
    new Storage.Bucket(stack, 'Uploads', { versioning: true,
      cors: [{ allowedMethods: ['PUT', 'GET'], allowedOrigins: ['*'], maxAgeSeconds: 3000 }] });
    const tpl = provider.synthesize(stack) as any;
    const cors = tpl.Resources.Uploads.Properties.CorsConfiguration;
    expect(cors.CorsRules[0].AllowedMethods).toEqual(['PUT', 'GET']);
    expect(cors.CorsRules[0].MaxAge).toBe(3000);
  });

  test('bucket .name em env var e .arn/* em policy → refs reais (caso openai32)', () => {
    new Storage.Bucket(stack, 'Uploads', { versioning: false });
    new Fn.Lambda(stack, 'UpFn', { runtime: 'nodejs20', handler: 'u.handler', code: '.',
      environment: { BUCKET: 'Uploads.name' } });
    new Policy.IAM(stack, 'UpPolicy', { attachTo: 'UpFn', attachType: 'lambda',
      statements: [{ effect: 'Allow', actions: ['s3:PutObject'], resources: ['Uploads.arn/*'] }] });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.UpFn.Properties.Environment.Variables.BUCKET).toEqual({ Ref: 'Uploads' });
    const res = tpl.Resources.UpPolicyRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource[0];
    expect(res).toEqual({ 'Fn::Sub': ['${BArn}/*', { BArn: { 'Fn::GetAtt': ['Uploads', 'Arn'] } }] });
  });

  test('Messaging.Queue dlqArn por id de construct → RedrivePolicy com ARN resolvido', () => {
    new Messaging.Queue(stack, 'DLQ', {});
    new Messaging.Queue(stack, 'MainQ', { dlqArn: 'DLQ', maxReceiveCount: 5 });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.MainQ.Properties.RedrivePolicy.deadLetterTargetArn).toEqual({ 'Fn::GetAtt': ['DLQ', 'Arn'] });
  });

  test('env var QUEUE_URL/Arn de fila → Ref/GetAtt (não string literal)', () => {
    new Messaging.Queue(stack, 'TaskQueue', {});
    new Fn.Lambda(stack, 'ProducerFn', { runtime: 'nodejs20', handler: 'p.handler', code: '.',
      environment: { QUEUE_URL: 'TaskQueue.QueueUrl' } });
    new Policy.IAM(stack, 'P', { attachTo: 'ProducerFn', attachType: 'lambda',
      statements: [{ effect: 'Allow', actions: ['sqs:SendMessage'], resources: ['TaskQueue.Arn'] }] });
    const tpl = provider.synthesize(stack) as any;
    const fn = tpl.Resources.ProducerFn;
    expect(fn.Properties.Environment.Variables.QUEUE_URL).toEqual({ Ref: 'TaskQueue' });
    expect(tpl.Resources.PRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource).toEqual([{ 'Fn::GetAtt': ['TaskQueue', 'Arn'] }]);
  });
});
