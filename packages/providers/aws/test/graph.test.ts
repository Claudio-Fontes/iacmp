import {
  resourceRef,
  importRef,
  subRef,
  isResourceRef,
  isImportRef,
  isSubRef,
  isGraphValue,
} from '../src/synth/graph';
import type { StackGraph } from '../src/synth/graph';
import { emitCloudFormation } from '../src/synth/emit/cloudformation';

describe('graph factories', () => {
  test('resourceRef cria objeto correto', () => {
    const r = resourceRef('MyLambda', 'Arn');
    expect(r).toEqual({ kind: 'iacmp:resource-ref', targetLogicalId: 'MyLambda', attribute: 'Arn' });
  });

  test('importRef cria objeto correto', () => {
    const r = importRef('my-stack-MyLambda-Arn');
    expect(r).toEqual({ kind: 'iacmp:import-ref', exportName: 'my-stack-MyLambda-Arn' });
  });

  test('subRef sem vars — vars default para {}', () => {
    const r = subRef('arn:aws:${AWS::Region}');
    expect(r).toEqual({ kind: 'iacmp:sub-ref', template: 'arn:aws:${AWS::Region}', vars: {} });
  });

  test('subRef com vars aceita ResourceRef e string', () => {
    const r = subRef('${Fn}/invocations', { Fn: resourceRef('LambdaFn', 'Arn'), Env: 'prod' });
    expect(r.vars).toEqual({
      Fn: { kind: 'iacmp:resource-ref', targetLogicalId: 'LambdaFn', attribute: 'Arn' },
      Env: 'prod',
    });
  });

  test('subRef com ImportRef nas vars', () => {
    const r = subRef('${X}', { X: importRef('other-stack-X-Arn') });
    expect(r.vars.X).toEqual({ kind: 'iacmp:import-ref', exportName: 'other-stack-X-Arn' });
  });
});

describe('type guards', () => {
  test('isResourceRef', () => {
    expect(isResourceRef(resourceRef('X', 'Arn'))).toBe(true);
    expect(isResourceRef(importRef('x'))).toBe(false);
    expect(isResourceRef(subRef('t'))).toBe(false);
    expect(isResourceRef(null)).toBe(false);
    expect(isResourceRef(undefined)).toBe(false);
    expect(isResourceRef({ kind: 'other' })).toBe(false);
    expect(isResourceRef('string')).toBe(false);
  });

  test('isImportRef', () => {
    expect(isImportRef(importRef('x'))).toBe(true);
    expect(isImportRef(resourceRef('X', 'Arn'))).toBe(false);
    expect(isImportRef(null)).toBe(false);
  });

  test('isSubRef', () => {
    expect(isSubRef(subRef('t'))).toBe(true);
    expect(isSubRef(resourceRef('X', 'Arn'))).toBe(false);
    expect(isSubRef(null)).toBe(false);
  });

  test('isGraphValue aceita qualquer GraphValue', () => {
    expect(isGraphValue(resourceRef('X', 'Arn'))).toBe(true);
    expect(isGraphValue(importRef('x'))).toBe(true);
    expect(isGraphValue(subRef('t'))).toBe(true);
  });

  test('isGraphValue rejeita objetos não-marcados', () => {
    expect(isGraphValue({ Ref: 'X' })).toBe(false);
    expect(isGraphValue({ 'Fn::GetAtt': ['X', 'Arn'] })).toBe(false);
    expect(isGraphValue('string')).toBe(false);
    expect(isGraphValue(42)).toBe(false);
    expect(isGraphValue(null)).toBe(false);
  });
});

describe('emitCloudFormation — conversão de GraphValue', () => {
  function singleNode(props: Record<string, unknown>, dependsOn: string[] = [], deletionPolicy?: string): StackGraph {
    return {
      stackName: 'test-stack',
      nodes: [{ logicalId: 'MyRes', awsType: 'AWS::Lambda::Function', properties: props, dependsOn, deletionPolicy }],
      exports: [],
    };
  }

  test('ResourceRef com attribute Id → Ref', () => {
    const tpl = emitCloudFormation(singleNode({ VpcId: resourceRef('AppVpc', 'Id') }));
    expect(tpl.Resources.MyRes.Properties.VpcId).toEqual({ Ref: 'AppVpc' });
  });

  test('ResourceRef com outro attribute → Fn::GetAtt', () => {
    const tpl = emitCloudFormation(singleNode({ Role: resourceRef('MyRole', 'Arn') }));
    expect(tpl.Resources.MyRes.Properties.Role).toEqual({ 'Fn::GetAtt': ['MyRole', 'Arn'] });
  });

  test('ResourceRef com attribute Endpoint.Address → Fn::GetAtt com ponto', () => {
    const tpl = emitCloudFormation(singleNode({ Host: resourceRef('MyDB', 'Endpoint.Address') }));
    expect(tpl.Resources.MyRes.Properties.Host).toEqual({ 'Fn::GetAtt': ['MyDB', 'Endpoint.Address'] });
  });

  test('ImportRef → Fn::ImportValue', () => {
    const tpl = emitCloudFormation(singleNode({ Role: importRef('other-stack-MyRole-Arn') }));
    expect(tpl.Resources.MyRes.Properties.Role).toEqual({ 'Fn::ImportValue': 'other-stack-MyRole-Arn' });
  });

  test('SubRef sem vars → Fn::Sub forma 1-arg', () => {
    const tpl = emitCloudFormation(singleNode({ Uri: subRef('arn:aws:${AWS::AccountId}') }));
    expect(tpl.Resources.MyRes.Properties.Uri).toEqual({ 'Fn::Sub': 'arn:aws:${AWS::AccountId}' });
  });

  test('SubRef com ResourceRef nas vars → Fn::Sub forma 2-arg com Fn::GetAtt', () => {
    const tpl = emitCloudFormation(singleNode({
      Uri: subRef(
        'arn:aws:apigateway:${AWS::Region}:lambda:path/functions/${LambdaArn}/invocations',
        { LambdaArn: resourceRef('LambdaFn', 'Arn') },
      ),
    }));
    expect(tpl.Resources.MyRes.Properties.Uri).toEqual({
      'Fn::Sub': [
        'arn:aws:apigateway:${AWS::Region}:lambda:path/functions/${LambdaArn}/invocations',
        { LambdaArn: { 'Fn::GetAtt': ['LambdaFn', 'Arn'] } },
      ],
    });
  });

  test('SubRef com ImportRef nas vars → Fn::Sub forma 2-arg com Fn::ImportValue', () => {
    const tpl = emitCloudFormation(singleNode({
      Uri: subRef('arn:${Arn}', { Arn: importRef('other-stack-LambdaFn-Arn') }),
    }));
    expect(tpl.Resources.MyRes.Properties.Uri).toEqual({
      'Fn::Sub': ['arn:${Arn}', { Arn: { 'Fn::ImportValue': 'other-stack-LambdaFn-Arn' } }],
    });
  });

  test('SubRef com string var → string na saída', () => {
    const tpl = emitCloudFormation(singleNode({
      Uri: subRef('prefix-${Env}', { Env: 'production' }),
    }));
    expect(tpl.Resources.MyRes.Properties.Uri).toEqual({
      'Fn::Sub': ['prefix-${Env}', { Env: 'production' }],
    });
  });

  test('dual-mode: { Ref } cru passa inalterado', () => {
    const tpl = emitCloudFormation(singleNode({ VpcId: { Ref: 'SomeVpc' } }));
    expect(tpl.Resources.MyRes.Properties.VpcId).toEqual({ Ref: 'SomeVpc' });
  });

  test('dual-mode: { Fn::GetAtt } cru passa inalterado', () => {
    const tpl = emitCloudFormation(singleNode({ Role: { 'Fn::GetAtt': ['MyRole', 'Arn'] } }));
    expect(tpl.Resources.MyRes.Properties.Role).toEqual({ 'Fn::GetAtt': ['MyRole', 'Arn'] });
  });

  test('dual-mode: { Fn::ImportValue } cru passa inalterado', () => {
    const tpl = emitCloudFormation(singleNode({ Imported: { 'Fn::ImportValue': 'some-export' } }));
    expect(tpl.Resources.MyRes.Properties.Imported).toEqual({ 'Fn::ImportValue': 'some-export' });
  });

  test('dual-mode: { Fn::Sub } cru passa inalterado', () => {
    const raw = { 'Fn::Sub': 'arn:${AWS::Region}' };
    const tpl = emitCloudFormation(singleNode({ Uri: raw }));
    expect(tpl.Resources.MyRes.Properties.Uri).toEqual(raw);
  });

  test('dual-mode: { Fn::Sub } 2-arg cru passa inalterado', () => {
    const raw = { 'Fn::Sub': ['arn:${X}', { X: { 'Fn::ImportValue': 'some-x' } }] };
    const tpl = emitCloudFormation(singleNode({ Uri: raw }));
    expect(tpl.Resources.MyRes.Properties.Uri).toEqual(raw);
  });

  test('GraphValue aninhado em objeto → convertido', () => {
    const tpl = emitCloudFormation(singleNode({
      Environment: { Variables: { ROLE_ARN: resourceRef('MyRole', 'Arn') } },
    }));
    expect(tpl.Resources.MyRes.Properties.Environment).toEqual({
      Variables: { ROLE_ARN: { 'Fn::GetAtt': ['MyRole', 'Arn'] } },
    });
  });

  test('GraphValue em array → convertido', () => {
    const tpl = emitCloudFormation(singleNode({
      SecurityGroupIds: [resourceRef('AppSG', 'GroupId')],
    }));
    expect(tpl.Resources.MyRes.Properties.SecurityGroupIds).toEqual([
      { 'Fn::GetAtt': ['AppSG', 'GroupId'] },
    ]);
  });

  test('dependsOn não-vazio → DependsOn na saída', () => {
    const tpl = emitCloudFormation(singleNode({}, ['MyRole', 'MyVpc']));
    expect(tpl.Resources.MyRes.DependsOn).toEqual(['MyRole', 'MyVpc']);
  });

  test('dependsOn vazio → sem DependsOn na saída', () => {
    const tpl = emitCloudFormation(singleNode({}));
    expect(tpl.Resources.MyRes.DependsOn).toBeUndefined();
  });

  test('deletionPolicy presente → DeletionPolicy na saída', () => {
    const tpl = emitCloudFormation(singleNode({}, [], 'Retain'));
    expect((tpl.Resources.MyRes as any).DeletionPolicy).toBe('Retain');
  });

  test('deletionPolicy ausente → sem DeletionPolicy na saída', () => {
    const tpl = emitCloudFormation(singleNode({}));
    expect((tpl.Resources.MyRes as any).DeletionPolicy).toBeUndefined();
  });
});

describe('emitCloudFormation — exports e estrutura do template', () => {
  test('exports → Outputs com Value e Export.Name', () => {
    const graph: StackGraph = {
      stackName: 'my-stack',
      nodes: [],
      exports: [
        { key: 'MyBucketName', name: 'my-stack-MyBucket-Name', value: { Ref: 'MyBucket' } },
      ],
    };
    const tpl = emitCloudFormation(graph);
    expect(tpl.Outputs).toBeDefined();
    expect(tpl.Outputs!['MyBucketName']).toEqual({
      Value: { Ref: 'MyBucket' },
      Export: { Name: 'my-stack-MyBucket-Name' },
    });
  });

  test('export com ResourceRef como value → convertido', () => {
    const graph: StackGraph = {
      stackName: 'my-stack',
      nodes: [],
      exports: [
        { key: 'MyRoleArn', name: 'my-stack-MyRole-Arn', value: resourceRef('MyRole', 'Arn') },
      ],
    };
    const tpl = emitCloudFormation(graph);
    expect(tpl.Outputs!['MyRoleArn'].Value).toEqual({ 'Fn::GetAtt': ['MyRole', 'Arn'] });
  });

  test('sem exports → sem chave Outputs no template', () => {
    const graph: StackGraph = { stackName: 'my-stack', nodes: [], exports: [] };
    const tpl = emitCloudFormation(graph);
    expect(tpl.Outputs).toBeUndefined();
  });

  test('template tem AWSTemplateFormatVersion e Description corretos', () => {
    const graph: StackGraph = { stackName: 'prod-stack', nodes: [], exports: [] };
    const tpl = emitCloudFormation(graph);
    expect(tpl.AWSTemplateFormatVersion).toBe('2010-09-09');
    expect(tpl.Description).toBe('Stack prod-stack — gerada pelo iacmp');
  });
});
