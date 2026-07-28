/**
 * Golden template tests — compara o output do synthesizer com JSONs commitados.
 *
 * Para regenerar os goldens (após mudança intencional no synth):
 *   UPDATE_GOLDEN=1 npm test --workspace=packages/providers/aws
 *
 * Em modo UPDATE_GOLDEN o teste reescreve o arquivo e passa.
 * Sem UPDATE_GOLDEN o teste compara deep-equal e falha se houver diferença.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Stack,
  Compute,
  Storage,
  Network,
  Database,
  Fn,
  Cache,
  Messaging,
  Policy,
  Workflow,
  Monitoring,
} from '@iacmp/core';
import { AWSProvider } from '../src';

const GOLDEN_DIR = path.join(__dirname, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** Compara (ou escreve) um golden template de uma ou mais stacks.
 *  `actual` pode ser um único template ou um Record<stackName, template>. */
function assertGolden(name: string, actual: unknown): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const serialized = JSON.stringify(actual, null, 2);
  if (UPDATE) {
    fs.writeFileSync(file, serialized + '\n', 'utf-8');
    return;
  }
  const expected = JSON.parse(fs.readFileSync(file, 'utf-8'));
  expect(actual).toEqual(expected);
}

describe('Golden templates', () => {
  const provider = new AWSProvider();

  // ── 1. ecs-alb ───────────────────────────────────────────────────────────
  test('ecs-alb', () => {
    const stack = new Stack('ecs-alb', { region: 'us-east-1' });

    new Network.VPC(stack, 'AppVpc', { cidr: '10.0.0.0/16' });
    new Network.Subnet(stack, 'PublicSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', public: true });
    new Network.Subnet(stack, 'PublicSubnet2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', public: true });
    new Network.SecurityGroup(stack, 'AlbSg', {
      vpcId: 'AppVpc',
      description: 'ALB security group',
      ingressRules: [{ protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '0.0.0.0/0' }],
    });
    new Network.SecurityGroup(stack, 'AppSg', {
      vpcId: 'AppVpc',
      description: 'App security group',
      ingressRules: [{ protocol: 'tcp', fromPort: 8080, toPort: 8080, sourceSecurityGroupId: 'AlbSg' }],
    });
    new Network.LoadBalancer(stack, 'Alb', {
      vpcId: 'AppVpc',
      subnetIds: ['PublicSubnet1', 'PublicSubnet2'],
      securityGroupIds: ['AlbSg'],
      targetGroups: [{ name: 'app-tg', port: 8080, protocol: 'HTTP', healthCheckPath: '/health' }],
      listeners: [{ port: 80, protocol: 'HTTP' }],
    });
    new Compute.Container(stack, 'App', {
      image: 'nginx:latest',
      subnetIds: ['PublicSubnet1', 'PublicSubnet2'],
      securityGroupIds: ['AppSg'],
      targetGroupArn: 'Alb',
      minCapacity: 1,
      maxCapacity: 4,
    });

    const tpl = provider.synthesize(stack);
    assertGolden('ecs-alb', tpl);
  });

  // ── 2. lambda-vpc-redis ──────────────────────────────────────────────────
  // Dividido em 3 stacks para respeitar a separação por camada (máx 2 camadas/stack):
  //   lvr-shared: network only  |  lvr-services: cache+database  |  lvr-api: compute only
  test('lambda-vpc-redis', () => {
    const networkStack = new Stack('lvr-shared', { region: 'us-east-1' });
    new Network.VPC(networkStack, 'AppVpc', { cidr: '10.0.0.0/16' });
    new Network.Subnet(networkStack, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', public: false });
    new Network.Subnet(networkStack, 'PrivateSubnet2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', public: false });
    new Network.SecurityGroup(networkStack, 'LambdaSg', { vpcId: 'AppVpc', description: 'lambda' });
    new Network.SecurityGroup(networkStack, 'RedisSg', {
      vpcId: 'AppVpc',
      description: 'redis',
      ingressRules: [{ protocol: 'tcp', fromPort: 6379, toPort: 6379, sourceSecurityGroupId: 'LambdaSg' }],
    });
    new Network.VpcEndpoint(networkStack, 'DynamoGw', {
      vpcId: 'AppVpc',
      services: ['dynamodb'],
      subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],
    });

    const servicesStack = new Stack('lvr-services', { region: 'us-east-1' });
    new Cache.Redis(servicesStack, 'Cache', {
      nodeType: 'small',
      subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],
    });
    new Database.DynamoDB(servicesStack, 'Sessions', { partitionKey: 'sessionId' });

    const computeStack = new Stack('lvr-api', { region: 'us-east-1' });
    new Fn.Lambda(computeStack, 'ApiHandler', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: 'dist/',
      vpcId: 'AppVpc',
      subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],
      securityGroupIds: ['LambdaSg'],
      environment: {
        REDIS_HOST: 'Cache.Endpoint',
        REDIS_PORT: 'Cache.Port',
        TABLE_NAME: 'Sessions.name',
      },
    });

    const allStacks = [networkStack, servicesStack, computeStack];
    assertGolden('lambda-vpc-redis', {
      'lvr-shared': provider.synthesize(networkStack, allStacks),
      'lvr-services': provider.synthesize(servicesStack, allStacks),
      'lvr-api': provider.synthesize(computeStack, allStacks),
    });
  });

  // ── 3. s3-lambda-pipeline ─────────────────────────────────────────────────
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

    const tpl = provider.synthesize(stack);
    assertGolden('s3-lambda-pipeline', tpl);
  });

  // ── 4. stepfunctions-approval ─────────────────────────────────────────────
  test('stepfunctions-approval', () => {
    const stack = new Stack('stepfunctions-approval', { region: 'us-east-1' });

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

    const tpl = provider.synthesize(stack);
    assertGolden('stepfunctions-approval', tpl);
  });

  // ── 5. waf-rest-api ───────────────────────────────────────────────────────
  test('waf-rest-api', () => {
    const stack = new Stack('waf-rest-api', { region: 'us-east-1' });

    new Network.WAF(stack, 'ApiWaf', {
      scope: 'REGIONAL',
      rules: [
        { name: 'RateLimit', rateLimit: 1000 },
        { name: 'CommonRules', managedGroup: 'AWSManagedRulesCommonRuleSet' },
      ],
    });
    new Fn.Lambda(stack, 'ApiHandler', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: 'dist/',
    });
    new Fn.ApiGateway(stack, 'RestApi', {
      name: 'waf-api',
      type: 'REST',
      stageName: 'prod',
      wafAclId: 'ApiWaf',
      routes: [
        { method: 'GET', path: '/items', lambdaId: 'ApiHandler' },
        { method: 'POST', path: '/items', lambdaId: 'ApiHandler' },
      ],
    });

    const tpl = provider.synthesize(stack);
    assertGolden('waf-rest-api', tpl);
  });

  // ── 6. websocket-api ──────────────────────────────────────────────────────
  // Dividido em 2 stacks (database | compute+network) para respeitar max 2 camadas.
  test('websocket-api', () => {
    const dataStack = new Stack('ws-data', { region: 'us-east-1' });
    new Database.DynamoDB(dataStack, 'Connections', {
      partitionKey: 'connectionId',
      partitionKeyType: 'S',
    });

    const apiStack = new Stack('ws-api', { region: 'us-east-1' });
    new Fn.Lambda(apiStack, 'ConnectFn', {
      runtime: 'nodejs20',
      handler: 'connect.handler',
      code: 'dist/',
      environment: { TABLE_NAME: 'Connections.name' },
    });
    new Fn.Lambda(apiStack, 'DisconnectFn', {
      runtime: 'nodejs20',
      handler: 'disconnect.handler',
      code: 'dist/',
      environment: { TABLE_NAME: 'Connections.name' },
    });
    new Fn.Lambda(apiStack, 'DefaultFn', {
      runtime: 'nodejs20',
      handler: 'default.handler',
      code: 'dist/',
      environment: { TABLE_NAME: 'Connections.name' },
    });
    // Para WEBSOCKET o RouteKey vem de `path`; `method` é ignorado pelo synth
    // mas exigido pelo tipo — cast necessário pois o tipo não inclui $connect/$default
    new Fn.ApiGateway(apiStack, 'WsApi', {
      name: 'websocket-api',
      type: 'WEBSOCKET',
      routes: [
        { method: 'ANY' as any, path: '$connect', lambdaId: 'ConnectFn' },
        { method: 'ANY' as any, path: '$disconnect', lambdaId: 'DisconnectFn' },
        { method: 'ANY' as any, path: '$default', lambdaId: 'DefaultFn' },
      ],
    });

    const allStacks = [dataStack, apiStack];
    assertGolden('websocket-api', {
      'ws-data': provider.synthesize(dataStack, allStacks),
      'ws-api': provider.synthesize(apiStack, allStacks),
    });
  });

  // ── 7. kinesis-stream ─────────────────────────────────────────────────────
  test('kinesis-stream', () => {
    const stack = new Stack('kinesis-stream', { region: 'us-east-1' });

    new Messaging.Stream(stack, 'EventStream', { shards: 1, retentionHours: 24 });
    new Fn.Lambda(stack, 'ProducerFn', {
      runtime: 'nodejs20',
      handler: 'producer.handler',
      code: 'dist/',
      environment: { STREAM_NAME: 'EventStream.name' },
    });
    new Policy.IAM(stack, 'ProducerPolicy', {
      attachTo: 'ProducerFn',
      attachType: 'lambda',
      statements: [
        {
          effect: 'Allow',
          actions: ['kinesis:PutRecord', 'kinesis:PutRecords'],
          resources: ['EventStream.Arn'],
        },
      ],
    });
    new Fn.Lambda(stack, 'ConsumerFn', {
      runtime: 'nodejs20',
      handler: 'consumer.handler',
      code: 'dist/',
      eventSources: [{ streamId: 'EventStream', batchSize: 100, startingPosition: 'TRIM_HORIZON' }],
    });

    const tpl = provider.synthesize(stack);
    assertGolden('kinesis-stream', tpl);
  });

  // ── 8. rds-secret ─────────────────────────────────────────────────────────
  // Dividido em 3 stacks (network | database | compute) para respeitar max 2 camadas.
  test('rds-secret', () => {
    const networkStack = new Stack('rs-infra', { region: 'us-east-1' });
    new Network.VPC(networkStack, 'AppVpc', { cidr: '10.0.0.0/16' });
    new Network.Subnet(networkStack, 'DbSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', public: false });
    new Network.Subnet(networkStack, 'DbSubnet2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', public: false });
    new Network.Subnet(networkStack, 'LambdaSubnet1', { vpcId: 'AppVpc', cidr: '10.0.3.0/24', public: false });
    new Network.SecurityGroup(networkStack, 'DbSg', { vpcId: 'AppVpc', description: 'db' });
    new Network.SecurityGroup(networkStack, 'LambdaSg', { vpcId: 'AppVpc', description: 'lambda' });

    const dbStack = new Stack('rs-db', { region: 'us-east-1' });
    new Database.SQL(dbStack, 'AppDB', {
      engine: 'postgres',
      subnetIds: ['DbSubnet1', 'DbSubnet2'],
      securityGroupIds: ['DbSg'],
    });

    const computeStack = new Stack('rs-compute', { region: 'us-east-1' });
    new Fn.Lambda(computeStack, 'MigrationFn', {
      runtime: 'nodejs20',
      handler: 'migrate.handler',
      code: 'dist/',
      vpcId: 'AppVpc',
      subnetIds: ['LambdaSubnet1'],
      securityGroupIds: ['LambdaSg'],
      environment: {
        DB_HOST: 'AppDB.Endpoint',
        DB_PORT: 'AppDB.Port',
        DB_PASSWORD: 'AppDB.Password',
      },
    });
    new Policy.IAM(computeStack, 'MigrationPolicy', {
      attachTo: 'MigrationFn',
      attachType: 'lambda',
      statements: [
        {
          effect: 'Allow',
          actions: ['secretsmanager:GetSecretValue'],
          resources: ['AppDB.SecretArn'],
        },
      ],
    });

    const allStacks = [networkStack, dbStack, computeStack];
    assertGolden('rds-secret', {
      'rs-infra': provider.synthesize(networkStack, allStacks),
      'rs-db': provider.synthesize(dbStack, allStacks),
      'rs-compute': provider.synthesize(computeStack, allStacks),
    });
  });

  // ── 9. sns-alarm ──────────────────────────────────────────────────────────
  test('sns-alarm', () => {
    const stack = new Stack('sns-alarm', { region: 'us-east-1' });

    new Fn.Lambda(stack, 'AlertHandler', {
      runtime: 'nodejs20',
      handler: 'alert.handler',
      code: 'dist/',
    });
    new Messaging.Topic(stack, 'AlertsTopic', {
      displayName: 'Alerts',
      subscriptions: [
        { protocol: 'lambda', endpoint: 'AlertHandler' },
      ],
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

    const tpl = provider.synthesize(stack);
    assertGolden('sns-alarm', tpl);
  });
});
