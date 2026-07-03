import { Stack, Database, Fn, Messaging, Secret, Storage, Monitoring, Policy, ref } from '@iacmp/core';
import { AWSProvider } from '../src';

const provider = new AWSProvider();

// ── 1. Getter same-stack: db.endpoint → GetAtt idêntico ao string equivalente ─

test('Ref getter same-stack (db.endpoint) produz mesmo GetAtt que string "AppDB.Endpoint"', () => {
  const mkStack = (useGetter: boolean) => {
    const s = new Stack('app-stack', { region: 'us-east-1' });
    const db = new Database.SQL(s, 'AppDB', { engine: 'postgres' });
    new Fn.Lambda(s, 'ApiFn', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: 'dist/',
      environment: {
        DB_HOST: useGetter ? db.endpoint : 'AppDB.Endpoint',
      },
    });
    return s;
  };

  const tplGetter = provider.synthesize(mkStack(true), [mkStack(true)]) as any;
  const tplString = provider.synthesize(mkStack(false), [mkStack(false)]) as any;

  const envGetter = tplGetter.Resources.ApiFn.Properties.Environment.Variables.DB_HOST;
  const envString = tplString.Resources.ApiFn.Properties.Environment.Variables.DB_HOST;

  expect(envGetter).toEqual(envString);
  expect(envGetter).toEqual({ 'Fn::GetAtt': ['AppDB', 'Endpoint.Address'] });
});

// ── 2. ref() cross-stack → ImportValue correto ────────────────────────────────

test('ref() cross-stack → Fn::ImportValue com sufixo correto', () => {
  const dbStack = new Stack('db-stack', { region: 'us-east-1' });
  new Database.SQL(dbStack, 'AppDB', { engine: 'postgres' });

  const lambdaStack = new Stack('lambda-stack', { region: 'us-east-1' });
  new Fn.Lambda(lambdaStack, 'ApiFn', {
    runtime: 'nodejs20',
    handler: 'index.handler',
    code: 'dist/',
    environment: {
      DB_HOST: ref('AppDB', 'Endpoint'),
    },
  });

  const allStacks = [dbStack, lambdaStack];
  const tpl = provider.synthesize(lambdaStack, allStacks) as any;
  const dbHost = tpl.Resources.ApiFn.Properties.Environment.Variables.DB_HOST;

  expect(dbHost).toEqual({ 'Fn::ImportValue': 'db-stack-AppDB-Endpoint' });
});

// ── 3. Atributo inválido → erro claro citando atributos válidos ───────────────

test('ref() com atributo inválido lança erro com atributos válidos listados', () => {
  const s = new Stack('app-stack', { region: 'us-east-1' });
  new Database.SQL(s, 'AppDB', { engine: 'postgres' });
  new Fn.Lambda(s, 'ApiFn', {
    runtime: 'nodejs20',
    handler: 'index.handler',
    code: 'dist/',
    environment: {
      BROKEN: ref('AppDB', 'FooBar'),
    },
  });

  expect(() => provider.synthesize(s, [s])).toThrow('FooBar');
  expect(() => provider.synthesize(s, [s])).toThrow('Atributos válidos');
});

// ── 4. expectType violado: lambdaId apontando para Queue via Ref → erro claro ─

test('eventNotifications.lambdaId apontando para Queue via Ref lança erro de tipo', () => {
  const s = new Stack('app-stack', { region: 'us-east-1' });
  const queue = new Messaging.Queue(s, 'UploadQueue', {});
  new Storage.Bucket(s, 'Assets', {
    eventNotifications: [
      { lambdaId: queue.arn },
    ],
  });

  expect(() => provider.synthesize(s, [s])).toThrow('Fn.Lambda');
});

// ── 5. alarmActions getter → mesmo output que string equivalente ──────────────

test('alarmActions: [topic.arn] produz mesmo Ref que alarmActions: ["AlertsTopic"]', () => {
  const mkStack = (useGetter: boolean) => {
    const s = new Stack('app-stack', { region: 'us-east-1' });
    const topic = new Messaging.Topic(s, 'AlertsTopic', {});
    new Monitoring.Alarm(s, 'HighCpu', {
      metricName: 'CPUUtilization',
      threshold: 80,
      alarmActions: useGetter ? [topic.arn] : ['AlertsTopic'],
    });
    return s;
  };

  const tplGetter = provider.synthesize(mkStack(true), [mkStack(true)]) as any;
  const tplString = provider.synthesize(mkStack(false), [mkStack(false)]) as any;

  expect(tplGetter.Resources.HighCpu.Properties.AlarmActions)
    .toEqual(tplString.Resources.HighCpu.Properties.AlarmActions);
  expect(tplGetter.Resources.HighCpu.Properties.AlarmActions).toEqual([{ Ref: 'AlertsTopic' }]);
});

// ── 6. Policy resources getter → mesmo output que string equivalente ──────────

test('policy resources: [vault.secretArn] produz mesmo output que ["MyVault.SecretArn"]', () => {
  const mkStack = (useGetter: boolean) => {
    const s = new Stack('app-stack', { region: 'us-east-1' });
    const vault = new Secret.Vault(s, 'MyVault', {});
    new Fn.Lambda(s, 'ApiFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Policy.IAM(s, 'SecretPolicy', {
      attachTo: 'ApiFn',
      attachType: 'lambda',
      statements: [{
        effect: 'Allow',
        actions: ['secretsmanager:GetSecretValue'],
        resources: useGetter ? [vault.secretArn] : ['MyVault.SecretArn'],
      }],
    });
    return s;
  };

  const tplGetter = provider.synthesize(mkStack(true), [mkStack(true)]) as any;
  const tplString = provider.synthesize(mkStack(false), [mkStack(false)]) as any;

  const stmtsGetter = tplGetter.Resources.SecretPolicyRole.Properties.Policies[0].PolicyDocument.Statement;
  const stmtsString = tplString.Resources.SecretPolicyRole.Properties.Policies[0].PolicyDocument.Statement;

  expect(stmtsGetter[0].Resource).toEqual(stmtsString[0].Resource);
  expect(stmtsGetter[0].Resource).toEqual([{ Ref: 'MyVault' }]);
});

// ── 7. dlqArn via getter (caso p03e2e: dlq.arn crashava resolveQueueArn) ─────

test('Messaging.Queue com dlqArn via getter (dlq.arn) → RedrivePolicy com GetAtt', () => {
  const s = new Stack('task-queue', { region: 'us-east-1' });
  const dlq = new Messaging.Queue(s, 'TaskDLQ', {});
  new Messaging.Queue(s, 'TaskQueue', { dlqArn: dlq.arn, maxReceiveCount: 3 });

  const tpl = provider.synthesize(s, [s]) as any;
  const redrive = tpl.Resources.TaskQueue.Properties.RedrivePolicy;
  expect(redrive.deadLetterTargetArn).toEqual({ 'Fn::GetAtt': ['TaskDLQ', 'Arn'] });
  expect(redrive.maxReceiveCount).toBe(3);
});

test('vpcId/subnetIds/securityGroupIds aceitam Ref sem crashar (guards nos resolvers)', () => {
  const s = new Stack('net-stack', { region: 'us-east-1' });
  new Fn.Lambda(s, 'VpcFn', {
    runtime: 'nodejs20', handler: 'i.h', code: 'dist/',
    vpcId: ref('AppVpc', 'VpcId') as any,
    subnetIds: [ref('PrivateSubnet1', 'SubnetId') as any],
    securityGroupIds: [ref('LambdaSG', 'GroupId') as any],
  });
  // AppVpc/subnet/SG não existem no universo — resolveRef lança erro CLARO de
  // referência não encontrada (não TypeError de .startsWith em objeto).
  expect(() => provider.synthesize(s, [s])).toThrow(/não foi encontrada|not found|Referência/);
});
