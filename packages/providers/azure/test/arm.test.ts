import { Stack, Compute, Storage, Database, Cache, Messaging, Network, Fn, Custom } from '@iacmp/core';
import { AzureProvider } from '../src';

describe('AzureProvider', () => {
  test('sintetiza ARM Template', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'VM', { instanceType: 'small', image: 'ubuntu-22.04' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.$schema).toContain('deploymentTemplate.json');
    expect(tpl.resources[0].type).toBe('Microsoft.Compute/virtualMachines');
    expect(tpl.resources[0].properties.hardwareProfile.vmSize).toBe('Standard_B1s');
  });

  test('Storage.Bucket → Microsoft.Storage/storageAccounts', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Blob', { versioning: false });
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('Microsoft.Storage/storageAccounts');
  });

  test('Compute.Instance windows-2022 → publisher MicrosoftWindowsServer e adminUsername adminuser', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'WinVM', { instanceType: 'small', image: 'windows-2022' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    const imgRef = tpl.resources[0].properties.storageProfile.imageReference;
    expect(imgRef.publisher).toBe('MicrosoftWindowsServer');
    const adminUser = tpl.resources[0].properties.osProfile.adminUsername;
    expect(adminUser).toBe('adminuser');
  });

  test('Compute.Instance ubuntu-22.04 → publisher Canonical e adminUsername azureuser', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'UbuntuVM', { instanceType: 'small', image: 'ubuntu-22.04' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    const imgRef = tpl.resources[0].properties.storageProfile.imageReference;
    expect(imgRef.publisher).toBe('Canonical');
    const adminUser = tpl.resources[0].properties.osProfile.adminUsername;
    expect(adminUser).toBe('azureuser');
  });

  test('Database.SQL mysql → type contém DBforMySQL', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'MySQLDB', { engine: 'mysql' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toContain('DBforMySQL');
  });

  test('Database.SQL sqlserver → type contém Sql/servers', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'SqlDB', { engine: 'sqlserver' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toContain('Sql/servers');
  });

  test('Cache.Redis → type Microsoft.Cache/Redis', () => {
    const stack = new Stack('test');
    new Cache.Redis(stack, 'RedisCache', { nodeType: 'small' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('Microsoft.Cache/redis');
  });

  test('Messaging.Queue → type contém ServiceBus', () => {
    const stack = new Stack('test');
    new Messaging.Queue(stack, 'MyQueue', {});
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toContain('ServiceBus');
  });

  // ── IAC-07: protocol mapping seguro ──────────────────────────────────
  describe('IAC-07 NSG protocol mapping', () => {
    test('tcp → Tcp (case correto para Azure)', () => {
      const stack = new Stack('test');
      new Network.SecurityGroup(stack, 'NSG', {
        vpcId: 'vnet-1',
        ingressRules: [{ protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '10.0.0.0/8' } as any],
      });
      const tpl = new AzureProvider().synthesize(stack) as any;
      expect(tpl.resources[0].properties.securityRules[0].properties.protocol).toBe('Tcp');
    });

    test('udp → Udp', () => {
      const stack = new Stack('test');
      new Network.SecurityGroup(stack, 'NSG', {
        vpcId: 'vnet-1',
        ingressRules: [{ protocol: 'udp', fromPort: 53, toPort: 53, cidr: '10.0.0.0/8' } as any],
      });
      const tpl = new AzureProvider().synthesize(stack) as any;
      expect(tpl.resources[0].properties.securityRules[0].properties.protocol).toBe('Udp');
    });

    test('icmp → Icmp', () => {
      const stack = new Stack('test');
      new Network.SecurityGroup(stack, 'NSG', {
        vpcId: 'vnet-1',
        ingressRules: [{ protocol: 'icmp', fromPort: -1, toPort: -1, cidr: '10.0.0.0/8' } as any],
      });
      const tpl = new AzureProvider().synthesize(stack) as any;
      expect(tpl.resources[0].properties.securityRules[0].properties.protocol).toBe('Icmp');
    });

    test('-1 → * (any)', () => {
      const stack = new Stack('test');
      new Network.SecurityGroup(stack, 'NSG', {
        vpcId: 'vnet-1',
        ingressRules: [{ protocol: '-1', fromPort: 0, toPort: 0, cidr: '10.0.0.0/8' } as any],
      });
      const tpl = new AzureProvider().synthesize(stack) as any;
      expect(tpl.resources[0].properties.securityRules[0].properties.protocol).toBe('*');
    });

    test('protocol ausente nao lanca TypeError e cai em *', () => {
      const stack = new Stack('test');
      new Network.SecurityGroup(stack, 'NSG', {
        vpcId: 'vnet-1',
        ingressRules: [{ fromPort: 80, toPort: 80, cidr: '10.0.0.0/8' } as any],
      });
      const tpl = new AzureProvider().synthesize(stack) as any;
      expect(tpl.resources[0].properties.securityRules[0].properties.protocol).toBe('*');
    });

    test('protocol em maiusculas (TCP) tambem mapeia para Tcp', () => {
      const stack = new Stack('test');
      new Network.SecurityGroup(stack, 'NSG', {
        vpcId: 'vnet-1',
        ingressRules: [{ protocol: 'TCP', fromPort: 80, toPort: 80, cidr: '10.0.0.0/8' } as any],
      });
      const tpl = new AzureProvider().synthesize(stack) as any;
      expect(tpl.resources[0].properties.securityRules[0].properties.protocol).toBe('Tcp');
    });
  });

  // ── SEC-04 + ARCH-06 ─────────────────────────────────────────────────
  test('SEC-04: NSG ingress sem CIDR emite warn', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const stack = new Stack('test');
    new Network.SecurityGroup(stack, 'NSG', {
      vpcId: 'vnet-1',
      ingressRules: [{ protocol: 'tcp', fromPort: 22, toPort: 22 } as any],
    });
    new AzureProvider().synthesize(stack);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sem CIDR'));
    warnSpy.mockRestore();
  });

  test('ARCH-06: construct desconhecido emite warn', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const stack = new Stack('test');
    stack.addConstruct({ id: 'X', type: 'Foo.Bar', props: {} } as any);
    new AzureProvider().synthesize(stack);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'Foo.Bar' nao suportado"));
    warnSpy.mockRestore();
  });

  test('Function.ApiGateway sem authorizerLambdaId → só o serviço API Management', () => {
    const stack = new Stack('test');
    new Fn.ApiGateway(stack, 'Api', { name: 'my-api' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    const apimResources = tpl.resources.filter((r: any) => r.type.startsWith('Microsoft.ApiManagement'));
    expect(apimResources).toHaveLength(1);
    expect(apimResources[0].type).toBe('Microsoft.ApiManagement/service');
  });

  test('Function.ApiGateway com authorizerLambdaId → cria backend referenciando a Function App', () => {
    const stack = new Stack('test');
    new Fn.ApiGateway(stack, 'Api', { name: 'my-api', authorizerLambdaId: 'OAuthAuthorizerFn' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    const backend = tpl.resources.find((r: any) => r.type === 'Microsoft.ApiManagement/service/backends');
    expect(backend).toBeDefined();
    expect(backend.name).toBe('my-api/authorizer-backend');
    expect(backend.properties.url).toContain('OAuthAuthorizerFn');
    expect(backend.dependsOn.some((d: string) => d.includes('OAuthAuthorizerFn'))).toBe(true);
  });

  test('Custom.Resource → gera resource ARM a partir do props.arm', () => {
    const stack = new Stack('test');
    new Custom.Resource(stack, 'StaticWebApp', {
      arm: {
        type: 'Microsoft.Web/staticSites',
        apiVersion: '2023-01-01',
        properties: { repositoryUrl: 'https://github.com/example/repo', branch: 'main' },
        sku: { name: 'Free' },
      },
    });
    const tpl = new AzureProvider().synthesize(stack) as any;
    const resource = tpl.resources.find((r: any) => r.type === 'Microsoft.Web/staticSites');
    expect(resource).toBeDefined();
    expect(resource.properties.repositoryUrl).toBe('https://github.com/example/repo');
    expect(resource.sku.name).toBe('Free');
  });
});
