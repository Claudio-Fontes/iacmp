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
});
