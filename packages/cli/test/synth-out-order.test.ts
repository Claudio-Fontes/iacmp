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

  test('template não-JSON (ex: terraform .tf) não quebra — sem dependências conhecidas', () => {
    const tfPath = path.join(dir, 'main.tf');
    fs.writeFileSync(tfPath, 'resource "aws_s3_bucket" "x" {}');
    const tf: TemplateRef = { stackName: 'main', filePath: tfPath, fileName: 'main.tf' };
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
});
