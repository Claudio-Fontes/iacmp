import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { orderByDependency, TemplateRef } from '../src/synth-out';

function writeTemplate(dir: string, fileName: string, content: Record<string, unknown>): TemplateRef {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(content));
  return { stackName: fileName.replace(/\.json$/, ''), filePath, fileName };
}

describe('orderByDependency', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-order-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('exportador vem antes do importador, mesmo se listado depois', () => {
    // network.json (importador) é criado/listado ANTES de compute.json (exportador)
    const network = writeTemplate(dir, 'network.json', {
      Resources: {
        Integration: { Type: 'AWS::ApiGatewayV2::Integration', Properties: { Uri: { 'Fn::ImportValue': 'lambda-stack-HelloFn-Arn' } } },
      },
    });
    const compute = writeTemplate(dir, 'compute.json', {
      Resources: { HelloFn: { Type: 'AWS::Lambda::Function', Properties: {} } },
      Outputs: { HelloFnArn: { Value: {}, Export: { Name: 'lambda-stack-HelloFn-Arn' } } },
    });

    const ordered = orderByDependency([network, compute]);
    expect(ordered.map(t => t.fileName)).toEqual(['compute.json', 'network.json']);
  });

  test('sem dependência entre templates → mantém a ordem original', () => {
    const a = writeTemplate(dir, 'a.json', { Resources: {} });
    const b = writeTemplate(dir, 'b.json', { Resources: {} });
    expect(orderByDependency([a, b]).map(t => t.fileName)).toEqual(['a.json', 'b.json']);
  });

  test('Azure: database (exporta) vem antes do compute que importa via param COM default (bug do 19)', () => {
    // compute listado ANTES; consome FlagsTableConnectionString com default vazio
    // (soft). Sem ordenar, o compute deploya 1º e a env fica vazia → 500.
    const compute = writeBicep('compute.bicep',
      "param FlagsTableConnectionString string = ''\nparam FlagsTableName string = ''\nresource f 'X' = {}");
    const database = writeBicep('database.bicep',
      "resource t 'Y' = {}\noutput FlagsTableConnectionString string = 'x'\noutput FlagsTableName string = 'FlagsTable'");
    const ordered = orderByDependency([compute, database]);
    expect(ordered.map(t => t.fileName)).toEqual(['database.bicep', 'compute.bicep']);
  });

  test('template terraform (.tf.json) sem Outputs CFN não quebra — sem dependências conhecidas', () => {
    const tfPath = path.join(dir, 'main.tf.json');
    fs.writeFileSync(tfPath, JSON.stringify({ resource: { aws_s3_bucket: { x: {} } } }));
    const tf: TemplateRef = { stackName: 'main', filePath: tfPath, fileName: 'main.tf.json' };
    expect(orderByDependency([tf])).toEqual([tf]);
  });

  test('cadeia de 3 stacks (A exporta, B importa de A e exporta pra C, C importa de B)', () => {
    const a = writeTemplate(dir, 'a.json', {
      Resources: {},
      Outputs: { X: { Value: {}, Export: { Name: 'export-a' } } },
    });
    const b = writeTemplate(dir, 'b.json', {
      Resources: { R: { Type: 'X', Properties: { V: { 'Fn::ImportValue': 'export-a' } } } },
      Outputs: { Y: { Value: {}, Export: { Name: 'export-b' } } },
    });
    const c = writeTemplate(dir, 'c.json', {
      Resources: { R: { Type: 'X', Properties: { V: { 'Fn::ImportValue': 'export-b' } } } },
    });

    // ordem de entrada embaralhada de propósito
    const ordered = orderByDependency([c, a, b]);
    expect(ordered.map(t => t.fileName)).toEqual(['a.json', 'b.json', 'c.json']);
  });

  function writeBicep(fileName: string, content: string): TemplateRef {
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, content);
    return { stackName: fileName.replace(/\.bicep$/, ''), filePath, fileName };
  }

  test('bicep: stack com output vem antes da stack com param sem default (caso iacmp31)', () => {
    // api-stack precisa de ItemsTableName (param SEM default); dynamo-stack o exporta.
    // Ordem alfabética/entrada colocaria api antes — a ordenação deve inverter.
    const api = writeBicep('api-stack.bicep', [
      'param location string = resourceGroup().location',
      'param listItemsFnImage string = \'node:20-alpine\'',
      'param acrServer string = \'\'',
      'param ItemsTableName string',
      'output ListItemsFnId string = listItemsFn.id',
    ].join('\n'));
    const dynamo = writeBicep('dynamo-stack.bicep', [
      'param location string = resourceGroup().location',
      'output ItemsTableName string = itemsTable.name',
      'output ItemsTableArn string = itemsTable.id',
    ].join('\n'));

    const ordered = orderByDependency([api, dynamo]);
    expect(ordered.map(t => t.fileName)).toEqual(['dynamo-stack.bicep', 'api-stack.bicep']);
  });

  test('bicep: params COM default não criam dependência', () => {
    const a = writeBicep('a.bicep', 'param location string = resourceGroup().location\noutput X string = r.id');
    const b = writeBicep('b.bicep', 'param location string = resourceGroup().location');
    expect(orderByDependency([a, b]).map(t => t.fileName)).toEqual(['a.bicep', 'b.bicep']);
  });

  // ── Guard de ciclo ────────────────────────────────────────────────────────

  test('dependência circular bidirecional (buckets↔lambda) → lança com mensagem clara', () => {
    // Reproduz o cenário p11 AWS: buckets-stack exporta BucketArn e importa
    // Lambda-Arn (para NotificationConfiguration); lambda-stack exporta
    // Lambda-Arn e importa BucketArn (para env + IAM) → ciclo impossível.
    const buckets = writeTemplate(dir, 'buckets-stack.json', {
      Resources: {
        RawBucket: { Type: 'AWS::S3::Bucket', Properties: {
          NotificationConfiguration: { LambdaConfigurations: [
            { Function: { 'Fn::ImportValue': 'p11aws-lambda-DataProcessorFn-Arn' } },
          ]},
        }},
      },
      Outputs: {
        RawDataBucketArn: { Value: {}, Export: { Name: 'p11aws-buckets-RawDataBucket-Arn' } },
      },
    });
    const lambda = writeTemplate(dir, 'lambda-stack.json', {
      Resources: {
        DataProcessorFn: { Type: 'AWS::Lambda::Function', Properties: {
          Environment: { Variables: { BUCKET: { 'Fn::ImportValue': 'p11aws-buckets-RawDataBucket-Arn' } } },
        }},
      },
      Outputs: {
        DataProcessorFnArn: { Value: {}, Export: { Name: 'p11aws-lambda-DataProcessorFn-Arn' } },
      },
    });

    expect(() => orderByDependency([buckets, lambda])).toThrow(/circular/i);
    expect(() => orderByDependency([buckets, lambda])).toThrow(/buckets-stack/);
    expect(() => orderByDependency([buckets, lambda])).toThrow(/lambda-stack/);
    // Mensagem deve citar os exports envolvidos para orientar o fix
    expect(() => orderByDependency([buckets, lambda])).toThrow(/p11aws-/);
  });

  test('ciclo com 3 stacks (A→B→C→A) → lança erro', () => {
    const sa = writeTemplate(dir, 'sa.json', {
      Resources: { R: { Type: 'X', Properties: { V: { 'Fn::ImportValue': 'export-sc' } } } },
      Outputs: { X: { Value: {}, Export: { Name: 'export-sa' } } },
    });
    const sb = writeTemplate(dir, 'sb.json', {
      Resources: { R: { Type: 'X', Properties: { V: { 'Fn::ImportValue': 'export-sa' } } } },
      Outputs: { Y: { Value: {}, Export: { Name: 'export-sb' } } },
    });
    const sc = writeTemplate(dir, 'sc.json', {
      Resources: { R: { Type: 'X', Properties: { V: { 'Fn::ImportValue': 'export-sb' } } } },
      Outputs: { Z: { Value: {}, Export: { Name: 'export-sc' } } },
    });

    expect(() => orderByDependency([sa, sb, sc])).toThrow(/circular/i);
  });

  test('cadeia acíclica A→B→C continua ordenando corretamente após o guard', () => {
    // Regressão: o guard não deve afetar casos válidos.
    const ax = writeTemplate(dir, 'ax.json', {
      Resources: {},
      Outputs: { P: { Value: {}, Export: { Name: 'guard-export-ax' } } },
    });
    const bx = writeTemplate(dir, 'bx.json', {
      Resources: { R: { Type: 'X', Properties: { V: { 'Fn::ImportValue': 'guard-export-ax' } } } },
      Outputs: { Q: { Value: {}, Export: { Name: 'guard-export-bx' } } },
    });
    const cx = writeTemplate(dir, 'cx.json', {
      Resources: { R: { Type: 'X', Properties: { V: { 'Fn::ImportValue': 'guard-export-bx' } } } },
    });

    const ordered = orderByDependency([cx, ax, bx]);
    expect(ordered.map(t => t.fileName)).toEqual(['ax.json', 'bx.json', 'cx.json']);
  });
});
