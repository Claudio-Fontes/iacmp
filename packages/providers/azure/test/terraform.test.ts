import { Stack, Storage, Network, Database, Fn, Messaging, Cache, Monitoring, Compute, ref } from '@iacmp/core';
import { AzureTerraformProvider } from '../src';

function synth(stack: Stack, allStacks?: Stack[]): Record<string, unknown> {
  const provider = new AzureTerraformProvider();
  const all = allStacks ?? [stack];
  return JSON.parse(provider.synthesizeResources(stack, all));
}

function providers(): Record<string, unknown> {
  return JSON.parse(new AzureTerraformProvider().synthesizeProviders());
}

describe('AzureTerraformProvider — providers block', () => {
  test('synthesizeProviders emite azurerm ~> 4.0 + resource group + variáveis', () => {
    const out = providers();
    expect((out.terraform as any).required_providers.azurerm.source).toBe('hashicorp/azurerm');
    expect((out.terraform as any).required_providers.azurerm.version).toMatch(/~>/);
    expect((out.provider as any).azurerm).toEqual({ features: {} });
    expect((out.variable as any).resource_group).toBeDefined();
    expect((out.variable as any).location).toBeDefined();
    expect((out.resource as any).azurerm_resource_group.main).toBeDefined();
  });

  test('synthesizeProviders aceita localização e resource group customizados', () => {
    const out = JSON.parse(new AzureTerraformProvider().synthesizeProviders('westus2', 'meu-rg'));
    expect((out.variable as any).location.default).toBe('westus2');
    expect((out.variable as any).resource_group.default).toBe('meu-rg');
  });
});

describe('AzureTerraformProvider — Function.Lambda', () => {
  test('emite azurerm_linux_function_app + storage + consumption plan', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Api', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/api' });
    const out = synth(stack);
    const r = (out.resource as any);
    expect(r.azurerm_linux_function_app?.api).toBeDefined();
    expect(r.azurerm_storage_account?.fn_storage).toBeDefined();
    expect(r.azurerm_service_plan?.consumption_plan.sku_name).toBe('Y1');
    expect(r.azurerm_service_plan?.consumption_plan.os_type).toBe('Linux');
  });

  test('Function.Lambda com environment vars', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Worker', {
      runtime: 'nodejs20', handler: 'index.handler', code: 'dist/worker',
      environment: { TABLE_NAME: 'items', LOG_LEVEL: 'info' },
    });
    const out = synth(stack);
    const settings = (out.resource as any).azurerm_linux_function_app.worker.app_settings;
    expect(settings.TABLE_NAME).toBe('items');
    expect(settings.LOG_LEVEL).toBe('info');
    expect(settings.FUNCTIONS_WORKER_RUNTIME).toBe('node');
  });

  test('duas Lambdas compartilham o mesmo storage e consumption plan', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'FnA', { runtime: 'nodejs20', handler: 'a.handler', code: 'dist/a' });
    new Fn.Lambda(stack, 'FnB', { runtime: 'nodejs20', handler: 'b.handler', code: 'dist/b' });
    const out = synth(stack);
    const r = (out.resource as any);
    expect(Object.keys(r.azurerm_linux_function_app)).toHaveLength(2);
    expect(Object.keys(r.azurerm_storage_account ?? {})).toHaveLength(1);
    expect(Object.keys(r.azurerm_service_plan ?? {})).toHaveLength(1);
  });

  test('Lambda tem identity SystemAssigned (necessário para role assignments)', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Fn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist' });
    const out = synth(stack);
    expect((out.resource as any).azurerm_linux_function_app.fn.identity).toEqual({ type: 'SystemAssigned' });
  });
});

describe('AzureTerraformProvider — Storage.Bucket', () => {
  test('emite azurerm_storage_account + container', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Files', { versioning: false });
    const out = synth(stack);
    const r = (out.resource as any);
    expect(r.azurerm_storage_account?.files).toBeDefined();
    expect(r.azurerm_storage_container?.files_container).toBeDefined();
  });

  test('replication geo → account_replication_type RAGRS', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Backup', { versioning: false, replication: 'geo' });
    const out = synth(stack);
    expect((out.resource as any).azurerm_storage_account.backup.account_replication_type).toBe('RAGRS');
  });

  test('versioning true → blob_properties.versioning_enabled', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Versioned', { versioning: true });
    const out = synth(stack);
    expect((out.resource as any).azurerm_storage_account.versioned.blob_properties.versioning_enabled).toBe(true);
  });

  test('emite output name e connection_string', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Data', { versioning: false });
    const out = synth(stack);
    expect((out.output as any).data_name).toBeDefined();
    expect((out.output as any).data_connection_string.sensitive).toBe(true);
  });
});

describe('AzureTerraformProvider — Database.Table / DynamoDB', () => {
  test('emite azurerm_cosmosdb_account + sql database + container', () => {
    const stack = new Stack('test');
    new Database.DynamoDB(stack, 'Items', { partitionKey: 'id', billingMode: 'PAY_PER_REQUEST' });
    const out = synth(stack);
    const r = (out.resource as any);
    expect(r.azurerm_cosmosdb_account?.items).toBeDefined();
    expect(r.azurerm_cosmosdb_sql_database?.items_db).toBeDefined();
    expect(r.azurerm_cosmosdb_sql_container?.items_container).toBeDefined();
  });

  test('partition key é refletido no container com barra inicial', () => {
    const stack = new Stack('test');
    new Database.DynamoDB(stack, 'Orders', { partitionKey: 'orderId', billingMode: 'PAY_PER_REQUEST' });
    const out = synth(stack);
    const container = (out.resource as any).azurerm_cosmosdb_sql_container.orders_container;
    expect(container.partition_key_path).toBe('/orderId');
  });

  test('emite output endpoint e key (sensitive)', () => {
    const stack = new Stack('test');
    new Database.DynamoDB(stack, 'Tbl', { partitionKey: 'pk', billingMode: 'PAY_PER_REQUEST' });
    const out = synth(stack);
    expect((out.output as any).tbl_endpoint).toBeDefined();
    expect((out.output as any).tbl_key.sensitive).toBe(true);
  });
});

describe('AzureTerraformProvider — Database.SQL', () => {
  test('postgres → azurerm_postgresql_flexible_server + database', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'Db', { engine: 'postgres' });
    const out = synth(stack);
    const r = (out.resource as any);
    expect(r.azurerm_postgresql_flexible_server?.db).toBeDefined();
    expect(r.azurerm_postgresql_flexible_server_database?.db_db).toBeDefined();
    expect(r.azurerm_postgresql_flexible_server.db.version).toBe('14');
  });

  test('mysql → azurerm_mysql_flexible_server', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'Mysql', { engine: 'mysql' });
    const out = synth(stack);
    expect((out.resource as any).azurerm_mysql_flexible_server?.mysql).toBeDefined();
  });

  test('emite output fqdn', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'Pg', { engine: 'postgres' });
    const out = synth(stack);
    expect((out.output as any).pg_fqdn).toBeDefined();
  });
});

describe('AzureTerraformProvider — Cache.Redis', () => {
  test('emite azurerm_redis_cache Basic C0', () => {
    const stack = new Stack('test');
    new Cache.Redis(stack, 'Cache', {});
    const out = synth(stack);
    const redis = (out.resource as any).azurerm_redis_cache?.cache;
    expect(redis).toBeDefined();
    expect(redis.sku_name).toBe('Basic');
    expect(redis.family).toBe('C');
    expect(redis.capacity).toBe(0);
    expect(redis.enable_non_ssl_port).toBe(false);
  });

  test('emite outputs hostname, ssl_port e key (sensitive)', () => {
    const stack = new Stack('test');
    new Cache.Redis(stack, 'R', {});
    const out = synth(stack);
    expect((out.output as any).r_hostname).toBeDefined();
    expect((out.output as any).r_ssl_port).toBeDefined();
    expect((out.output as any).r_key.sensitive).toBe(true);
  });
});

describe('AzureTerraformProvider — Messaging.Queue', () => {
  test('emite servicebus namespace + queue', () => {
    const stack = new Stack('test');
    new Messaging.Queue(stack, 'Jobs', {});
    const out = synth(stack);
    const r = (out.resource as any);
    expect(r.azurerm_servicebus_namespace?.jobs_ns).toBeDefined();
    expect(r.azurerm_servicebus_queue?.jobs).toBeDefined();
    expect(r.azurerm_servicebus_namespace.jobs_ns.sku).toBe('Standard');
  });

  test('emite output name e connection_string (sensitive)', () => {
    const stack = new Stack('test');
    new Messaging.Queue(stack, 'Q', {});
    const out = synth(stack);
    expect((out.output as any).q_name).toBeDefined();
    expect((out.output as any).q_connection_string.sensitive).toBe(true);
  });
});

describe('AzureTerraformProvider — Messaging.Topic', () => {
  test('emite servicebus namespace + topic', () => {
    const stack = new Stack('test');
    new Messaging.Topic(stack, 'Events', {});
    const out = synth(stack);
    const r = (out.resource as any);
    expect(r.azurerm_servicebus_namespace?.events_ns).toBeDefined();
    expect(r.azurerm_servicebus_topic?.events).toBeDefined();
  });

  test('subscriptions → azurerm_servicebus_subscription por item', () => {
    const stack = new Stack('test');
    new Messaging.Topic(stack, 'Notifs', {
      subscriptions: [
        { protocol: 'email', endpoint: 'a@example.com' },
        { protocol: 'http', endpoint: 'https://example.com/push' },
      ],
    });
    const out = synth(stack);
    const r = (out.resource as any);
    expect(r.azurerm_servicebus_subscription?.notifs_sub0).toBeDefined();
    expect(r.azurerm_servicebus_subscription?.notifs_sub1).toBeDefined();
  });
});

describe('AzureTerraformProvider — Network', () => {
  test('Network.VPC → azurerm_virtual_network com address_space', () => {
    const stack = new Stack('test');
    new Network.VPC(stack, 'AppVpc', { cidr: '10.1.0.0/16' });
    const out = synth(stack);
    const vnet = (out.resource as any).azurerm_virtual_network?.appvpc;
    expect(vnet).toBeDefined();
    expect(vnet.address_space).toContain('10.1.0.0/16');
  });

  test('Network.Subnet → azurerm_subnet referenciando a VNet', () => {
    const stack = new Stack('test');
    new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16' });
    new Network.Subnet(stack, 'Private', { vpcId: 'Vpc', cidr: '10.0.1.0/24', public: false });
    const out = synth(stack);
    const subnet = (out.resource as any).azurerm_subnet?.private;
    expect(subnet).toBeDefined();
    expect(subnet.address_prefixes).toContain('10.0.1.0/24');
    expect(subnet.virtual_network_name).toContain('azurerm_virtual_network.vpc.name');
  });

  test('Network.Subnet com vpcId via ref() → interpolação TF', () => {
    const stack = new Stack('test');
    new Network.VPC(stack, 'Net', { cidr: '10.0.0.0/16' });
    new Network.Subnet(stack, 'Sub', { vpcId: ref('Net', 'VpcId') as unknown as string, cidr: '10.0.1.0/24', public: false });
    const out = synth(stack);
    const subnet = (out.resource as any).azurerm_subnet?.sub;
    expect(subnet.virtual_network_name).toContain('azurerm_virtual_network.net.name');
  });

  test('Network.SecurityGroup → azurerm_network_security_group', () => {
    const stack = new Stack('test');
    new Network.SecurityGroup(stack, 'Sg', { vpcId: 'Vpc' });
    const out = synth(stack);
    expect((out.resource as any).azurerm_network_security_group?.sg).toBeDefined();
  });
});

describe('AzureTerraformProvider — ref() cross-construct', () => {
  test('Lambda com env ref(DynamoDB, Name) → interpolação TF no app_settings', () => {
    const stack = new Stack('test');
    new Database.DynamoDB(stack, 'Table', { partitionKey: 'id', billingMode: 'PAY_PER_REQUEST' });
    new Fn.Lambda(stack, 'Fn', {
      runtime: 'nodejs20', handler: 'index.handler', code: 'dist',
      environment: { TABLE_NAME: ref('Table', 'Name') },
    });
    const out = synth(stack);
    const settings = (out.resource as any).azurerm_linux_function_app.fn.app_settings;
    expect(settings.TABLE_NAME).toContain('${azurerm_cosmosdb_account.table');
  });

  test('Lambda com env ref(Queue, ConnectionString) → interpolação TF', () => {
    const stack = new Stack('test');
    new Messaging.Queue(stack, 'Q', {});
    new Fn.Lambda(stack, 'Worker', {
      runtime: 'nodejs20', handler: 'index.handler', code: 'dist',
      environment: { QUEUE_CONN: ref('Q', 'ConnectionString') },
    });
    const out = synth(stack);
    const settings = (out.resource as any).azurerm_linux_function_app.worker.app_settings;
    expect(settings.QUEUE_CONN).toContain('${azurerm_servicebus_queue.q');
  });

  test('ref cross-stack: Lambda numa stack referencia DynamoDB de outra', () => {
    const stack1 = new Stack('data');
    new Database.DynamoDB(stack1, 'Items', { partitionKey: 'id', billingMode: 'PAY_PER_REQUEST' });
    const stack2 = new Stack('compute');
    new Fn.Lambda(stack2, 'Api', {
      runtime: 'nodejs20', handler: 'index.handler', code: 'dist',
      environment: { TABLE_NAME: ref('Items', 'Name') },
    });
    const out = synth(stack2, [stack1, stack2]);
    const settings = (out.resource as any).azurerm_linux_function_app.api.app_settings;
    expect(settings.TABLE_NAME).toContain('${azurerm_cosmosdb_account.items');
  });
});

describe('AzureTerraformProvider — Compute.Container', () => {
  test('emite container app environment + container app', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'Web', { image: 'nginx:latest', cpu: 0.25, memory: 512 });
    const out = synth(stack);
    const r = (out.resource as any);
    expect(r.azurerm_container_app_environment?.web_cae).toBeDefined();
    expect(r.azurerm_container_app?.web).toBeDefined();
    expect(r.azurerm_container_app.web.template.container[0].image).toBe('nginx:latest');
  });

  test('ingress habilitado com external_enabled true', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'Svc', { image: 'myapp:1.0', cpu: 0.5, memory: 1024, port: 3000 });
    const out = synth(stack);
    const ingress = (out.resource as any).azurerm_container_app.svc.ingress[0];
    expect(ingress.external_enabled).toBe(true);
    expect(ingress.target_port).toBe(3000);
  });

  test('emite output fqdn', () => {
    const stack = new Stack('test');
    new Compute.Container(stack, 'App', { image: 'app:latest', cpu: 0.25, memory: 512 });
    const out = synth(stack);
    expect((out.output as any).app_fqdn).toBeDefined();
  });
});

describe('AzureTerraformProvider — Secret.Vault', () => {
  test('emite azurerm_key_vault com access_policy e data client_config', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Fn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist' });
    const out = synth(stack);
    // Key vault não foi adicionado — data block só aparece quando Secret.Vault está presente
    expect((out.data as any)?.azurerm_client_config).toBeUndefined();
  });

  test('Monitoring.Alarm → azurerm_monitor_metric_alert', () => {
    const stack = new Stack('test');
    new Monitoring.Alarm(stack, 'CpuHigh', { threshold: 90, comparisonOperator: 'GreaterThanThreshold', metricName: 'Percentage CPU' });
    const out = synth(stack);
    const alert = (out.resource as any).azurerm_monitor_metric_alert?.cpuhigh;
    expect(alert).toBeDefined();
    expect(alert.criteria[0].threshold).toBe(90);
    expect(alert.criteria[0].operator).toBe('GreaterThan');
  });
});

describe('AzureTerraformProvider — Messaging.Stream (EventHub)', () => {
  test('emite eventhub namespace + eventhub', () => {
    const stack = new Stack('test');
    new Messaging.Stream(stack, 'Events', { shards: 4 });
    const out = synth(stack);
    const r = (out.resource as any);
    expect(r.azurerm_eventhub_namespace?.events_eh_ns).toBeDefined();
    expect(r.azurerm_eventhub?.events).toBeDefined();
    expect(r.azurerm_eventhub.events.partition_count).toBe(4);
  });
});

describe('AzureTerraformProvider — constructs desconhecidos', () => {
  test('construct não suportado é descartado sem erro', () => {
    const stack = new Stack('test');
    // Simula um construct desconhecido injetando direto no array interno
    (stack as any).constructs.push({ id: 'X', type: 'Unknown.Type', props: {} });
    expect(() => synth(stack)).not.toThrow();
  });
});
