import { Stack, Compute, Storage, Network, Database, Fn, Messaging, Cache } from '@iacmp/core';
import { GCPProvider } from '../src';

function synth(stack: Stack): Record<string, unknown> {
  return JSON.parse(new GCPProvider().synthesize(stack));
}

function resources(parsed: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return (parsed.resource ?? {}) as Record<string, Record<string, unknown>>;
}

describe('GCPProvider (Terraform google_*)', () => {
  test('output é JSON válido com bloco terraform', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'VM', { instanceType: 'small', image: 'ubuntu-22.04' });
    const out = synth(stack);
    expect((out.terraform as any).required_providers.google.source).toBe('hashicorp/google');
  });

  test('Compute.Instance → google_compute_instance com machine_type e image ubuntu', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'VM', { instanceType: 'small', image: 'ubuntu-22.04' });
    const r = resources(synth(stack));
    const vm: any = Object.values(r['google_compute_instance'])[0];
    expect(vm.machine_type).toBe('e2-small');
    expect((vm.boot_disk[0].initialize_params[0].image as string)).toContain('ubuntu');
  });

  test('Compute.Instance windows-2022 → image contém windows', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'WinVM', { instanceType: 'small', image: 'windows-2022' });
    const r = resources(synth(stack));
    const vm: any = Object.values(r['google_compute_instance'])[0];
    expect((vm.boot_disk[0].initialize_params[0].image as string)).toContain('windows');
  });

  test('Storage.Bucket → google_storage_bucket com versioning', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Bucket', { versioning: true });
    const r = resources(synth(stack));
    const bucket: any = Object.values(r['google_storage_bucket'])[0];
    expect(bucket.versioning[0].enabled).toBe(true);
  });

  test('Storage.Bucket → location padrão US', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'B', { versioning: false });
    const r = resources(synth(stack));
    const bucket: any = Object.values(r['google_storage_bucket'])[0];
    expect(bucket.location).toBe('US');
  });

  test('Storage.Bucket com lifecycle → lifecycle_rule gerada', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'B', {
      versioning: false,
      lifecycleRules: [{ transitionToGlacierDays: 30, expireAfterDays: 365 }],
    });
    const r = resources(synth(stack));
    const bucket: any = Object.values(r['google_storage_bucket'])[0];
    expect(bucket.lifecycle_rule.length).toBe(2);
    const archive = bucket.lifecycle_rule.find((x: any) => x.action[0]?.type === 'SetStorageClass');
    expect(archive).toBeDefined();
    expect(archive.condition[0].age).toBe(30);
  });

  test('Network.VPC → google_compute_network', () => {
    const stack = new Stack('test');
    new Network.VPC(stack, 'Rede', { cidr: '10.0.0.0/16' });
    const r = resources(synth(stack));
    expect(r['google_compute_network']).toBeDefined();
    const net: any = Object.values(r['google_compute_network'])[0];
    expect(net.auto_create_subnetworks).toBe(false);
  });

  test('Network.SecurityGroup sem CIDR → warn e usa 0.0.0.0/0', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const stack = new Stack('test');
    new Network.SecurityGroup(stack, 'SG', {
      vpcId: 'vpc-1',
      ingressRules: [{ protocol: 'tcp', fromPort: 22, toPort: 22 } as any],
    });
    const r = resources(synth(stack));
    const fw: any = Object.values(r['google_compute_firewall'] ?? {})[0];
    expect(fw?.source_ranges).toContain('0.0.0.0/0');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sem CIDR'));
    warnSpy.mockRestore();
  });

  test('Database.SQL mysql → google_sql_database_instance com MYSQL', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'MySQLDB', { engine: 'mysql' });
    const r = resources(synth(stack));
    const db: any = Object.values(r['google_sql_database_instance'])[0];
    expect(db.database_version).toContain('MYSQL');
  });

  test('Database.SQL postgres → POSTGRES', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'PgDB', { engine: 'postgres' });
    const r = resources(synth(stack));
    const db: any = Object.values(r['google_sql_database_instance'])[0];
    expect(db.database_version).toContain('POSTGRES');
  });

  test('Database.SQL sqlserver → SQLSERVER', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'SqlDB', { engine: 'sqlserver' });
    const r = resources(synth(stack));
    const db: any = Object.values(r['google_sql_database_instance'])[0];
    expect(db.database_version).toContain('SQLSERVER');
  });

  test('Function.Lambda nodejs20 → google_cloudfunctions2_function com nodejs20', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const r = resources(synth(stack));
    const fn: any = Object.values(r['google_cloudfunctions2_function'])[0];
    expect(fn.build_config[0].runtime).toBe('nodejs20');
  });

  test('Messaging.Queue → google_pubsub_topic + google_pubsub_subscription', () => {
    const stack = new Stack('test');
    new Messaging.Queue(stack, 'MyQueue', {});
    const r = resources(synth(stack));
    expect(r['google_pubsub_topic']).toBeDefined();
    expect(r['google_pubsub_subscription']).toBeDefined();
  });

  test('Messaging.Topic → google_pubsub_topic', () => {
    const stack = new Stack('test');
    new Messaging.Topic(stack, 'MyTopic', {});
    const r = resources(synth(stack));
    expect(r['google_pubsub_topic']).toBeDefined();
  });

  test('Cache.Redis → google_redis_instance com tier BASIC', () => {
    const stack = new Stack('test');
    new Cache.Redis(stack, 'MyRedis', { nodeType: 'small' });
    const r = resources(synth(stack));
    const redis: any = Object.values(r['google_redis_instance'])[0];
    expect(redis.tier).toBe('BASIC');
    expect(redis.memory_size_gb).toBe(1);
  });

  test('Secret.Vault → google_secret_manager_secret', () => {
    const stack = new Stack('test');
    stack.addConstruct({ id: 'MySecret', type: 'Secret.Vault', props: {} } as any);
    const r = resources(synth(stack));
    expect(r['google_secret_manager_secret']).toBeDefined();
  });

  test('Construct desconhecido → console.warn "nao suportado"', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const stack = new Stack('test');
    stack.addConstruct({ id: 'X', type: 'Foo.Bar', props: {} } as any);
    new GCPProvider().synthesize(stack);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nao suportado'));
    warnSpy.mockRestore();
  });

  test('provider block tem project e region via variáveis', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'B', {});
    const out = synth(stack);
    const provider: any = out.provider;
    expect(provider.google.project).toContain('project_id');
    expect(provider.google.region).toContain('gcp_region');
  });

  test('output presente para Storage.Bucket', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'MyBucket', {});
    const out = synth(stack);
    const outputs = out.output as any;
    expect(outputs).toBeDefined();
    const keys = Object.keys(outputs);
    expect(keys.some(k => k.includes('MyBucket'))).toBe(true);
  });

  test('Custom.Resource com props.terraform → recurso google_*', () => {
    const stack = new Stack('test');
    stack.addConstruct({
      id: 'PubSubTopic',
      type: 'Custom.Resource',
      props: {
        terraform: {
          type: 'google_pubsub_topic',
          name: 'my-custom-topic',
          properties: { name: 'my-custom-topic' },
        },
      },
    } as any);
    const r = resources(synth(stack));
    expect(r['google_pubsub_topic']).toBeDefined();
  });
});
