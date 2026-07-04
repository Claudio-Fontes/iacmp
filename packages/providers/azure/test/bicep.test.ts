import { Stack, Compute, Storage, Network, Database, Fn, Messaging, Cache } from '@iacmp/core';
import { AzureProvider } from '../src';

function synth(stack: Stack): string {
  return new AzureProvider().synthesize(stack);
}

describe('AzureProvider (Bicep)', () => {
  test('Compute.Instance → resource com Microsoft.Compute/virtualMachines', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'VM', { instanceType: 'small', image: 'ubuntu-22.04' });
    const out = synth(stack);
    expect(out).toContain("'Microsoft.Compute/virtualMachines@2023-03-01'");
    expect(out).toContain('Standard_B1s');
  });

  test('Compute.Instance windows → imagem windows', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'WinVM', { instanceType: 'small', image: 'windows-2022' });
    const out = synth(stack);
    expect(out).toContain('2022-Datacenter');
  });

  test('Storage.Bucket → Microsoft.Storage/storageAccounts', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Bucket', { versioning: false });
    const out = synth(stack);
    expect(out).toContain("'Microsoft.Storage/storageAccounts@2023-01-01'");
  });

  test('Storage.Bucket versioning true → recurso blobServices filho', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'B', { versioning: true });
    const out = synth(stack);
    expect(out).toContain("'Microsoft.Storage/storageAccounts/blobServices@2023-01-01'");
    expect(out).toContain('isVersioningEnabled: true');
  });

  test('Network.VPC → Microsoft.Network/virtualNetworks', () => {
    const stack = new Stack('test');
    new Network.VPC(stack, 'Rede', { cidr: '10.0.0.0/16' });
    const out = synth(stack);
    expect(out).toContain("'Microsoft.Network/virtualNetworks@2023-04-01'");
    expect(out).toContain('10.0.0.0/16');
  });

  test('Network.SecurityGroup → Microsoft.Network/networkSecurityGroups', () => {
    const stack = new Stack('test');
    new Network.SecurityGroup(stack, 'SG', {
      vpcId: 'myVnet',
      ingressRules: [{ protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '0.0.0.0/0' }],
    });
    const out = synth(stack);
    expect(out).toContain("'Microsoft.Network/networkSecurityGroups@2023-04-01'");
    expect(out).toContain('Inbound');
  });

  test('Network.SecurityGroup sem CIDR → console.warn e usa *', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const stack = new Stack('test');
    new Network.SecurityGroup(stack, 'SG', {
      vpcId: 'myVnet',
      ingressRules: [{ protocol: 'tcp', fromPort: 22, toPort: 22 } as any],
    });
    const out = synth(stack);
    expect(out).toContain("'*'");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sem CIDR'));
    warnSpy.mockRestore();
  });

  test('Database.SQL mysql → Microsoft.DBforMySQL/flexibleServers', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'MySQLDB', { engine: 'mysql' });
    const out = synth(stack);
    expect(out).toContain("'Microsoft.DBforMySQL/flexibleServers@2023-06-30'");
    expect(out).toContain('adminPassword');
  });

  test('Database.SQL postgres → Microsoft.DBforPostgreSQL/flexibleServers', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'PgDB', { engine: 'postgres' });
    const out = synth(stack);
    expect(out).toContain("'Microsoft.DBforPostgreSQL/flexibleServers@");
  });

  test('Database.SQL sqlserver → Microsoft.Sql/servers', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'SqlDB', { engine: 'sqlserver' });
    const out = synth(stack);
    expect(out).toContain("'Microsoft.Sql/servers@2023-02-01-preview'");
  });

  test('Function.Lambda nodejs20 → Microsoft.App/containerApps (shared env, ACR params)', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const out = synth(stack);
    // Um único ManagedEnvironment compartilhado por stack
    expect(out.match(/'Microsoft\.App\/managedEnvironments@2023-05-01'/g)?.length).toBe(1);
    expect(out).toContain("'Microsoft.App/containerApps@2023-05-01'");
    // Imagem via parâmetro (não hardcoded)
    expect(out).toContain('param handlerImage string');
    expect(out).toContain('param acrServer string');
    // Múltiplas Lambdas ainda usam o mesmo environment
    const stack2 = new Stack('multi');
    new Fn.Lambda(stack2, 'Fn1', { runtime: 'nodejs20', handler: 'a.handler', code: '.' });
    new Fn.Lambda(stack2, 'Fn2', { runtime: 'nodejs20', handler: 'b.handler', code: '.' });
    const out2 = synth(stack2);
    expect(out2.match(/'Microsoft\.App\/managedEnvironments@2023-05-01'/g)?.length).toBe(1);
    expect(out2.match(/'Microsoft\.App\/containerApps@2023-05-01'/g)?.length).toBe(2);
  });

  test('Messaging.Queue → namespaces + queues', () => {
    const stack = new Stack('test');
    new Messaging.Queue(stack, 'MyQueue', {});
    const out = synth(stack);
    expect(out).toContain("'Microsoft.ServiceBus/namespaces@2022-10-01-preview'");
    expect(out).toContain("'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview'");
  });

  test('Messaging.Topic → namespaces + topics', () => {
    const stack = new Stack('test');
    new Messaging.Topic(stack, 'MyTopic', {});
    const out = synth(stack);
    expect(out).toContain("'Microsoft.ServiceBus/namespaces/topics@2022-10-01-preview'");
  });

  test('Cache.Redis → Microsoft.Cache/redis', () => {
    const stack = new Stack('test');
    new Cache.Redis(stack, 'MyRedis', { nodeType: 'small' });
    const out = synth(stack);
    expect(out).toContain("'Microsoft.Cache/redis@2023-08-01'");
  });

  test('Secret.Vault → Microsoft.KeyVault/vaults com subscription().tenantId', () => {
    const stack = new Stack('test');
    stack.addConstruct({ id: 'MySecret', type: 'Secret.Vault', props: {} } as any);
    const out = synth(stack);
    expect(out).toContain("'Microsoft.KeyVault/vaults@2023-02-01'");
    expect(out).toContain('subscription().tenantId');
  });

  test('param location presente com default resourceGroup().location', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'B', {});
    const out = synth(stack);
    expect(out).toContain('param location string');
    expect(out).toContain('resourceGroup().location');
  });

  test('Construct desconhecido → console.warn "nao suportado"', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const stack = new Stack('test');
    stack.addConstruct({ id: 'X', type: 'Foo.Bar', props: {} } as any);
    new AzureProvider().synthesize(stack);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nao suportado'));
    warnSpy.mockRestore();
  });

  test('output presente para Storage.Bucket', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'MyBucket', {});
    const out = synth(stack);
    expect(out).toContain('output MyBucket');
    expect(out).toContain('.id');
  });

  test('Storage.Bucket sem location → usa param location', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'B', {});
    const out = synth(stack);
    expect(out).toMatch(/location: location\b/);
  });

  test('NSG tcp → Tcp', () => {
    const stack = new Stack('test');
    new Network.SecurityGroup(stack, 'NSG', {
      vpcId: 'vnet-1',
      ingressRules: [{ protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '10.0.0.0/8' } as any],
    });
    const out = synth(stack);
    expect(out).toContain("protocol: 'Tcp'");
  });

  test('NSG -1 → *', () => {
    const stack = new Stack('test');
    new Network.SecurityGroup(stack, 'NSG', {
      vpcId: 'vnet-1',
      ingressRules: [{ protocol: '-1', fromPort: 0, toPort: 0, cidr: '10.0.0.0/8' } as any],
    });
    const out = synth(stack);
    expect(out).toContain("protocol: '*'");
  });

  test('Function.ApiGateway sem authorizerLambdaId → só serviço APIM', () => {
    const stack = new Stack('test');
    new Fn.ApiGateway(stack, 'Api', { name: 'my-api' });
    const out = synth(stack);
    const count = (out.match(/'Microsoft\.ApiManagement\/service@/g) ?? []).length;
    expect(count).toBe(1);
    expect(out).not.toContain("'Microsoft.ApiManagement/service/backends@");
  });

  test('Function.ApiGateway com authorizerLambdaId → cria backend filho', () => {
    const stack = new Stack('test');
    new Fn.ApiGateway(stack, 'Api', { name: 'my-api', authorizerLambdaId: 'OAuthFn' });
    const out = synth(stack);
    expect(out).toContain("'Microsoft.ApiManagement/service/backends@");
    expect(out).toContain('OAuthFn');
  });

  test('Custom.Resource → gera resource a partir de props.arm', () => {
    const stack = new Stack('test');
    stack.addConstruct({
      id: 'StaticWebApp',
      type: 'Custom.Resource',
      props: {
        arm: {
          type: 'Microsoft.Web/staticSites',
          apiVersion: '2023-01-01',
          properties: { repositoryUrl: 'https://github.com/example/repo' },
          sku: { name: 'Free' },
        },
      },
    } as any);
    const out = synth(stack);
    expect(out).toContain("'Microsoft.Web/staticSites@2023-01-01'");
    expect(out).toContain('repositoryUrl');
  });

  test('Database.DynamoDB → conta Cosmos + tabela filha + output ConnectionString', () => {
    const stack = new Stack('test');
    new Database.DynamoDB(stack, 'ItemsTable', { partitionKey: 'id' });
    const out = synth(stack);
    // Conta Cosmos DB (Table API)
    expect(out).toContain("'Microsoft.DocumentDB/databaseAccounts@2023-04-15'");
    expect(out).toContain('EnableTable');
    // Tabela filha — sem ela o SDK falha com TableNotFound
    expect(out).toContain("'Microsoft.DocumentDB/databaseAccounts/tables@2023-04-15'");
    // Output ConnectionString com listKeys()
    expect(out).toContain('ConnectionString');
    expect(out).toContain('listKeys().primaryMasterKey');
    expect(out).toContain('table.cosmos.azure.com');
    // Output Name e Arn
    expect(out).toContain('ItemsTableName');
    expect(out).toContain('ItemsTableArn');
  });

  test('Database.DynamoDB → ref ConnectionString same-stack resolve para expressão listKeys()', () => {
    const stack = new Stack('test');
    const { ref: coreRef } = require('@iacmp/core');
    new Database.DynamoDB(stack, 'ItemsTable', { partitionKey: 'id' });
    new Fn.Lambda(stack, 'ApiFn', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: 'dist/',
      environment: {
        COSMOS_CONNECTION: coreRef('ItemsTable', 'ConnectionString'),
        TABLE_NAME: coreRef('ItemsTable', 'Name'),
      },
    });
    const out = synth(stack);
    // A env var COSMOS_CONNECTION deve conter a expressão listKeys() inline
    expect(out).toContain('COSMOS_CONNECTION');
    expect(out).toContain('listKeys().primaryMasterKey');
    // TABLE_NAME deve conter referência ao .name da conta
    expect(out).toContain('TABLE_NAME');
  });

  // ── Network.CDN → Azure Front Door Standard ────────────────────────────────

  test('Network.CDN → sku Standard_AzureFrontDoor (não Standard_Microsoft)', () => {
    const stack = new Stack('test');
    new Network.CDN(stack, 'MyCdn', { origins: [{ domainName: 'example.com' }] } as any);
    const out = synth(stack);
    expect(out).toContain('Standard_AzureFrontDoor');
    expect(out).not.toContain('Standard_Microsoft');
  });

  test('Network.CDN → emite afdEndpoints, originGroups, origins, routes', () => {
    const stack = new Stack('test');
    new Network.CDN(stack, 'MyCdn', { origins: [{ domainName: 'api.example.com' }] } as any);
    const out = synth(stack);
    expect(out).toContain("'Microsoft.Cdn/profiles/afdEndpoints@2023-05-01'");
    expect(out).toContain("'Microsoft.Cdn/profiles/originGroups@2023-05-01'");
    expect(out).toContain("'Microsoft.Cdn/profiles/originGroups/origins@2023-05-01'");
    expect(out).toContain("'Microsoft.Cdn/profiles/afdEndpoints/routes@2023-05-01'");
    // Output URL do endpoint
    expect(out).toContain('output MyCdnUrl');
    expect(out).toContain('properties.hostName');
  });

  test('Network.CDN com bucketRef em origins → hostName usa primaryEndpoints.blob (não string vazia)', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'SiteBucket', {});
    new Network.CDN(stack, 'SiteCdn', {
      origins: [{ domainName: 'placeholder.blob.core.windows.net', id: 'site', bucketRef: 'SiteBucket' }],
    });
    const out = synth(stack);
    // O origin hostName deve referenciar o blob endpoint da storage — não string vazia
    expect(out).toContain('primaryEndpoints.blob');
    expect(out).toContain("replace(replace(siteBucket.properties.primaryEndpoints.blob,'https://',''),'/','')");
    // A storage referenciada ganha allowBlobPublicAccess: true
    expect(out).toContain('allowBlobPublicAccess: true');
    // Container 'web' criado para servir o conteúdo
    expect(out).toContain("'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01'");
    expect(out).toContain("name: 'web'");
    expect(out).toContain("publicAccess: 'Blob'");
    // originPath '/web' na route
    expect(out).toContain("originPath: '/web'");
  });
});
