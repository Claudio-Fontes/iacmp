import { Stack, Compute, Storage, Network, Database, Fn, Cache, Custom } from '@iacmp/core';
import { TerraformProvider } from '../src';
import { hclString } from '../src/synth/hcl';

describe('TerraformProvider', () => {
  test('gera bloco terraform e provider aws', () => {
    const stack = new Stack('test');
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('terraform {');
    expect(hcl).toContain('provider "aws"');
  });

  test('Compute.Instance → resource aws_instance', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'Web', { instanceType: 'medium', image: 'ubuntu-22.04' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('resource "aws_instance" "Web"');
    expect(hcl).toContain('t3.medium');
  });

  test('Storage.Bucket → resource aws_s3_bucket', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Assets', { versioning: true });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('resource "aws_s3_bucket" "Assets"');
  });

  test('Database.SQL postgres → aws_db_instance com postgres', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'PgDB', { engine: 'postgres' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('aws_db_instance');
    expect(hcl).toContain('postgres');
  });

  test('Database.SQL sqlserver → HCL contém sqlserver', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'SqlDB', { engine: 'sqlserver' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('sqlserver');
  });

  test('Database.DynamoDB sem partitionKeyType → attribute type "S" (compat)', () => {
    const stack = new Stack('test');
    new Database.DynamoDB(stack, 'Tab', { partitionKey: 'id' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('resource "aws_dynamodb_table" "Tab"');
    expect(hcl).toMatch(/attribute\s*{\s*name\s*=\s*"id"\s*type\s*=\s*"S"/);
  });

  test('Database.DynamoDB com partitionKeyType: \'N\' → attribute type "N" (regressao: tipo sempre era hardcoded como String)', () => {
    const stack = new Stack('test');
    new Database.DynamoDB(stack, 'Tab', { partitionKey: 'id', partitionKeyType: 'N' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toMatch(/attribute\s*{\s*name\s*=\s*"id"\s*type\s*=\s*"N"/);
  });

  test('Compute.Instance windows-2022 → HCL contém windows_2022', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'Win', { instanceType: 'small', image: 'windows-2022' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('windows_2022');
  });

  test('Cache.Redis → HCL contém aws_elasticache_replication_group', () => {
    const stack = new Stack('test');
    new Cache.Redis(stack, 'RedisCache', { nodeType: 'small' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('aws_elasticache_replication_group');
  });

  test('Fn.Lambda → HCL contém aws_lambda_function', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('aws_lambda_function');
  });

  // ── IAC-01: escape de strings HCL ────────────────────────────────────
  describe('IAC-01 hclString escape', () => {
    test('escapa barras invertidas', () => {
      expect(hclString('a\\b')).toBe('a\\\\b');
    });

    test('escapa aspas duplas', () => {
      expect(hclString('say "hi"')).toBe('say \\"hi\\"');
    });

    test('escapa interpolacao ${...} para $${...}', () => {
      expect(hclString('hello ${var.x}')).toBe('hello $${var.x}');
    });

    test('escapa diretiva %{...} para %%{...}', () => {
      expect(hclString('%{ if foo }')).toBe('%%{ if foo }');
    });

    test('lida com null/undefined sem quebrar', () => {
      expect(hclString(null)).toBe('');
      expect(hclString(undefined)).toBe('');
    });

    test('Lambda env var com ${} sai escapado no template', () => {
      const stack = new Stack('test');
      new Fn.Lambda(stack, 'Fn', {
        runtime: 'nodejs20',
        handler: 'index.handler',
        code: 'dist/',
        environment: { TARGET: 'value ${injected}' },
      });
      const hcl = new TerraformProvider().synthesize(stack);
      expect(hcl).toContain('$${injected}');
      expect(hcl).not.toMatch(/TARGET = "value \$\{injected\}"/);
    });

    test('SG description com aspas sai escapada', () => {
      const stack = new Stack('test');
      new Network.SecurityGroup(stack, 'SG', {
        vpcId: 'vpc-1',
        description: 'web "tier"',
        ingressRules: [{ protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '0.0.0.0/0' } as any],
      });
      const hcl = new TerraformProvider().synthesize(stack);
      expect(hcl).toContain('description = "web \\"tier\\""');
    });
  });

  // ── IAC-02 / SEC-03: senha como variable sensitive ──────────────────
  describe('IAC-02 db_password variable', () => {
    test('Database.SQL gera variable "db_password" sensitive no topo', () => {
      const stack = new Stack('test');
      new Database.SQL(stack, 'DB', { engine: 'mysql' });
      const hcl = new TerraformProvider().synthesize(stack);
      expect(hcl).toContain('variable "db_password"');
      expect(hcl).toContain('sensitive   = true');
      expect(hcl).toContain('password = var.db_password');
      expect(hcl).not.toContain('"changeme"');
    });

    test('Database.DocumentDB usa var.db_password', () => {
      const stack = new Stack('test');
      new Database.DocumentDB(stack, 'Docs', {});
      const hcl = new TerraformProvider().synthesize(stack);
      expect(hcl).toContain('variable "db_password"');
      expect(hcl).toContain('master_password = var.db_password');
      expect(hcl).not.toContain('"changeme"');
    });

    test('stack sem banco nao emite variable db_password', () => {
      const stack = new Stack('test');
      new Storage.Bucket(stack, 'B', { versioning: false });
      const hcl = new TerraformProvider().synthesize(stack);
      expect(hcl).not.toContain('variable "db_password"');
    });
  });

  // ── SEC-04 + ARCH-06 ─────────────────────────────────────────────────
  test('SEC-04: SG ingress sem CIDR emite warn', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const stack = new Stack('test');
    new Network.SecurityGroup(stack, 'SG', {
      vpcId: 'vpc-1',
      ingressRules: [{ protocol: 'tcp', fromPort: 22, toPort: 22 } as any],
    });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('0.0.0.0/0');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sem CIDR'));
    warnSpy.mockRestore();
  });

  test('ARCH-06: construct desconhecido emite warn', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const stack = new Stack('test');
    stack.addConstruct({ id: 'X', type: 'Foo.Bar', props: {} } as any);
    new TerraformProvider().synthesize(stack);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'Foo.Bar' nao suportado"));
    warnSpy.mockRestore();
  });

  test('Fn.ApiGateway com authorizerLambdaId → HCL contém aws_apigatewayv2_authorizer e authorization_type CUSTOM', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'AuthFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Fn.ApiGateway(stack, 'Api', {
      name: 'my-api',
      authorizerLambdaId: 'AuthFn',
      routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }],
    });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('resource "aws_apigatewayv2_authorizer" "Api_authorizer"');
    expect(hcl).toContain('aws_lambda_function.AuthFn.invoke_arn');
    expect(hcl).toContain('authorization_type');
    expect(hcl).toContain('aws_apigatewayv2_authorizer.Api_authorizer.id');
  });

  test('Custom.Resource → gera resource Terraform a partir do props.terraform', () => {
    const stack = new Stack('test');
    new Custom.Resource(stack, 'RotationSchedule', {
      terraform: {
        type: 'aws_secretsmanager_rotation_schedule',
        body: {
          secret_id: 'aws_secretsmanager_secret.MySecret.id',
          rotation_rules: { automatically_after_days: 30 },
        },
      },
    });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('resource "aws_secretsmanager_rotation_schedule" "RotationSchedule"');
    expect(hcl).toContain('secret_id = aws_secretsmanager_secret.MySecret.id');
    expect(hcl).toContain('automatically_after_days = 30');
  });
});
