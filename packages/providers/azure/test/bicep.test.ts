import { Stack, Compute, Storage, Network, Database, Fn, Messaging, Cache, Monitoring, ref, CONSTRUCT_TYPES } from '@iacmp/core';
import { AzureProvider, emitBicep, extractAzureContainerBuilds } from '../src';
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

  test('Function.Lambda nodejs20 → Azure Function App Consumption (Y1/Dynamic, sem serverfarms explícito)', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const out = synth(stack);
    // Consumption (Y1/Dynamic): Function App = Microsoft.Web/sites, NÃO Container App.
    // NUNCA um Microsoft.Web/serverfarms explícito — validado por deploy real:
    // subscriptions free-tier/restritas barram QUALQUER PUT direto nesse tipo
    // (ServerFarmCreationNotAllowed), mesmo Y1/Dynamic. Sem serverFarmId nas
    // properties, o ARM cria/reaproveita o plano Dynamic compartilhado da região.
    expect(out).toContain("'Microsoft.Web/sites@2023-12-01'");
    expect(out).not.toContain('Microsoft.Web/serverfarms');
    expect(out).not.toContain('serverFarmId');
    expect(out).not.toContain('functionAppConfig');
    expect(out).toContain("reserved: true");
    expect(out).toContain("linuxFxVersion: 'Node|20'");
    expect(out).not.toContain("'Microsoft.App/containerApps@2023-05-01'");
    // Cada Lambda cria seu próprio Microsoft.Web/sites (sem plano dedicado por Lambda)
    const stack2 = new Stack('multi');
    new Fn.Lambda(stack2, 'Fn1', { runtime: 'nodejs20', handler: 'a.handler', code: '.' });
    new Fn.Lambda(stack2, 'Fn2', { runtime: 'nodejs20', handler: 'b.handler', code: '.' });
    const out2 = synth(stack2);
    expect(out2.match(/'Microsoft\.Web\/sites@2023-12-01'/g)?.length).toBe(2);
    expect(out2).not.toContain('Microsoft.Web/serverfarms');
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

  test('Compute.Container e Function.Lambda na mesma stack → Container App + Function App Consumption', () => {
    const stack = new Stack('mixed');
    new Compute.Container(stack, 'AppContainer', { image: 'myapp:latest' });
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: '.' });
    const out = synth(stack);
    // Container → 1 Container App + 1 managed environment; Lambda → 1 Function App (Consumption)
    expect(out.match(/'Microsoft\.App\/managedEnvironments@2023-05-01'/g)?.length).toBe(1);
    expect(out.match(/'Microsoft\.App\/containerApps@2023-05-01'/g)?.length).toBe(1);
    expect(out.match(/'Microsoft\.Web\/sites@2023-12-01'/g)?.length).toBe(1);
  });

  test('Compute.Container env var undefined → erro claro no synth', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'App', { image: 'myapp:latest', environment: { X: undefined as any } });
    expect(() => synth(stack)).toThrow(/undefined|process\.env/i);
  });

  test('Compute.Container com build (sem image) → ainda emite param de imagem + ACR params', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'AppContainer', { build: { context: './services/app' }, port: 3000 } as any);
    const out = synth(stack);
    // Mesmo mecanismo de param usado para image literal — o deploy injeta o valor real via --parameters.
    expect(out).toContain('param appContainerImage string');
    expect(out).toContain('param acrServer string');
    expect(out).toContain('param acrPassword string');
  });

  test('extractAzureContainerBuilds → coleta build por Compute.Container e ignora quem usa image literal', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'AppContainer', { build: { context: './services/app', dockerfile: 'Dockerfile.prod' } } as any);
    new Compute.Container(stack, 'Web', { image: 'nginx:latest' });
    const builds = extractAzureContainerBuilds(stack, 'MeuProjeto');
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({
      constructId: 'AppContainer',
      imageParamName: 'appContainerImage',
      repository: 'meuprojeto-appcontainer',
      tag: 'latest',
      context: './services/app',
      dockerfile: 'Dockerfile.prod',
    });
  });

  test('extractAzureContainerBuilds → sem projectName usa slug "iacmp" default', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'Api', { build: { context: '.' } } as any);
    const builds = extractAzureContainerBuilds(stack);
    expect(builds[0].repository).toBe('iacmp-api');
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

  test('Cache.Redis → Microsoft.Cache/redisEnterprise (Basic/Standard/Premium retirado)', () => {
    const stack = new Stack('test');
    new Cache.Redis(stack, 'MyRedis', { nodeType: 'small' });
    const out = synth(stack);
    // Azure Cache for Redis clássico (Basic/Standard/Premium) foi retirado — novas
    // contas recebem InvalidRequestBody. Substituto: Azure Managed Redis (redisEnterprise).
    expect(out).toContain("'Microsoft.Cache/redisEnterprise@2025-07-01'");
    expect(out).toContain("'Microsoft.Cache/redisEnterprise/databases@2025-07-01'");
    expect(out).not.toContain("'Microsoft.Cache/redis@");
    expect(out).toContain("name: 'Balanced_B0'");
    expect(out).toContain("clusteringPolicy: 'NoCluster'");
    // porta TLS do Azure Managed Redis é 10000 (NUNCA 6379/6380)
    expect(out).toContain("'10000'");
    expect(out).toContain('port: 10000');
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

  test('Database.DynamoDB → conta Cosmos MongoDB API + database/collection filhos + output ConnectionString', () => {
    const stack = new Stack('test');
    new Database.DynamoDB(stack, 'ItemsTable', { partitionKey: 'id' });
    const out = synth(stack);
    // Conta Cosmos DB (MongoDB API — DynamoDB no Azure NÃO é Table API)
    expect(out).toContain("'Microsoft.DocumentDB/databaseAccounts@2023-04-15'");
    expect(out).toContain("kind: 'MongoDB'");
    // Database + collection filhos — sem eles o driver mongodb falha ao conectar
    expect(out).toContain("'Microsoft.DocumentDB/databaseAccounts/mongodbDatabases@2023-04-15'");
    expect(out).toContain("'Microsoft.DocumentDB/databaseAccounts/mongodbDatabases/collections@2023-04-15'");
    // Output ConnectionString com listConnectionStrings() (URI mongodb://)
    expect(out).toContain('ConnectionString');
    expect(out).toContain('listConnectionStrings().connectionStrings[0].connectionString');
    // Output Name e Arn
    expect(out).toContain('ItemsTableName');
    expect(out).toContain('ItemsTableArn');
  });

  test('Database.DynamoDB → ref ConnectionString same-stack resolve para expressão listConnectionStrings()', () => {
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
    // A env var COSMOS_CONNECTION deve conter a expressão listConnectionStrings() inline (URI mongodb://)
    expect(out).toContain('COSMOS_CONNECTION');
    expect(out).toContain('listConnectionStrings().connectionStrings[0].connectionString');
    // TABLE_NAME deve conter referência ao Name resolvido
    expect(out).toContain('TABLE_NAME');
    // TABLE_NAME dispara o auto-inject de MONGO_URI/DB_NAME (function.ts)
    expect(out).toContain('MONGO_URI');
    expect(out).toContain('DB_NAME');
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

  test('Network.CDN com bucketRef em origins (bucket SEM websiteHosting) → hostName usa primaryEndpoints.blob, sem container decorativo', () => {
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
    // NÃO cria mais o container decorativo 'web' — nada nunca fazia upload nele e um
    // container Blob comum não resolve documento default no root (bug confirmado em
    // deploy real, bateria p06). Nem originPath '/web' na route.
    expect(out).not.toContain("'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01'");
    expect(out).not.toContain('originPath');
  });

  test('Network.CDN com bucketRef em origins (bucket COM websiteHosting) → hostName usa primaryEndpoints.web, sem originPath', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'SiteBucket', { websiteHosting: true });
    new Network.CDN(stack, 'SiteCdn', {
      origins: [{ domainName: 'placeholder.blob.core.windows.net', id: 'site', bucketRef: 'SiteBucket' }],
    });
    const out = synth(stack);
    expect(out).toContain("replace(replace(siteBucket.properties.primaryEndpoints.web,'https://',''),'/','')");
    expect(out).not.toContain('primaryEndpoints.blob');
    expect(out).toContain('allowBlobPublicAccess: true');
    expect(out).not.toContain("'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01'");
    expect(out).not.toContain('originPath');
  });
});

describe('Network.CDN — accountTier free (Front Door proibido em Free Trial)', () => {
  test('free + bucket SEM websiteHosting: NÃO emite recursos Microsoft.Cdn; Url sai do endpoint blob cru (sem container decorativo)', () => {
    const stack = new Stack('site');
    new Storage.Bucket(stack, 'AppBucket', {});
    new Network.CDN(stack, 'AppCDN', { defaultRootObject: 'index.html', origins: [{ id: 'o', domainName: '', bucketRef: 'AppBucket' }] });
    const bicep = emitBicep(stack, { accountTier: 'free' });
    expect(bicep).not.toContain('Standard_AzureFrontDoor');
    expect(bicep).not.toContain('Microsoft.Cdn/');
    expect(bicep).toContain('output AppCDNUrl string = appBucket.properties.primaryEndpoints.blob');
    expect(bicep).toContain('allowBlobPublicAccess: true');
    // sem container decorativo 'web'
    expect(bicep).not.toContain("'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01'");
  });

  test('free + bucket COM websiteHosting: Url sai do endpoint de static website (primaryEndpoints.web)', () => {
    const stack = new Stack('site');
    new Storage.Bucket(stack, 'AppBucket', { websiteHosting: true });
    new Network.CDN(stack, 'AppCDN', { defaultRootObject: 'index.html', origins: [{ id: 'o', domainName: '', bucketRef: 'AppBucket' }] });
    const bicep = emitBicep(stack, { accountTier: 'free' });
    expect(bicep).not.toContain('Microsoft.Cdn/');
    expect(bicep).toContain('output AppCDNUrl string = appBucket.properties.primaryEndpoints.web');
    expect(bicep).toContain('allowBlobPublicAccess: true');
    expect(bicep).not.toContain("'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01'");
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

  test('Cache.Redis por tier: mesmo SKU Balanced_B0, highAvailability varia (free → Disabled, standard → Enabled)', () => {
    const stack = new Stack('c');
    new Cache.Redis(stack, 'AppCache', { nodeType: 'small' });
    // Azure Managed Redis não tem tier grátis — Balanced_B0 é o menor SKU em
    // ambos os tiers; a diferença de custo/SLA vira highAvailability (réplica).
    const free = emitBicep(stack, { accountTier: 'free' });
    expect(free).toContain("name: 'Balanced_B0'");
    expect(free).toContain("highAvailability: 'Disabled'");
    const std = emitBicep(stack, { accountTier: 'standard' });
    expect(std).toContain("name: 'Balanced_B0'");
    expect(std).toContain("highAvailability: 'Enabled'");
  });

  test('Database.DynamoDB → Cosmos MongoDB API sem enableFreeTier (evita conflito de conta grátis)', () => {
    const stack = new Stack('t');
    new Database.DynamoDB(stack, 'ItemsTable', { partitionKey: 'id', partitionKeyType: 'S' } as any);
    const free = emitBicep(stack, { accountTier: 'free' });
    // deploy-validado p02az: Cosmos MongoDB API sobe sem enableFreeTier. O flag só
    // permite 1 conta grátis por subscription — omitir evita colisão em projetos com 2 Cosmos.
    expect(free).toContain("kind: 'MongoDB'");
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
    // webhook URL referencia o hostname da Function App (mesmo stack — referência direta)
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

describe('Monitoring.Alarm — alvo Function App (Consumption) cross-stack (gap 18)', () => {
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
    // namespace e métrica REAIS do Function App em Consumption (App Service
    // clássico — não Container Apps / Requests)
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

describe('validateAzureResources — rede de segurança offline (o que az validate não pega)', () => {
  const { validateAzureResources } = require('../src') as typeof import('../src');

  const alert = (crit: Record<string, unknown>) => [{
    sym: 'a', type: 'Microsoft.Insights/metricAlerts', apiVersion: '2018-03-01',
    properties: { criteria: { allOf: [{ name: 'c1', ...crit }] } },
  }] as never;

  test('métrica inexistente no namespace Function App → erro', () => {
    const errs = validateAzureResources(alert({ metricName: 'OnDemandFunctionExecutionCount', metricNamespace: 'Microsoft.Web/sites', timeAggregation: 'Total', operator: 'GreaterThan' }));
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/OnDemandFunctionExecutionCount.*não existe/);
  });

  test('métrica REAL do App Service (Consumption) → ok', () => {
    const errs = validateAzureResources(alert({ metricName: 'Http5xx', metricNamespace: 'Microsoft.Web/sites', timeAggregation: 'Total', operator: 'GreaterThanOrEqual' }));
    expect(errs).toEqual([]);
  });

  test('timeAggregation Sum (CloudWatch) → erro (Azure quer Total)', () => {
    const errs = validateAzureResources(alert({ metricName: 'Requests', metricNamespace: 'Microsoft.App/containerApps', timeAggregation: 'Sum', operator: 'GreaterThan' }));
    expect(errs.some(e => /Sum.*inválido/.test(e))).toBe(true);
  });

  test('operator inválido → erro', () => {
    const errs = validateAzureResources(alert({ metricName: 'Requests', metricNamespace: 'Microsoft.App/containerApps', timeAggregation: 'Total', operator: 'GreaterThanThreshold' }));
    expect(errs.some(e => /operator.*inválido/.test(e))).toBe(true);
  });

  test('namespace desconhecido → não valida métrica (confia no synth)', () => {
    const errs = validateAzureResources(alert({ metricName: 'QualquerCoisa', metricNamespace: 'Microsoft.Storage/storageAccounts', timeAggregation: 'Average', operator: 'GreaterThan' }));
    expect(errs).toEqual([]);
  });

  test('recursos sem metricAlert → sem erros', () => {
    expect(validateAzureResources([{ sym: 's', type: 'Microsoft.Web/sites', apiVersion: '2023-12-01', properties: {} }] as never)).toEqual([]);
  });

  test('emitBicep LANÇA se um alarme sair com métrica inválida (rede de segurança de ponta a ponta)', () => {
    // força um Custom.Resource com métrica inexistente — o synth normal já gera
    // válido, mas isto prova que a validação barra em synth-time se algo escapar.
    const s = new Stack('mon');
    (s as any).addConstruct({ id: 'BadAlarm', type: 'Custom.Resource', props: { arm: {
      type: 'Microsoft.Insights/metricAlerts', apiVersion: '2018-03-01',
      properties: { criteria: { allOf: [{ name: 'c1', metricName: 'OnDemandFunctionExecutionCount', metricNamespace: 'Microsoft.Web/sites', timeAggregation: 'Total', operator: 'GreaterThan' }] } },
    } } });
    expect(() => emitBicep(s, { accountTier: 'free', allStacks: [s] })).toThrow(/OnDemandFunctionExecutionCount.*não existe|Validação Azure/);
  });
});

describe('estimateNameLength — resolve comprimento offline (uniqueString = 13 chars)', () => {
  const { estimateNameLength, validateAzureResources } = require('../src') as typeof import('../src');
  const { expr } = require('../src/synth/constructs/shared') as typeof import('../src/synth/constructs/shared');

  test('literal simples → conta os chars', () => {
    expect(estimateNameLength('flagstable')).toBe(10);
  });

  test('expr com uniqueString → substitui por 13 chars', () => {
    // 'fn-' (3) + 13 = 16
    expect(estimateNameLength(expr(`'fn-\${uniqueString(resourceGroup().id)}'`))).toBe(16);
  });

  test('expr com interpolação não-resolvível → null (não arrisca falso-positivo)', () => {
    expect(estimateNameLength(expr(`'\${location}-x'`))).toBeNull();
  });

  test('expr que não é string-interpolada → null', () => {
    expect(estimateNameLength(expr('resourceGroup().location'))).toBeNull();
  });
});

describe('validateResourceName — comprimento máximo por tipo (name too long no deploy)', () => {
  const { validateAzureResources } = require('../src') as typeof import('../src');
  const { expr } = require('../src/synth/constructs/shared') as typeof import('../src/synth/constructs/shared');

  const res = (type: string, name: unknown) => [{ sym: 'r', type, apiVersion: '2023-04-15', name, properties: {} }] as never;

  test('Cosmos com id longo (sem slice) estoura 44 chars → erro', () => {
    // id de 32 chars + '-' + 13 (uniqueString) = 46 > 44
    const longId = 'featureflagsleaderboarddatastore'; // 32 chars
    const errs = validateAzureResources(res('Microsoft.DocumentDB/databaseAccounts', expr(`'${longId}-\${uniqueString(resourceGroup().id)}'`)));
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/Cosmos DB account.*46 chars.*máx 44/);
  });

  test('Cosmos com id curto → ok', () => {
    const errs = validateAzureResources(res('Microsoft.DocumentDB/databaseAccounts', expr(`'flags-\${uniqueString(resourceGroup().id)}'`)));
    expect(errs).toEqual([]);
  });

  test('Storage account > 24 chars → erro', () => {
    const errs = validateAzureResources(res('Microsoft.Storage/storageAccounts', 'a'.repeat(25)));
    expect(errs.some(e => /Storage account.*máx 24/.test(e))).toBe(true);
  });

  test('tipo sem regra de nome → não valida', () => {
    const errs = validateAzureResources(res('Microsoft.Web/sites', 'a'.repeat(80)));
    expect(errs).toEqual([]);
  });

  test('nome não-estimável (interpolação dinâmica) → não acusa', () => {
    const errs = validateAzureResources(res('Microsoft.DocumentDB/databaseAccounts', expr(`'\${someParam}'`)));
    expect(errs).toEqual([]);
  });
});

describe('Storage.Bucket replication geo — RA-GRS (bucket de DR idiomático)', () => {
  test("replication: 'geo' → sku Standard_RAGRS + output SecondaryEndpoint", () => {
    const s = new Stack('st');
    (s as any).addConstruct({ id: 'SiteBucket', type: 'Storage.Bucket', props: { replication: 'geo' } });
    const bicep = emitBicep(s, { accountTier: 'free', allStacks: [s] });
    expect(bicep).toContain("name: 'Standard_RAGRS'");
    expect(bicep).toMatch(/output SiteBucketSecondaryEndpoint string = siteBucket\.properties\.secondaryEndpoints\.blob/);
  });

  test('sem replication → Standard_LRS e sem endpoint secundário', () => {
    const s = new Stack('st');
    (s as any).addConstruct({ id: 'SiteBucket', type: 'Storage.Bucket', props: {} });
    const bicep = emitBicep(s, { accountTier: 'free', allStacks: [s] });
    expect(bicep).toContain("name: 'Standard_LRS'");
    expect(bicep).not.toContain('SecondaryEndpoint');
  });
});

describe('VNet integration — Database.SQL (postgres) + Compute.Container com subnetIds', () => {
  // Cenário OBRIGATÓRIO da bateria: stacks separadas por domínio (network vs.
  // database vs. compute) — reproduz o bug real de corrida no ARM (p09) e a
  // exigência de delegation do Container Apps Environment (p07, deploy real).
  function buildMultiStack() {
    const netStack = new Stack('notes-vnet-stack');
    new Network.VPC(netStack, 'AppVpc', { cidr: '10.0.0.0/16' });
    new Network.Subnet(netStack, 'DbSubnet', { vpcId: 'AppVpc', cidr: '10.0.1.0/28', public: false });
    new Network.Subnet(netStack, 'ContainerSubnet', { vpcId: 'AppVpc', cidr: '10.0.2.0/23', public: false });

    const dbStack = new Stack('notes-db-stack');
    new Database.SQL(dbStack, 'AppDb', { engine: 'postgres', storageGb: 32, subnetIds: ['DbSubnet'] });

    const compStack = new Stack('notes-api-stack');
    new Compute.Container(compStack, 'ApiApp', {
      image: 'node:20-alpine',
      port: 3000,
      environment: { DB_HOST: ref('AppDb', 'Endpoint') },
      subnetIds: ['ContainerSubnet'],
    });

    return { netStack, dbStack, compStack, all: [netStack, dbStack, compStack] };
  }

  test('cross-stack: rede emite as DUAS delegations (Postgres exclusiva + Container Apps)', () => {
    const { netStack, all } = buildMultiStack();
    const net = emitBicep(netStack, { accountTier: 'free', allStacks: all });
    // Postgres: subnet delegada exclusivamente a Microsoft.DBforPostgreSQL/flexibleServers
    expect(net).toMatch(/name: 'DbSubnet'[\s\S]*?serviceName: 'Microsoft\.DBforPostgreSQL\/flexibleServers'/);
    // Container Apps: validado em deploy real (2026-07-22) que o ARM EXIGE a
    // delegation mesmo em Consumption-only (ManagedEnvironmentSubnetDelegationError
    // sem ela) — a doc pública que diz o contrário está desatualizada.
    expect(net).toMatch(/name: 'ContainerSubnet'[\s\S]*?serviceName: 'Microsoft\.App\/environments'/);
  });

  test('cross-stack: rede exporta VpcId/SubnetId (output) só porque há consumidor em outra stack', () => {
    const { netStack, all } = buildMultiStack();
    const net = emitBicep(netStack, { accountTier: 'free', allStacks: all });
    expect(net).toContain('output AppVpcVpcId string = appVpc.id');
    expect(net).toContain("output DbSubnetSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', appVpc.name, 'DbSubnet')");
    expect(net).toContain("output ContainerSubnetSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', appVpc.name, 'ContainerSubnet')");
  });

  test('cross-stack: database-stack recebe DbSubnetSubnetId/AppVpcVpcId como param HARD (sem default) — cria o dependsOn de módulo', () => {
    const { dbStack, all } = buildMultiStack();
    const db = emitBicep(dbStack, { accountTier: 'free', allStacks: all });
    // Param HARD (sem "="): é o que o generateAzureMainBicep (synth-out.ts) casa
    // com o output homônimo da stack de rede, criando o dependsOn implícito entre
    // módulos — nunca embutir o resourceId literal aqui (bug real de bateria p09).
    expect(db).toMatch(/^param DbSubnetSubnetId string\s*$/m);
    expect(db).toMatch(/^param AppVpcVpcId string\s*$/m);
    expect(db).not.toMatch(/resourceId\('Microsoft\.Network\/virtualNetworks\/subnets',\s*'AppVpc'/);
    expect(db).toContain('delegatedSubnetResourceId: DbSubnetSubnetId');
    expect(db).toContain('virtualNetwork: {\n      id: AppVpcVpcId\n    }');
    // sem subnet delegada → nenhuma firewall rule pública
    expect(db).not.toContain('flexibleServers/firewallRules');
  });

  test('cross-stack: compute-stack recebe ContainerSubnetSubnetId como param HARD e cria env dedicado (não o sharedContainerEnv)', () => {
    const { compStack, all } = buildMultiStack();
    const comp = emitBicep(compStack, { accountTier: 'free', allStacks: all });
    expect(comp).toMatch(/^param ContainerSubnetSubnetId string\s*$/m);
    expect(comp).toContain('infrastructureSubnetId: ContainerSubnetSubnetId');
    expect(comp).not.toContain('sharedContainerEnv');
    expect(comp).not.toContain("param sharedCaeId");
  });

  test('same-stack: usa referência simbólica direta (sem param cross-stack)', () => {
    const s = new Stack('one-stack');
    new Network.VPC(s, 'Vpc1', { cidr: '10.0.0.0/16' });
    new Network.Subnet(s, 'DbSub', { vpcId: 'Vpc1', cidr: '10.0.1.0/28' });
    new Network.Subnet(s, 'CompSub', { vpcId: 'Vpc1', cidr: '10.0.2.0/23' });
    new Database.SQL(s, 'Db1', { engine: 'postgres', subnetIds: ['DbSub'] });
    new Compute.Container(s, 'App1', { image: 'x', subnetIds: ['CompSub'] });

    // Sem `allStacks`: fragmento isolado, não passa por prepareStacksForSynth
    // (que agora também acusa monolito de 3+ camadas — regra nova e correta,
    // mas ortogonal ao que este teste verifica: a resolução same-stack do
    // subnetId/vpcId em si).
    const out = emitBicep(s, { accountTier: 'free' });
    expect(out).not.toMatch(/^param \w*SubnetId string\s*$/m);
    expect(out).toContain("resourceId('Microsoft.Network/virtualNetworks/subnets', vpc1.name, 'DbSub')");
    expect(out).toContain("resourceId('Microsoft.Network/virtualNetworks/subnets', vpc1.name, 'CompSub')");
    expect(out).toMatch(/serviceName: 'Microsoft\.DBforPostgreSQL\/flexibleServers'/);
    expect(out).toMatch(/serviceName: 'Microsoft\.App\/environments'/);
  });

  test('subnet compartilhada entre Database.SQL (postgres) e Compute.Container → erro alto (duas delegations exclusivas conflitam)', () => {
    const net = new Stack('net');
    new Network.VPC(net, 'Vpc1', { cidr: '10.0.0.0/16' });
    new Network.Subnet(net, 'SharedSubnet', { vpcId: 'Vpc1', cidr: '10.0.1.0/24' });
    const db = new Stack('db');
    new Database.SQL(db, 'Db1', { engine: 'postgres', subnetIds: ['SharedSubnet'] });
    const comp = new Stack('comp');
    new Compute.Container(comp, 'App1', { image: 'x', subnetIds: ['SharedSubnet'] });
    const all = [net, db, comp];
    expect(() => emitBicep(net, { accountTier: 'free', allStacks: all })).toThrow(/só aceita UMA delegation/);
  });

  test('engine != postgres com subnetIds → erro alto (fim do silêncio)', () => {
    const net = new Stack('net2');
    new Network.VPC(net, 'Vpc2', { cidr: '10.0.0.0/16' });
    new Network.Subnet(net, 'Sub2', { vpcId: 'Vpc2', cidr: '10.0.1.0/28' });
    const db = new Stack('db2');
    new Database.SQL(db, 'Db2', { engine: 'mysql', subnetIds: ['Sub2'] });
    const all = [net, db];
    expect(() => emitBicep(db, { accountTier: 'free', allStacks: all })).toThrow(/subnetIds só é suportado no provider Azure para engine 'postgres'/);
  });

  test('securityGroupIds em Database.SQL ou Compute.Container → erro alto (fim do silêncio)', () => {
    const net = new Stack('net3');
    new Network.VPC(net, 'Vpc3', { cidr: '10.0.0.0/16' });
    new Network.Subnet(net, 'Sub3', { vpcId: 'Vpc3', cidr: '10.0.1.0/28' });
    const db = new Stack('db3');
    new Database.SQL(db, 'Db3', { engine: 'postgres', subnetIds: ['Sub3'], securityGroupIds: ['sg-x'] });
    expect(() => emitBicep(db, { accountTier: 'free', allStacks: [net, db] })).toThrow(/securityGroupIds ainda não é suportado/);

    const net4 = new Stack('net4');
    new Network.VPC(net4, 'Vpc4', { cidr: '10.0.0.0/16' });
    new Network.Subnet(net4, 'Sub4', { vpcId: 'Vpc4', cidr: '10.0.1.0/23' });
    const comp4 = new Stack('comp4');
    new Compute.Container(comp4, 'App4', { image: 'x', subnetIds: ['Sub4'], securityGroupIds: ['sg-y'] });
    expect(() => emitBicep(comp4, { accountTier: 'free', allStacks: [net4, comp4] })).toThrow(/securityGroupIds ainda não é suportado/);
  });

  test('subnet menor que o mínimo exigido → erro alto (Postgres /28, Container Apps /23)', () => {
    const net5 = new Stack('net5');
    new Network.VPC(net5, 'Vpc5', { cidr: '10.0.0.0/16' });
    new Network.Subnet(net5, 'Sub5', { vpcId: 'Vpc5', cidr: '10.0.1.0/29' });
    const db5 = new Stack('db5');
    new Database.SQL(db5, 'Db5', { engine: 'postgres', subnetIds: ['Sub5'] });
    expect(() => emitBicep(db5, { accountTier: 'free', allStacks: [net5, db5] })).toThrow(/menor que \/28/);

    const net6 = new Stack('net6');
    new Network.VPC(net6, 'Vpc6', { cidr: '10.0.0.0/16' });
    new Network.Subnet(net6, 'Sub6', { vpcId: 'Vpc6', cidr: '10.0.1.0/24' });
    const comp6 = new Stack('comp6');
    new Compute.Container(comp6, 'App6', { image: 'x', subnetIds: ['Sub6'] });
    expect(() => emitBicep(comp6, { accountTier: 'free', allStacks: [net6, comp6] })).toThrow(/menor que \/23/);
  });

  test('dois Compute.Container na mesma subnet → compartilham 1 único managedEnvironment dedicado', () => {
    const net = new Stack('net7');
    new Network.VPC(net, 'Vpc7', { cidr: '10.0.0.0/16' });
    new Network.Subnet(net, 'Sub7', { vpcId: 'Vpc7', cidr: '10.0.1.0/23' });
    const comp = new Stack('comp7');
    new Compute.Container(comp, 'AppA', { image: 'x', subnetIds: ['Sub7'] });
    new Compute.Container(comp, 'AppB', { image: 'x', subnetIds: ['Sub7'] });
    const out = emitBicep(comp, { accountTier: 'free', allStacks: [net, comp] });
    const envCount = (out.match(/Microsoft\.App\/managedEnvironments@/g) || []).length;
    expect(envCount).toBe(1);
  });
});
