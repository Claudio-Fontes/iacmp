/**
 * Golden Terraform (.tf.json) tests — GCP.
 *
 * Compara o output do `emitGCPTerraform` (via GCPProvider) com JSONs commitados.
 * É a rede de regressão do provider GCP: enquanto o G1 (redistribuir o
 * gcp-terraform.ts em constructs/) for refactor puro, estes goldens devem ficar
 * byte-idênticos. Golden que muda é bug do trabalho (docs/roadmap-fase2.md §0).
 *
 * Os 2 cenários abaixo foram validados de ponta a ponta com `terraform validate`
 * (provider hashicorp/google) no Passo 0 (§2.2.1).
 *
 * Para regenerar após mudança INTENCIONAL no synth:
 *   UPDATE_GOLDEN=1 npm test --workspace=packages/providers/gcp -- --testPathPattern=golden-tf
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  Stack,
  Fn,
  Storage,
  Messaging,
  Monitoring,
  Compute,
  Database,
  Cache,
  Secret,
  Certificate,
  Network,
  Workflow,
  ref,
} from '@iacmp/core';
import { GCPProvider } from '../src';

const GOLDEN_DIR = path.join(__dirname, 'golden-tf');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

function assertGolden(name: string, actual: string): void {
  const file = path.join(GOLDEN_DIR, `${name}.tf.json`);
  if (UPDATE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, actual, 'utf-8');
    return;
  }
  const expected = fs.readFileSync(file, 'utf-8');
  expect(actual).toEqual(expected);
}

describe('Golden Terraform (.tf.json) — GCP', () => {
  const provider = new GCPProvider();

  // ── 1. s3-lambda-pipeline ──────────────────────────────────────────────────
  test('s3-lambda-pipeline', () => {
    const stack = new Stack('s3-lambda-pipeline', { region: 'us-east-1' });
    new Fn.Lambda(stack, 'ProcessFn', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: 'dist/',
      environment: { DEST_BUCKET: 'OutputBucket.name' },
    });
    new Storage.Bucket(stack, 'InputBucket', {
      versioning: true,
      eventNotifications: [{ lambdaId: 'ProcessFn', events: ['s3:ObjectCreated:*'] }],
    });
    new Storage.Bucket(stack, 'OutputBucket', { versioning: false });
    assertGolden('s3-lambda-pipeline', provider.synthesize(stack, [stack]));
  });

  // ── 2. sns-alarm ───────────────────────────────────────────────────────────
  test('sns-alarm', () => {
    const stack = new Stack('sns-alarm', { region: 'us-east-1' });
    new Fn.Lambda(stack, 'AlertHandler', {
      runtime: 'nodejs20',
      handler: 'alert.handler',
      code: 'dist/',
    });
    new Messaging.Topic(stack, 'AlertsTopic', {
      displayName: 'Alerts',
      subscriptions: [{ protocol: 'lambda', endpoint: 'AlertHandler' }],
    });
    new Monitoring.Alarm(stack, 'ErrorAlarm', {
      metricName: 'Errors',
      namespace: 'AWS/Lambda',
      threshold: 10,
      evaluationPeriods: 2,
      periodSeconds: 300,
      comparisonOperator: 'GreaterThanThreshold',
      treatMissingData: 'notBreaching',
      alarmActions: ['AlertsTopic.Arn'],
      dimensions: { FunctionName: 'AlertHandler' },
    });
    assertGolden('sns-alarm', provider.synthesize(stack, [stack]));
  });

  // ── 3. compute-suite ───────────────────────────────────────────────────────
  test('compute-suite', () => {
    const stack = new Stack('compute-suite', { region: 'us-east-1' });
    new Network.VPC(stack, 'AppVpc', {});
    new Network.Subnet(stack, 'PrivateSubnet1', {
      vpcId: 'AppVpc',
      cidr: '10.0.1.0/24',
      availabilityZone: 'us-east-1a',
    });
    new Network.Subnet(stack, 'PrivateSubnet2', {
      vpcId: 'AppVpc',
      cidr: '10.0.2.0/24',
      availabilityZone: 'us-east-1b',
    });
    new Compute.Instance(stack, 'WebServer', {
      instanceType: 'small',
      image: 'ubuntu-22.04',
    });
    new Compute.AutoScaling(stack, 'AppFleet', {
      instanceType: 'medium',
      image: 'ubuntu-22.04',
      minCapacity: 2,
      maxCapacity: 6,
      desiredCapacity: 2,
      targetCpuUtilization: 60,
    });
    new Compute.Container(stack, 'ApiService', {
      image: 'gcr.io/proj/api:latest',
      cpu: 512,
      memory: 1024,
      port: 8080,
      environment: { NODE_ENV: 'production' },
      desiredCount: 2,
      publicIp: true,
      subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],
    });
    new Compute.Kubernetes(stack, 'AppCluster', {
      nodeInstanceType: 'medium',
      desiredNodes: 3,
      privateCluster: true,
      subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],
    });
    assertGolden('compute-suite', provider.synthesize(stack, [stack]));
  });

  // ── 4. database-suite ──────────────────────────────────────────────────────
  // Nota: chama synthesize(stack) SEM allStacks — o validador semântico do core
  // bloqueia stacks com 3+ camadas-âncora (database + cache + security aqui) como
  // monolito (validate.ts §J). Isso é uma regra de arquitetura de stacks, não do
  // synth GCP; pular a validação aqui não muda o tf.json emitido (é determinístico),
  // só evita barrar este fixture propositalmente multi-domínio.
  test('database-suite', () => {
    const stack = new Stack('database-suite', { region: 'us-east-1' });
    new Database.SQL(stack, 'MainDb', {
      engine: 'postgres',
      instanceType: 'db-f1-micro',
      multiAz: true,
    });
    new Database.DynamoDB(stack, 'ItemsTable', {
      partitionKey: 'id',
    });
    new Database.DocumentDB(stack, 'DocsDb', {
      deletionProtection: true,
    });
    new Cache.Redis(stack, 'SessionCache', {
      nodeType: 'medium',
    });
    new Cache.Memcached(stack, 'ObjectCache', {
      numCacheNodes: 3,
    });
    new Secret.Vault(stack, 'DbCredentials', {
      description: 'MainDb credentials',
    });
    new Certificate.TLS(stack, 'ApiCert', {
      domainName: 'api.example.com',
      subjectAlternativeNames: ['www.example.com'],
    });
    assertGolden('database-suite', provider.synthesize(stack));
  });

  // ── 5. network-suite ───────────────────────────────────────────────────────
  test('network-suite', () => {
    const stack = new Stack('network-suite', { region: 'us-east-1' });
    new Network.VPC(stack, 'AppVpc', {});
    new Network.Subnet(stack, 'PublicSubnet1', {
      vpcId: 'AppVpc',
      cidr: '10.0.1.0/24',
      availabilityZone: 'us-east-1a',
      public: true,
    });
    new Network.Subnet(stack, 'PublicSubnet2', {
      vpcId: 'AppVpc',
      cidr: '10.0.2.0/24',
      availabilityZone: 'us-east-1b',
      public: true,
    });
    new Network.SecurityGroup(stack, 'AlbSg', {
      vpcId: 'AppVpc',
      description: 'ALB security group',
      ingressRules: [{ protocol: 'tcp', fromPort: 443, toPort: 443, cidr: '0.0.0.0/0' }],
    });
    new Network.LoadBalancer(stack, 'AppLb', {
      type: 'application',
      scheme: 'internet-facing',
      vpcId: 'AppVpc',
      subnetIds: ['PublicSubnet1', 'PublicSubnet2'],
      securityGroupIds: ['AlbSg'],
    });
    new Network.CDN(stack, 'AssetsCdn', {
      origins: [{ id: 'default', domainName: 'assets-bucket-name' }],
    });
    new Network.Dns(stack, 'AppZone', {
      zoneName: 'example.com',
      records: [{ name: 'example.com', type: 'A', values: ['1.2.3.4'] }],
    });
    new Network.WAF(stack, 'ApiWaf', {
      defaultAction: 'allow',
      rules: [
        { name: 'RateLimit', rateLimit: 100 },
        { name: 'CommonRules', managedGroup: 'AWSManagedRulesCommonRuleSet' },
      ],
    });
    assertGolden('network-suite', provider.synthesize(stack, [stack]));
  });

  // ── 6. workflow-suite ───────────────────────────────────────────────────────
  test('workflow-suite', () => {
    const stack = new Stack('workflow-suite', { region: 'us-east-1' });
    new Fn.Lambda(stack, 'NotifyFn', {
      runtime: 'nodejs20',
      handler: 'notify.handler',
      code: 'dist/',
    });
    new Fn.Lambda(stack, 'ActionFn', {
      runtime: 'nodejs20',
      handler: 'action.handler',
      code: 'dist/',
    });
    new Workflow.StepFunctions(stack, 'ApprovalFlow', {
      steps: [
        { name: 'RequestApproval', resource: 'NotifyFn', waitForToken: true },
        { name: 'WaitForApproval', type: 'Wait', seconds: 3600 },
        { name: 'ExecuteAction', resource: 'ActionFn' },
      ],
    });
    assertGolden('workflow-suite', provider.synthesize(stack, [stack]));
  });

  // ── 7. api-gateway-jwt ──────────────────────────────────────────────────────
  // Regressão do bug: `contents` do google_api_gateway_api_config precisa ser
  // uma EXPRESSÃO Terraform (`${base64encode(jsonencode({...}))}`) que resolve
  // `google_cloudfunctions2_function...service_config[0].uri` em tempo de apply
  // — não um base64 pré-computado em JS (que colapsa a ref numa string literal
  // e faz o API Gateway rejeitar o address como URL inválida). Cobre também
  // authType JWT no nível do gateway + rota pública (authType 'NONE' por rota) +
  // x-google-backend.path_translation (APPEND_PATH_TO_ADDRESS, senão o backend
  // recebe sempre o endereço-base, sem o path real) + `parameters` declarados
  // (in: path) pra rota com {id} — sem isso o API Gateway falha com "undefined
  // field 'id' on message 'google.protobuf.Empty'" (path template exige o
  // parâmetro declarado no swagger 2.0, `path_translation` sozinho não basta).
  test('api-gateway-jwt', () => {
    const stack = new Stack('api-gateway-jwt', { region: 'us-east-1' });
    new Fn.Lambda(stack, 'JwtAuthorizerFn', {
      runtime: 'nodejs20',
      handler: 'dist/jwtAuthorizer.handler',
      code: '.',
    });
    new Fn.Lambda(stack, 'GetProfileFn', {
      runtime: 'nodejs20',
      handler: 'dist/getProfile.handler',
      code: '.',
    });
    new Fn.Lambda(stack, 'PublicHealthFn', {
      runtime: 'nodejs20',
      handler: 'dist/publicHealth.handler',
      code: '.',
    });
    new Fn.ApiGateway(stack, 'ProfileApi', {
      name: 'profile-api',
      type: 'HTTP',
      cors: true,
      // JWT nativo do API Gateway do Google com issuer/JWKS REAIS. O contrato
      // antigo (authType: 'JWT' + authorizerLambdaId) gerava um esqueleto com
      // ISSUER_PLACEHOLDER: a API subia "protegida" sem validar nada — hoje o
      // synth falha nesse caso (auditoria P0-01, 2026-08-01).
      auth: {
        type: 'jwt',
        issuer: 'https://securetoken.google.com/meu-projeto',
        audiences: ['meu-projeto'],
        jwksUri: 'https://www.googleapis.com/service_accounts/v1/metadata/x509/securetoken@system.gserviceaccount.com',
      },
      routes: [
        { method: 'GET', path: '/profile', lambdaId: 'GetProfileFn' },
        { method: 'GET', path: '/profile/{id}', lambdaId: 'GetProfileFn' },
        { method: 'PUT', path: '/profile/{id}', lambdaId: 'GetProfileFn' },
        { method: 'DELETE', path: '/profile/{id}', lambdaId: 'GetProfileFn' },
        { method: 'GET', path: '/health', lambdaId: 'PublicHealthFn', auth: { type: 'none' } },
      ],
    });
    assertGolden('api-gateway-jwt', provider.synthesize(stack, [stack]));
  });

  // ── 8. database-sql-private-vpc ────────────────────────────────────────────
  // Cenário "DB privado em VPC": Database.SQL com vpcId → sem IP público
  // (ipv4_enabled:false), alcançável só via VPC (aqui, por uma Fn.Lambda com o
  // mesmo vpcId, através do Serverless VPC Access connector). Cobre:
  // - google_sql_database_instance.settings.ip_configuration (private_network,
  //   ipv4_enabled:false) + depends_on o service networking connection;
  // - google_compute_global_address (purpose VPC_PEERING) + google_service_
  //   networking_connection — emitidos por emitGCPProviders (escopo de VPC,
  //   não por-instância — ver buildPrivateServiceNetworkingResources);
  // - Endpoint/Host resolvendo para private_ip_address (não public_ip_address)
  //   nas env vars da function, via ref('PrivateDb', 'Endpoint'/'Port'/...).
  // Chama synthesize(stack) SEM allStacks pelo mesmo motivo do database-suite
  // acima (validate.ts §J bloqueia stacks com 3+ camadas-âncora misturadas —
  // aqui network+database+function propositalmente no mesmo fixture); isso não
  // muda o tf.json emitido (determinístico), só evita barrar o fixture.
  test('database-sql-private-vpc', () => {
    const stack = new Stack('database-sql-private-vpc', { region: 'us-east-1' });
    new Network.VPC(stack, 'AppVpc', {});
    // vpcId não está tipado em DatabaseSQLProps (core) — mesma situação de
    // CacheRedisProps (só subnetIds é tipado lá, mas o synth GCP de Cache.Redis
    // já lê props.vpcId direto, ver constructs/database.ts). `as any` aqui só
    // contorna o excess-property check de um objeto literal; em tempo de
    // execução props é sempre Record<string, unknown>. Fora do escopo desta
    // tarefa mexer em core — sinalizado ao coordenador separadamente.
    new Database.SQL(stack, 'PrivateDb', {
      engine: 'postgres',
      instanceType: 'db-f1-micro',
      vpcId: 'AppVpc',
    } as any);
    new Fn.Lambda(stack, 'WorkerFn', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: 'dist/',
      vpcId: 'AppVpc',
      environment: {
        DB_HOST: ref('PrivateDb', 'Endpoint'),
        DB_PORT: ref('PrivateDb', 'Port'),
        DB_USER: ref('PrivateDb', 'Username'),
        DB_PASSWORD: ref('PrivateDb', 'Password'),
      },
    });
    assertGolden('database-sql-private-vpc', provider.synthesize(stack));
  });

  // ── 9. container-build ─────────────────────────────────────────────────────
  test('container-build', () => {
    const stack = new Stack('container-build', { region: 'us-east-1' });
    new Compute.Container(stack, 'AppService', {
      cpu: 1000,
      memory: 512,
      port: 8080,
      publicIp: true,
      build: { context: '.', dockerfile: 'Dockerfile' },
    } as any);
    assertGolden('container-build', provider.synthesize(stack, [stack]));
  });

  // ── 10. storage-trigger ─────────────────────────────────────────────────────
  test('storage-trigger', () => {
    const stack = new Stack('storage-trigger', { region: 'us-east-1' });
    new Storage.Bucket(stack, 'UploadBucket', {});
    new Fn.Lambda(stack, 'ProcessFn', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: 'dist/',
      eventSources: [{ bucketId: 'UploadBucket' }],
    });
    assertGolden('storage-trigger', provider.synthesize(stack, [stack]));
  });

  // ── 11. websocket-cloudrun ──────────────────────────────────────────────────
  test('websocket-cloudrun', () => {
    const stack = new Stack('websocket-cloudrun', { region: 'us-east-1' });
    new Fn.Lambda(stack, 'ConnectFn', { runtime: 'nodejs20', handler: 'dist/connect.handler', code: '.' });
    new Fn.Lambda(stack, 'DisconnectFn', { runtime: 'nodejs20', handler: 'dist/disconnect.handler', code: '.' });
    new Fn.Lambda(stack, 'DefaultFn', { runtime: 'nodejs20', handler: 'dist/default.handler', code: '.' });
    new Fn.ApiGateway(stack, 'WsApi', {
      name: 'websocket-api',
      type: 'WEBSOCKET',
      routes: [
        { method: 'ANY', path: '$connect', lambdaId: 'ConnectFn' },
        { method: 'ANY', path: '$disconnect', lambdaId: 'DisconnectFn' },
        { method: 'ANY', path: '$default', lambdaId: 'DefaultFn' },
      ],
    });
    assertGolden('websocket-cloudrun', provider.synthesize(stack, [stack]));
  });
});
