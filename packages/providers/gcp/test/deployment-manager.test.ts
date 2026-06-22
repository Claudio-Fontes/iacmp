import { Stack, Compute, Storage, Network, Database, Fn, Custom } from '@iacmp/core';
import { GCPProvider } from '../src';

describe('GCPProvider', () => {
  test('Compute.Instance ubuntu-22.04 → type compute.v1.instance e sourceImage contém ubuntu', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'VM', { instanceType: 'small', image: 'ubuntu-22.04' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('compute.v1.instance');
    expect(tpl.resources[0].properties.disks[0].initializeParams.sourceImage).toContain('ubuntu');
  });

  test('Compute.Instance windows-2022 → sourceImage contém windows', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'WinVM', { instanceType: 'small', image: 'windows-2022' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].properties.disks[0].initializeParams.sourceImage).toContain('windows');
  });

  test('Storage.Bucket → type storage.v1.bucket', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Bucket', { versioning: false });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('storage.v1.bucket');
  });

  test('Database.SQL mysql → type sqladmin.v1beta4.instance e databaseVersion contém MYSQL', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'MySQLDB', { engine: 'mysql' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('sqladmin.v1beta4.instance');
    expect(tpl.resources[0].properties.databaseVersion).toContain('MYSQL');
  });

  test('Database.SQL postgres → databaseVersion contém POSTGRES', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'PgDB', { engine: 'postgres' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].properties.databaseVersion).toContain('POSTGRES');
  });

  test('Database.SQL sqlserver → databaseVersion contém SQLSERVER', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'SqlDB', { engine: 'sqlserver' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].properties.databaseVersion).toContain('SQLSERVER');
  });

  test('Fn.Lambda → type cloudfunctions.v2.function', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('cloudfunctions.v2.function');
  });

  test('Network.VPC → type compute.v1.network', () => {
    const stack = new Stack('test');
    new Network.VPC(stack, 'Rede', { cidr: '10.0.0.0/16' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('compute.v1.network');
  });

  // ── IAC-04: Storage.Bucket usa props.location ────────────────────────
  describe('IAC-04 Storage.Bucket location', () => {
    test('sem location → usa default US', () => {
      const stack = new Stack('test');
      new Storage.Bucket(stack, 'B', { versioning: false });
      const tpl = new GCPProvider().synthesize(stack) as any;
      expect(tpl.resources[0].properties.location).toBe('US');
    });

    test('com location explicito → respeita o valor', () => {
      const stack = new Stack('test');
      new Storage.Bucket(stack, 'B', { versioning: false, location: 'EU' });
      const tpl = new GCPProvider().synthesize(stack) as any;
      expect(tpl.resources[0].properties.location).toBe('EU');
    });

    test('com location regional → respeita', () => {
      const stack = new Stack('test');
      new Storage.Bucket(stack, 'B', { versioning: false, location: 'us-central1' });
      const tpl = new GCPProvider().synthesize(stack) as any;
      expect(tpl.resources[0].properties.location).toBe('us-central1');
    });
  });

  // ── IAC-05: GCS lifecycle separa SetStorageClass + Delete ───────────
  describe('IAC-05 Storage.Bucket lifecycle', () => {
    test('transition + expiration geram duas regras separadas', () => {
      const stack = new Stack('test');
      new Storage.Bucket(stack, 'B', {
        versioning: false,
        lifecycleRules: [{ transitionToGlacierDays: 30, expireAfterDays: 365 }],
      });
      const tpl = new GCPProvider().synthesize(stack) as any;
      const rules = tpl.resources[0].properties.lifecycle.rule;
      expect(rules).toHaveLength(2);
      const setClass = rules.find((r: any) => r.action.type === 'SetStorageClass');
      const del = rules.find((r: any) => r.action.type === 'Delete');
      expect(setClass).toBeDefined();
      expect(setClass.action.storageClass).toBe('ARCHIVE');
      expect(setClass.condition.age).toBe(30);
      expect(del).toBeDefined();
      expect(del.condition.age).toBe(365);
    });

    test('apenas expiration gera somente regra Delete', () => {
      const stack = new Stack('test');
      new Storage.Bucket(stack, 'B', {
        versioning: false,
        lifecycleRules: [{ expireAfterDays: 90 }],
      });
      const tpl = new GCPProvider().synthesize(stack) as any;
      const rules = tpl.resources[0].properties.lifecycle.rule;
      expect(rules).toHaveLength(1);
      expect(rules[0].action.type).toBe('Delete');
      expect(rules[0].condition.age).toBe(90);
    });

    test('apenas transition gera somente regra SetStorageClass', () => {
      const stack = new Stack('test');
      new Storage.Bucket(stack, 'B', {
        versioning: false,
        lifecycleRules: [{ transitionToGlacierDays: 60 }],
      });
      const tpl = new GCPProvider().synthesize(stack) as any;
      const rules = tpl.resources[0].properties.lifecycle.rule;
      expect(rules).toHaveLength(1);
      expect(rules[0].action.type).toBe('SetStorageClass');
      expect(rules[0].condition.age).toBe(60);
    });

    test('prefix aplica em todas as regras geradas', () => {
      const stack = new Stack('test');
      new Storage.Bucket(stack, 'B', {
        versioning: false,
        lifecycleRules: [{ prefix: 'logs/', transitionToGlacierDays: 30, expireAfterDays: 365 }],
      });
      const tpl = new GCPProvider().synthesize(stack) as any;
      const rules = tpl.resources[0].properties.lifecycle.rule;
      expect(rules).toHaveLength(2);
      for (const r of rules) {
        expect(r.condition.matchesPrefix).toEqual(['logs/']);
      }
    });
  });

  // ── SEC-04 + ARCH-06 ─────────────────────────────────────────────────
  test('SEC-04: firewall ingress sem CIDR emite warn', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const stack = new Stack('test');
    new Network.SecurityGroup(stack, 'SG', {
      vpcId: 'vpc-1',
      ingressRules: [{ protocol: 'tcp', fromPort: 22, toPort: 22 } as any],
    });
    const tpl = new GCPProvider().synthesize(stack) as any;
    const ingress = tpl.resources.find((r: any) => r.name === 'SG-ingress-0');
    expect(ingress.properties.sourceRanges).toEqual(['0.0.0.0/0']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sem CIDR'));
    warnSpy.mockRestore();
  });

  test('ARCH-06: construct desconhecido emite warn', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const stack = new Stack('test');
    stack.addConstruct({ id: 'X', type: 'Foo.Bar', props: {} } as any);
    new GCPProvider().synthesize(stack);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'Foo.Bar' nao suportado"));
    warnSpy.mockRestore();
  });

  test('Function.ApiGateway com authorizerLambdaId → securityDefinition customizada no OpenAPI', () => {
    const stack = new Stack('test');
    new Fn.ApiGateway(stack, 'Api', {
      name: 'my-api',
      authorizerLambdaId: 'OAuthAuthorizerFn',
      routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }],
    });
    const tpl = new GCPProvider().synthesize(stack) as any;
    const configResource = tpl.resources.find((r: any) => r.type === 'apigateway.v1.apiConfig');
    const doc = configResource.properties.openapiDocuments[0].document;
    const openapi = JSON.parse(Buffer.from(doc.contents, 'base64').toString());
    expect(openapi.securityDefinitions.lambdaAuthorizer['x-google-authorizer-backend'].address).toContain('OAuthAuthorizerFn');
    expect(openapi.paths['/hello'].get.security).toEqual([{ lambdaAuthorizer: [] }]);
  });

  test('Function.ApiGateway sem authorizerLambdaId → sem securityDefinitions', () => {
    const stack = new Stack('test');
    new Fn.ApiGateway(stack, 'Api', { name: 'my-api', routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }] });
    const tpl = new GCPProvider().synthesize(stack) as any;
    const configResource = tpl.resources.find((r: any) => r.type === 'apigateway.v1.apiConfig');
    const doc = configResource.properties.openapiDocuments[0].document;
    const openapi = JSON.parse(Buffer.from(doc.contents, 'base64').toString());
    expect(openapi.securityDefinitions).toBeUndefined();
    expect(openapi.paths['/hello'].get.security).toBeUndefined();
  });

  test('Custom.Resource → gera resource Deployment Manager a partir do props.deploymentManager', () => {
    const stack = new Stack('test');
    new Custom.Resource(stack, 'PubSubTopic', {
      deploymentManager: {
        type: 'pubsub.v1.topic',
        properties: { topic: 'projects/PROJECT_ID/topics/my-topic' },
      },
    });
    const tpl = new GCPProvider().synthesize(stack) as any;
    const resource = tpl.resources.find((r: any) => r.type === 'pubsub.v1.topic');
    expect(resource).toBeDefined();
    expect(resource.properties.topic).toBe('projects/PROJECT_ID/topics/my-topic');
  });
});
