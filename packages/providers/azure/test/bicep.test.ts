import { Stack, Compute, Storage, Network, Database, Fn, Messaging, Cache, Monitoring, ref, CONSTRUCT_TYPES } from '@iacmp/core';
import { AzureProvider, emitBicep } from '../src';
import { AZURE_ATTR_MAP, bv, expr } from '../src/synth/constructs/shared';

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

  test('Network.VPC com múltiplas Subnets → subnets INLINE (sem recursos separados — fix AnotherOperationInProgress)', () => {
    const stack = new Stack('test');
    new Network.VPC(stack, 'AppVpc', { cidr: '10.0.0.0/16' });
    new Network.Subnet(stack, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', public: false });
    new Network.Subnet(stack, 'PrivateSubnet2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', public: false });
    new Network.Subnet(stack, 'PublicSubnet1',  { vpcId: 'AppVpc', cidr: '10.0.3.0/24', public: true });
    new Network.Subnet(stack, 'PublicSubnet2',  { vpcId: 'AppVpc', cidr: '10.0.4.0/24', public: true });
    const out = synth(stack);
    // VNet existe
    expect(out).toContain("'Microsoft.Network/virtualNetworks@2023-04-01'");
    // Subnets inline (dentro do bloco subnets:)
    expect(out).toContain('10.0.1.0/24');
    expect(out).toContain('10.0.2.0/24');
    expect(out).toContain('10.0.3.0/24');
    expect(out).toContain('10.0.4.0/24');
    expect(out).toContain("name: 'PrivateSubnet1'");
    expect(out).toContain("name: 'PublicSubnet1'");
    // NÃO deve emitir recursos filho separados
    expect(out).not.toContain("'Microsoft.Network/virtualNetworks/subnets@");
  });

  test('ref(Subnet, SubnetId) → resourceId() em vez de sym.id (subnet inline)', () => {
    const stack = new Stack('test');
    new Network.VPC(stack, 'AppVpc', { cidr: '10.0.0.0/16' });
    new Network.Subnet(stack, 'PrivSub', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', public: false });
    // Compute.Container com env var que referencia SubnetId — exercita resolveRef
    new Compute.Container(stack, 'App', {
      image: 'nginx:latest',
      environment: { SUBNET_ID: ref('PrivSub', 'SubnetId') },
    } as any);
    const out = emitBicep(stack);
    // Deve gerar resourceId() — não referenciar o símbolo inexistente privSub
    expect(out).toContain("resourceId('Microsoft.Network/virtualNetworks/subnets'");
    expect(out).not.toContain('privSub.id');
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

  test('Function.Lambda nodejs20 → Azure Function App FC1 (Flex Consumption)', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const out = synth(stack);
    // FC1 (Flex Consumption): Function App = Microsoft.Web/sites, NÃO Container App
    expect(out).toContain("'Microsoft.Web/sites@2023-12-01'");
    expect(out).toContain("'Microsoft.Web/serverfarms@2023-12-01'");
    expect(out).toContain("name: 'FC1'");
    expect(out).toContain("tier: 'FlexConsumption'");
    expect(out).not.toContain("'Microsoft.App/containerApps@2023-05-01'");
    // FC1 aceita 1 Function App por plano — cada Lambda cria o seu próprio plano
    const stack2 = new Stack('multi');
    new Fn.Lambda(stack2, 'Fn1', { runtime: 'nodejs20', handler: 'a.handler', code: '.' });
    new Fn.Lambda(stack2, 'Fn2', { runtime: 'nodejs20', handler: 'b.handler', code: '.' });
    const out2 = synth(stack2);
    expect(out2.match(/'Microsoft\.Web\/sites@2023-12-01'/g)?.length).toBe(2);
    expect(out2.match(/'Microsoft\.Web\/serverfarms@2023-12-01'/g)?.length).toBe(2);
  });

  // ── Compute.Container → Container Apps (BCP055 fix) ──────────────────────────

  test('Compute.Container → Microsoft.App/containerApps (não ContainerInstance)', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'AppContainer', { image: 'myapp:latest', port: 8080 });
    const out = synth(stack);
    expect(out).toContain("'Microsoft.App/containerApps@2023-05-01'");
    expect(out).not.toContain('ContainerInstance');
    expect(out).not.toContain('containerGroups');
    expect(out).not.toContain('memoryInGB');
  });

  test('Compute.Container → shared ManagedEnvironment criado', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'AppContainer', { image: 'myapp:latest' });
    const out = synth(stack);
    expect(out.match(/'Microsoft\.App\/managedEnvironments@2023-05-01'/g)?.length).toBe(1);
  });

  test('Compute.Container → sem float literal (cpu usa json(), memory string Gi)', () => {
    const stack = new Stack('test');
    // 256 cpu units = 0.25 vCore, 512 MB = 0.5Gi
    new Compute.Container(stack, 'AppContainer', { image: 'myapp:latest', cpu: 256, memory: 512 });
    const out = synth(stack);
    // CPU: json() obrigatório (float literal BCP055)
    expect(out).toContain("json('0.25')");
    // Memory: string Gi (não número)
    expect(out).toContain("'0.5Gi'");
    // Garantir que não há 0.3 ou 0.5 como número literal (seria BCP055)
    expect(out).not.toMatch(/cpu:\s+0\.\d/);
    expect(out).not.toMatch(/memoryInGB:\s+0\.\d/);
  });

  test('Compute.Container com cpu:512 memory:1024 → json(0.5) e 1Gi', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'Worker', { image: 'worker:v1', cpu: 512, memory: 1024 });
    const out = synth(stack);
    expect(out).toContain("json('0.5')");
    expect(out).toContain("'1Gi'");
  });

  test('Compute.Container → image via parâmetro Bicep + ACR params', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'AppContainer', { image: 'myapp:latest', port: 3000 });
    const out = synth(stack);
    // Imagem via param (não hardcoded)
    expect(out).toContain('param appContainerImage string');
    expect(out).toContain('param acrServer string');
    expect(out).toContain('param acrPassword string');
  });

  test('Compute.Container → ingress externo com targetPort configurado', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'Web', { image: 'nginx:latest', port: 8080 });
    const out = synth(stack);
    expect(out).toContain('external: true');
    expect(out).toContain('targetPort: 8080');
  });

  test('Compute.Container → minReplicas/maxReplicas mapeados do autoscaling', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'Worker', { image: 'worker:v1', minCapacity: 2, maxCapacity: 20 });
    const out = synth(stack);
    expect(out).toContain('minReplicas: 2');
    expect(out).toContain('maxReplicas: 20');
  });

  test('Compute.Container → outputs Id, PrincipalId, Fqdn', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'AppContainer', { image: 'myapp:latest' });
    const out = synth(stack);
    expect(out).toContain('output AppContainerId');
    expect(out).toContain('output AppContainerPrincipalId');
    expect(out).toContain('output AppContainerFqdn');
    expect(out).toContain('.properties.configuration.ingress.fqdn');
  });

  test('Compute.Container e Function.Lambda na mesma stack → Container App + Function App FC1', () => {
    const stack = new Stack('mixed');
    new Compute.Container(stack, 'AppContainer', { image: 'myapp:latest' });
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: '.' });
    const out = synth(stack);
    // Container → 1 Container App + 1 managed environment; Lambda → 1 Function App FC1
    expect(out.match(/'Microsoft\.App\/managedEnvironments@2023-05-01'/g)?.length).toBe(1);
    expect(out.match(/'Microsoft\.App\/containerApps@2023-05-01'/g)?.length).toBe(1);
    expect(out.match(/'Microsoft\.Web\/sites@2023-12-01'/g)?.length).toBe(1);
  });

  test('Compute.Container env var undefined → erro claro no synth', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'App', { image: 'myapp:latest', environment: { X: undefined as any } });
    expect(() => synth(stack)).toThrow(/undefined|process\.env/i);
  });

  // ── Fim dos testes Compute.Container ─────────────────────────────────────────

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

  test('Cache.Redis → Microsoft.Cache/redis Standard C1 (não Enterprise)', () => {
    const stack = new Stack('test');
    new Cache.Redis(stack, 'MyRedis', { nodeType: 'small' });
    const out = synth(stack);
    // Standard C1 @2023-04-01 — Enterprise Balanced_B0 falha com AllocationFailed em várias regiões
    expect(out).toContain("'Microsoft.Cache/redis@2023-04-01'");
    expect(out).not.toContain('redisEnterprise');
    // porta TLS padrão do Azure Cache for Redis é 6380
    expect(out).toContain("'6380'");
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

describe('Network.CDN — accountTier free (Front Door proibido em Free Trial)', () => {
  test('free: NÃO emite recursos Microsoft.Cdn; Url sai do endpoint blob público', () => {
    const stack = new Stack('site');
    new Storage.Bucket(stack, 'AppBucket', {});
    new Network.CDN(stack, 'AppCDN', { defaultRootObject: 'index.html', origins: [{ id: 'o', domainName: '', bucketRef: 'AppBucket' }] });
    const bicep = emitBicep(stack, { accountTier: 'free' });
    expect(bicep).not.toContain('Standard_AzureFrontDoor');
    expect(bicep).not.toContain('Microsoft.Cdn/');
    expect(bicep).toContain("output AppCDNUrl string = '${appBucket.properties.primaryEndpoints.blob}web'");
    // o bucket referenciado continua ganhando o container web público
    expect(bicep).toContain("'web'");
    expect(bicep).toContain('allowBlobPublicAccess: true');
  });

  test('standard (default): mantém Front Door', () => {
    const stack = new Stack('site');
    new Storage.Bucket(stack, 'AppBucket', {});
    new Network.CDN(stack, 'AppCDN', { defaultRootObject: 'index.html', origins: [{ id: 'o', domainName: '', bucketRef: 'AppBucket' }] });
    const bicep = emitBicep(stack);
    expect(bicep).toContain('Standard_AzureFrontDoor');
  });
});

describe('Database.SQL — cadeia da senha e refs de conexão (ciclo p01az6)', () => {
  test('ref Password/Username/Port → adminPassword param, login e porta reais (não .id)', () => {
    const stack = new Stack('api');
    new Database.SQL(stack, 'AppDB', { engine: 'postgres' });
    new Fn.Lambda(stack, 'ListFn', {
      runtime: 'nodejs20', handler: 'dist/list.handler', code: '.',
      environment: {
        DB_HOST: ref('AppDB', 'Endpoint'),
        DB_PORT: ref('AppDB', 'Port'),
        DB_USER: ref('AppDB', 'Username'),
        DB_PASSWORD: ref('AppDB', 'Password'),
      },
    });
    const bicep = emitBicep(stack);
    expect(bicep).toContain('@secure()');
    expect(bicep).toMatch(/param adminPassword string\n/); // SEM default
    expect(bicep).toContain("AppDBUsername string = 'dbadmin'");
    expect(bicep).toContain("value: '5432'");
    expect(bicep).toContain('value: adminPassword');
    expect(bicep).not.toMatch(/DB_PASSWORD'[\s\S]{0,40}\.id/);
  });
});

test('Database.SQL postgres com backupRetentionDays: 0 (free) → piso de 7 (Azure exige mín 7)', () => {
  const stack = new Stack('db');
  new Database.SQL(stack, 'AppDB', { engine: 'postgres', backupRetentionDays: 0 });
  const bicep = emitBicep(stack);
  expect(bicep).toContain('backupRetentionDays: 7');
  expect(bicep).not.toContain('backupRetentionDays: 0');
});

describe('accountTier free → SKUs mais baratas (paridade de custo com AWS free)', () => {
  test('Database.SQL postgres free → Burstable B1ms (não GeneralPurpose)', () => {
    const stack = new Stack('db');
    new Database.SQL(stack, 'AppDB', { engine: 'postgres' });
    const free = emitBicep(stack, { accountTier: 'free' });
    expect(free).toContain("name: 'Standard_B1ms'");
    expect(free).toContain("tier: 'Burstable'");
    const std = emitBicep(stack, { accountTier: 'standard' });
    expect(std).toContain("name: 'Standard_D2ds_v5'");
  });

  test('Cache.Redis por tier: free → Basic C0 (menor custo), standard → Standard C1', () => {
    const stack = new Stack('c');
    new Cache.Redis(stack, 'AppCache', { nodeType: 'small' });
    // Azure não tem Redis grátis — free usa o menor SKU pago (Basic C0 ~USD 16/mês)
    const free = emitBicep(stack, { accountTier: 'free' });
    expect(free).toMatch(/name: 'Basic'[\s\S]{0,40}capacity: 0/);
    const std = emitBicep(stack, { accountTier: 'standard' });
    expect(std).toMatch(/name: 'Standard'[\s\S]{0,40}capacity: 1/);
    // nunca Enterprise (Balanced_B0 falha com AllocationFailed em várias regiões)
    expect(free).not.toContain('redisEnterprise');
    expect(std).not.toContain('redisEnterprise');
  });

  test('Database.DynamoDB → Cosmos Table API sem enableFreeTier (evita conflito de conta grátis)', () => {
    const stack = new Stack('t');
    new Database.DynamoDB(stack, 'ItemsTable', { partitionKey: 'id', partitionKeyType: 'S' } as any);
    const free = emitBicep(stack, { accountTier: 'free' });
    // deploy-validado p02az: Table API sobe sem enableFreeTier. O flag só permite 1
    // conta grátis por subscription — omitir evita colisão em projetos com 2 Cosmos.
    expect(free).toContain("'EnableTable'");
    expect(free).not.toContain('enableFreeTier');
  });
});

describe('Database.SQL Azure — firewall + admin dbadmin (ciclo p01az8: ETIMEDOUT + auth)', () => {
  test('postgres → firewallRule AllowAzure (0.0.0.0/0.0.0.0) e admin dbadmin', () => {
    const stack = new Stack('db');
    new Database.SQL(stack, 'AppDB', { engine: 'postgres' });
    const bicep = emitBicep(stack);
    expect(bicep).toContain('Microsoft.DBforPostgreSQL/flexibleServers/firewallRules');
    expect(bicep).toContain("startIpAddress: '0.0.0.0'");
    expect(bicep).toContain("administratorLogin: 'dbadmin'");
    expect(bicep).toContain("AppDBUsername string = 'dbadmin'");
    expect(bicep).not.toContain("'pgadmin'");
  });
  test('ref Username → dbadmin (bate com o admin do servidor)', () => {
    const stack = new Stack('app');
    new Database.SQL(stack, 'AppDB', { engine: 'postgres' });
    new Fn.Lambda(stack, 'Fn', { runtime: 'nodejs20', handler: 'dist/h.handler', code: '.', environment: { DB_USER: ref('AppDB', 'Username') } });
    const bicep = emitBicep(stack);
    expect(bicep).toMatch(/DB_USER'[\s\S]{0,40}'dbadmin'/);
  });
});

describe('Storage.Bucket Azure — CORS e env undefined (p04az)', () => {
  test('cors → blobServices com corsRules (não só versioning)', () => {
    const stack = new Stack('s');
    new Storage.Bucket(stack, 'Uploads', { cors: [{ allowedMethods: ['GET','PUT'], allowedOrigins: ['*'], allowedHeaders: ['*'], maxAgeSeconds: 3000 } as any] });
    const bicep = emitBicep(stack);
    expect(bicep).toContain('Microsoft.Storage/storageAccounts/blobServices');
    expect(bicep).toContain('corsRules');
    expect(bicep).toContain('maxAgeInSeconds: 3000');
  });
  test('env var resolvendo undefined (process.env.X na stack) → erro claro no synth', () => {
    const stack = new Stack('s');
    new Fn.Lambda(stack, 'Fn', { runtime: 'nodejs20', handler: 'dist/h.handler', code: '.', environment: { X: undefined as any } });
    expect(() => emitBicep(stack)).toThrow(/undefined|process\.env/i);
  });
});

test('Storage.Bucket ConnectionString → listKeys (não placeholder) + output cross-stack (p04az5)', () => {
  const stack = new Stack('s');
  const b = new Storage.Bucket(stack, 'Uploads', { cors: [{ allowedMethods: ['PUT'] } as any] });
  new Fn.Lambda(stack, 'Fn', { runtime: 'nodejs20', handler: 'dist/h.handler', code: '.', environment: { BLOB_CONNECTION: ref('Uploads', 'ConnectionString') } });
  const bicep = emitBicep(stack);
  expect(bicep).toContain('listKeys().keys[0].value');
  expect(bicep).toContain('output UploadsConnectionString');
  expect(bicep).not.toContain('your-blob-storage-key');
});

describe('Network.LoadBalancer Azure — no-op com Compute.Container (p10az)', () => {
  test('Compute.Container + Network.LoadBalancer → sem applicationGateways no Bicep', () => {
    const stack = new Stack('p10');
    new Compute.Container(stack, 'AppContainer', { image: 'myapp:latest', port: 3000, minCapacity: 2, maxCapacity: 10 });
    new Network.LoadBalancer(stack, 'AppAlb', { vpcId: 'vnet1', type: 'application', listeners: [{ port: 80, protocol: 'HTTP' }], targetGroups: [{ name: 'tg1', port: 3000, protocol: 'HTTP' }] });
    const out = emitBicep(stack);
    expect(out).not.toContain('applicationGateways');
    expect(out).toContain('Microsoft.App/containerApps');
  });

  test('Compute.Container + Network.LoadBalancer → Container App tem ingress externo', () => {
    const stack = new Stack('p10');
    new Compute.Container(stack, 'Web', { image: 'nginx:latest', port: 8080 });
    new Network.LoadBalancer(stack, 'WebAlb', { vpcId: 'vnet1', type: 'application', listeners: [{ port: 80, protocol: 'HTTP' }], targetGroups: [] });
    const out = emitBicep(stack);
    expect(out).toContain('external: true');
    expect(out).toContain('targetPort: 8080');
    expect(out).not.toContain('applicationGateways');
    expect(out).not.toContain('loadBalancers');
  });

  test('Network.LoadBalancer sem Compute.Container na stack → emite recurso (comportamento existente)', () => {
    const stack = new Stack('only-lb');
    new Network.LoadBalancer(stack, 'Alb', { vpcId: 'vnet1', type: 'application', listeners: [{ port: 80, protocol: 'HTTP' }], targetGroups: [] });
    const out = emitBicep(stack);
    expect(out).toContain('applicationGateways');
  });
});

describe('Storage.Bucket eventNotifications → Event Grid trigger (p11 Azure, pipeline Blob→ContainerApp)', () => {
  test('Storage.Bucket com eventNotifications + Function.Lambda same-stack → systemTopic + eventSubscription BlobCreated', () => {
    const stack = new Stack('p11');
    new Fn.Lambda(stack, 'DataProcessorFn', { runtime: 'nodejs20', handler: 'dist/processor.handler', code: '.' });
    new Storage.Bucket(stack, 'DataBucket', {
      eventNotifications: [{ lambdaId: 'DataProcessorFn', events: ['s3:ObjectCreated:*'] }],
    });
    const bicep = emitBicep(stack);
    // systemTopic no storage account
    expect(bicep).toContain("'Microsoft.EventGrid/systemTopics@2022-06-15'");
    expect(bicep).toContain("topicType: 'Microsoft.Storage.StorageAccounts'");
    // source aponta para o storage account (expressão ARM)
    expect(bicep).toContain('dataBucket.id');
    // eventSubscription com filtro BlobCreated
    expect(bicep).toContain("'Microsoft.EventGrid/systemTopics/eventSubscriptions@2022-06-15'");
    expect(bicep).toContain("'Microsoft.Storage.BlobCreated'");
    // webhook URL referencia o hostname da Function App FC1 (mesmo stack — referência direta)
    expect(bicep).toContain('dataProcessorFn.properties.defaultHostName');
    expect(bicep).toContain('/events');
    // dependsOn garante a Function App criada antes do eventSubscription (evita cold-start na validação)
    expect(bicep).toContain('dependsOn');
    expect(bicep).toContain('dataProcessorFn');
  });

  test('Storage.Bucket eventNotifications sem lambda na stack → cross-stack param Fqdn + webhook correto', () => {
    const stack = new Stack('storage-stack');
    new Storage.Bucket(stack, 'DataBucket', {
      eventNotifications: [{ lambdaId: 'DataProcessorFn', events: ['s3:ObjectCreated:*'] }],
    });
    const bicep = emitBicep(stack);
    // Cross-stack: sem o construct DataProcessorFn nesta stack → gera param
    expect(bicep).toContain('param DataProcessorFnFqdn string');
    expect(bicep).toContain("'Microsoft.EventGrid/systemTopics@2022-06-15'");
    expect(bicep).toContain("'Microsoft.EventGrid/systemTopics/eventSubscriptions@2022-06-15'");
    expect(bicep).toContain("'Microsoft.Storage.BlobCreated'");
    // webhook URL usa o param cross-stack
    expect(bicep).toContain('DataProcessorFnFqdn');
    expect(bicep).toContain('/events');
    // sem dependsOn (lambda em outra stack, não há símbolo local)
    expect(bicep).not.toContain('dependsOn');
  });

  test('Storage.Bucket sem eventNotifications → NÃO gera recursos Event Grid', () => {
    const stack = new Stack('plain');
    new Storage.Bucket(stack, 'SimpleBucket', { versioning: true });
    const bicep = emitBicep(stack);
    expect(bicep).not.toContain('EventGrid');
    expect(bicep).not.toContain('systemTopics');
    expect(bicep).not.toContain('eventSubscriptions');
  });

  test('Storage.Bucket com múltiplos eventNotifications → um systemTopic + um sub por lambda', () => {
    const stack = new Stack('multi');
    new Fn.Lambda(stack, 'Fn1', { runtime: 'nodejs20', handler: 'dist/fn1.handler', code: '.' });
    new Fn.Lambda(stack, 'Fn2', { runtime: 'nodejs20', handler: 'dist/fn2.handler', code: '.' });
    new Storage.Bucket(stack, 'SharedBucket', {
      eventNotifications: [
        { lambdaId: 'Fn1', events: ['s3:ObjectCreated:*'] },
        { lambdaId: 'Fn2', events: ['s3:ObjectCreated:*'] },
      ],
    });
    const bicep = emitBicep(stack);
    // Exatamente 1 systemTopic para o bucket
    expect(bicep.match(/'Microsoft\.EventGrid\/systemTopics@2022-06-15'/g)?.length).toBe(1);
    // 2 eventSubscriptions (uma por lambda)
    expect(bicep.match(/'Microsoft\.EventGrid\/systemTopics\/eventSubscriptions@2022-06-15'/g)?.length).toBe(2);
    expect(bicep).toContain('fn1.properties.defaultHostName');
    expect(bicep).toContain('fn2.properties.defaultHostName');
  });
});

describe('Nomes de output cross-stack — identificadores Bicep válidos (item 4)', () => {
  // Identificadores Bicep NÃO aceitam hífen. Um construct.id com hífen tem que
  // gerar output SEM hífen (via outputName/crossParamName), senão o Bicep é
  // inválido E o consumidor cross-stack pede um param que nunca bate.
  test('Database.SQL com id hifenizado → output sem hífen', () => {
    const stack = new Stack('db');
    new Database.SQL(stack, 'app-db', { engine: 'postgres', size: 'small' } as any);
    const out = emitBicep(stack, { accountTier: 'free' });
    // nome do output é sanitizado (appdbEndpoint), não app-dbEndpoint
    expect(out).toContain('output appdbEndpoint string');
    expect(out).toContain('output appdbPort string');
    expect(out).toContain('output appdbUsername string');
    expect(out).not.toMatch(/output app-db\w+ string/);
  });

  test('produtor de output e consumidor cross-stack usam a mesma sanitização', () => {
    // stack produtora: banco com hífen no id
    const dbStack = new Stack('db');
    new Database.SQL(dbStack, 'app-db', { engine: 'postgres', size: 'small' } as any);
    // stack consumidora: Function referencia o banco em OUTRA stack
    const apiStack = new Stack('api');
    new Fn.Lambda(apiStack, 'ApiFn', {
      runtime: 'nodejs20', handler: 'dist/api.handler', code: '.',
      environment: { DB_HOST: ref('app-db', 'Endpoint') },
    });
    const producer = emitBicep(dbStack, { accountTier: 'free' });
    const consumer = emitBicep(apiStack, { accountTier: 'free' });
    // o output do produtor (appdbEndpoint) tem que existir como param no consumidor
    expect(producer).toContain('output appdbEndpoint string');
    expect(consumer).toContain('param appdbEndpoint string');
  });
});

describe('bv() — guard de aspas duplas (Fase 2 item 3, bug fa435fe)', () => {
  test('string literal comum é quotada uma vez', () => {
    expect(bv('meu-recurso')).toBe("'meu-recurso'");
  });
  test('expr() é emitida crua, sem aspas', () => {
    expect(bv(expr('resourceGroup().location'))).toBe('resourceGroup().location');
  });
  test('string JÁ entre aspas (bug pré-quote sem expr) → lança em synth-time', () => {
    // era o bug do DocumentDB: name: `'${dbName}'` sem expr() → ''dbname''
    expect(() => bv("'docdatabase-db'")).toThrow(/já vem entre aspas|expr\(/);
  });
  test('valor com apóstrofo no meio NÃO é confundido com pré-quote', () => {
    expect(() => bv("it's fine")).not.toThrow();
    expect(bv("it's fine")).toBe("'it\\'s fine'");
  });
});

describe('Consistência de atributos — AZURE_ATTR_MAP ⊆ CONSTRUCT_TYPES (Fase 2 item 2)', () => {
  // O core (CONSTRUCT_TYPES.attributes) é a fonte única de verdade — a UNIÃO do
  // que os providers resolvem. Todo atributo que o Azure sabe resolver DEVE estar
  // declarado no canônico; senão é divergência silenciosa (o bug das "5 tabelas").
  test('todo atributo resolvível no Azure está declarado no canônico do core', () => {
    const violacoes: string[] = [];
    for (const [type, attrs] of Object.entries(AZURE_ATTR_MAP)) {
      const canonicos = CONSTRUCT_TYPES[type as keyof typeof CONSTRUCT_TYPES]?.attributes ?? [];
      for (const attr of Object.keys(attrs)) {
        if (!canonicos.includes(attr)) violacoes.push(`${type}.${attr} está no AZURE_ATTR_MAP mas não em CONSTRUCT_TYPES`);
      }
    }
    expect(violacoes).toEqual([]);
  });
});

describe('Validação semântica no Azure (Fase 2 item 1 — prepareStacksForSynth)', () => {
  // A validação só roda com o universo completo (allStacks). Antes, refs
  // quebradas/porta de SG só apareciam no deploy real; agora falham no synth.
  test('env var referenciando construct inexistente → falha no synth (com allStacks)', () => {
    const stack = new Stack('api');
    new Fn.Lambda(stack, 'ApiFn', {
      runtime: 'nodejs20', handler: 'dist/api.handler', code: '.',
      environment: { DB_HOST: 'NaoExiste.Endpoint' },
    });
    expect(() => emitBicep(stack, { accountTier: 'free', allStacks: [stack] }))
      .toThrow(/NaoExiste|não existe/i);
  });

  test('ref cross-stack VÁLIDA entre stacks distintas → NÃO falha (universo resolve)', () => {
    const netStack = new Stack('network');
    new Network.VPC(netStack, 'MainVnet', { cidr: '10.0.0.0/16' });
    const sgStack = new Stack('security');
    new Network.SecurityGroup(sgStack, 'DbSg', { vpcId: 'MainVnet', ingressRules: [] });
    // MainVnet está em OUTRA stack, mas allStacks contém as duas → resolve
    expect(() => emitBicep(sgStack, { accountTier: 'free', allStacks: [netStack, sgStack] }))
      .not.toThrow();
  });

  test('sem allStacks (fragmento isolado) → não valida refs cross-stack', () => {
    const stack = new Stack('sg');
    new Network.SecurityGroup(stack, 'SG', { vpcId: 'vnetEmOutraStack', ingressRules: [] });
    // unit test de fragmento: sem o universo, não dá para validar — não lança
    expect(() => emitBicep(stack, { accountTier: 'free' })).not.toThrow();
  });
});

describe('Monitoring.Alarm — alvo Function App FC1 cross-stack (gap 18)', () => {
  test('alarme sobre Fn.Lambda em outra stack → Microsoft.Web/sites + Http5xx + param cross-stack', () => {
    const computeStack = new Stack('compute');
    new Fn.Lambda(computeStack, 'CheckerFn', { runtime: 'nodejs20', handler: 'dist/checker.handler', code: '.' });
    const monStack = new Stack('monitoring');
    new Monitoring.Alarm(monStack, 'SiteDownAlarm', {
      metricName: 'Errors', threshold: 1, evaluationPeriods: 1, periodSeconds: 300,
      comparisonOperator: 'GreaterThanOrEqualToThreshold', statistic: 'Sum',
      dimensions: { FunctionName: ref('CheckerFn', 'Name') },
    } as never);
    const all = [computeStack, monStack];
    const mon = emitBicep(monStack, { accountTier: 'free', allStacks: all });
    // namespace e métrica de Function App (não Container Apps / Requests)
    expect(mon).toContain("metricNamespace: 'Microsoft.Web/sites'");
    expect(mon).toContain("metricName: 'Http5xx'");
    // scope via param cross-stack, não o placeholder vazio
    expect(mon).toContain('param CheckerFnId string');
    expect(mon).toContain('CheckerFnId');
    expect(mon).not.toContain("metricNamespace: 'Microsoft.App/containerApps'");
    // a stack produtora exporta o output homônimo (fecha a cadeia cross-stack)
    const compute = emitBicep(computeStack, { accountTier: 'free', allStacks: all });
    expect(compute).toContain('output CheckerFnId string');
  });

  test('alarme sobre Compute.Container → Microsoft.App/containerApps (mantém o caminho antigo)', () => {
    const appStack = new Stack('app');
    new Compute.Container(appStack, 'ApiContainer', { image: 'nginx:latest', subnetIds: ['subnet-a', 'subnet-b'] });
    const monStack = new Stack('mon');
    new Monitoring.Alarm(monStack, 'ErrAlarm', {
      metricName: 'Errors', threshold: 1, evaluationPeriods: 1, periodSeconds: 300,
    } as never);
    const out = emitBicep(monStack, { accountTier: 'free', allStacks: [appStack, monStack] });
    expect(out).toContain("metricNamespace: 'Microsoft.App/containerApps'");
    expect(out).toContain("metricName: 'Requests'");
  });
});
