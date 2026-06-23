jest.mock('child_process');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { awsExecutor, getAccountId, artifactBucketName, bucketExists, resourceExists, deleteResourceAndWait, findExistingRetainedResources, describeStackStatus } from '../../src/deploy/aws';
import { DeployContext, DestroyContext } from '../../src/deploy/types';

const mockedCp = cp as jest.Mocked<typeof cp>;

describe('getAccountId', () => {
  beforeEach(() => jest.resetAllMocks());

  test('retorna o Account retornado por `aws sts get-caller-identity`', () => {
    mockedCp.execFileSync.mockReturnValue('536068784882\n' as any);
    expect(getAccountId()).toBe('536068784882');
  });

  test('lança erro claro quando o comando falha (sem credenciais)', () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('Unable to locate credentials'); });
    expect(() => getAccountId()).toThrow('aws configure');
  });
});

describe('artifactBucketName', () => {
  test('é determinístico por conta + região', () => {
    expect(artifactBucketName('123456789012', 'us-east-1')).toBe('iacmp-deploy-artifacts-123456789012-us-east-1');
  });
});

describe('bucketExists', () => {
  beforeEach(() => jest.resetAllMocks());

  test('retorna true quando head-bucket tem sucesso', () => {
    mockedCp.execFileSync.mockReturnValue('' as any);
    expect(bucketExists('meu-bucket')).toBe(true);
  });

  test('retorna false quando head-bucket falha (bucket não existe)', () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('404'); });
    expect(bucketExists('meu-bucket')).toBe(false);
  });
});

describe('resourceExists', () => {
  beforeEach(() => jest.resetAllMocks());

  test('retorna true quando cloudcontrol get-resource tem sucesso (genérico, qualquer Type)', () => {
    mockedCp.execFileSync.mockReturnValue('' as any);
    expect(resourceExists('AWS::DynamoDB::Table', 'MessagesTable', 'us-east-1')).toBe(true);
    expect(mockedCp.execFileSync).toHaveBeenCalledWith(
      'aws',
      ['cloudcontrol', 'get-resource', '--type-name', 'AWS::DynamoDB::Table', '--identifier', 'MessagesTable', '--region', 'us-east-1'],
      expect.anything()
    );
  });

  test('retorna false quando get-resource falha (recurso não existe)', () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('ResourceNotFoundException'); });
    expect(resourceExists('AWS::DocDB::DBCluster', 'meu-cluster', 'us-east-1')).toBe(false);
  });
});

describe('deleteResourceAndWait', () => {
  beforeEach(() => jest.resetAllMocks());

  test('apaga e espera via polling até OperationStatus SUCCESS', async () => {
    mockedCp.execFileSync
      .mockReturnValueOnce(JSON.stringify({ ProgressEvent: { RequestToken: 'tok-1' } }) as any)
      .mockReturnValueOnce(JSON.stringify({ ProgressEvent: { OperationStatus: 'IN_PROGRESS' } }) as any)
      .mockReturnValueOnce(JSON.stringify({ ProgressEvent: { OperationStatus: 'SUCCESS' } }) as any);

    await deleteResourceAndWait('AWS::DynamoDB::Table', 'MessagesTable', 'us-east-1');

    expect(mockedCp.execFileSync).toHaveBeenNthCalledWith(
      1,
      'aws',
      ['cloudcontrol', 'delete-resource', '--type-name', 'AWS::DynamoDB::Table', '--identifier', 'MessagesTable', '--region', 'us-east-1'],
      expect.anything()
    );
    expect(mockedCp.execFileSync).toHaveBeenCalledTimes(3);
  });

  test('lança erro claro quando OperationStatus é FAILED', async () => {
    mockedCp.execFileSync
      .mockReturnValueOnce(JSON.stringify({ ProgressEvent: { RequestToken: 'tok-1' } }) as any)
      .mockReturnValueOnce(JSON.stringify({ ProgressEvent: { OperationStatus: 'FAILED', StatusMessage: 'em uso por outro recurso' } }) as any);

    await expect(deleteResourceAndWait('AWS::DynamoDB::Table', 'MessagesTable', 'us-east-1')).rejects.toThrow('em uso por outro recurso');
  });
});

describe('findExistingRetainedResources', () => {
  let dir: string;
  let templatePath: string;

  beforeEach(() => {
    jest.resetAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-deploy-aws-retained-'));
    templatePath = path.join(dir, 'dynamodb-stack.json');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeTemplate(resources: Record<string, unknown>): void {
    fs.writeFileSync(templatePath, JSON.stringify({ AWSTemplateFormatVersion: '2010-09-09', Resources: resources }));
  }

  test('retorna recursos retentáveis (DynamoDB::Table, DocDB::DBCluster, ...) que já existem na conta — não amarrado a um único Type', () => {
    writeTemplate({
      MessagesTable: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'MessagesTable' } },
      OtherTable: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'OtherTable' } },
      DocCluster: { Type: 'AWS::DocDB::DBCluster', Properties: { DBClusterIdentifier: 'meu-cluster' } },
      Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    });
    mockedCp.execFileSync.mockImplementation((bin: string, args?: readonly string[]) => {
      if (args?.includes('MessagesTable')) return '' as any;
      throw new Error('ResourceNotFoundException');
    });

    expect(findExistingRetainedResources(templatePath, 'us-east-1')).toEqual([
      { logicalId: 'MessagesTable', typeName: 'AWS::DynamoDB::Table', identifier: 'MessagesTable' },
    ]);
  });

  test('nenhum recurso existente → retorna array vazio', () => {
    writeTemplate({
      MessagesTable: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'MessagesTable' } },
    });
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('ResourceNotFoundException'); });

    expect(findExistingRetainedResources(templatePath, 'us-east-1')).toEqual([]);
  });

  test('sem resources retentáveis no template → não chama a AWS, retorna array vazio', () => {
    writeTemplate({ Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } });

    expect(findExistingRetainedResources(templatePath, 'us-east-1')).toEqual([]);
    expect(mockedCp.execFileSync).not.toHaveBeenCalled();
  });
});

describe('describeStackStatus', () => {
  beforeEach(() => jest.resetAllMocks());

  test('retorna deployed:true com o StackStatus nativo quando describe-stacks tem sucesso', () => {
    mockedCp.execFileSync.mockReturnValue('CREATE_COMPLETE\n' as any);
    expect(describeStackStatus('dynamodb-stack', 'us-east-1')).toEqual({ deployed: true, status: 'CREATE_COMPLETE' });
    expect(mockedCp.execFileSync).toHaveBeenCalledWith(
      'aws',
      ['cloudformation', 'describe-stacks', '--stack-name', 'dynamodb-stack', '--region', 'us-east-1', '--query', 'Stacks[0].StackStatus', '--output', 'text'],
      expect.anything()
    );
  });

  test('retorna deployed:false quando describe-stacks falha (stack não existe)', () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('does not exist'); });
    expect(describeStackStatus('dynamodb-stack', 'us-east-1')).toEqual({ deployed: false });
  });
});

describe('awsExecutor.describeStatus', () => {
  beforeEach(() => jest.resetAllMocks());

  test('delega pra describeStackStatus com a região do ctx', () => {
    mockedCp.execFileSync.mockReturnValue('CREATE_COMPLETE\n' as any);
    expect(awsExecutor.describeStatus!('dynamodb-stack', { region: 'us-east-1' })).toEqual({ deployed: true, status: 'CREATE_COMPLETE' });
  });
});

describe('awsExecutor.planDeploy', () => {
  let cwd: string;
  let templatePath: string;

  beforeEach(() => {
    jest.resetAllMocks();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-deploy-aws-'));
    templatePath = path.join(cwd, 'synth-out', 'aws', 'main-stack.json');
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  function mockAccountAndBucket(opts: { accountId?: string; bucketExists?: boolean } = {}) {
    const { accountId = '536068784882', bucketExists: exists = true } = opts;
    mockedCp.execFileSync.mockImplementation((bin: string, args?: readonly string[]) => {
      if (args?.includes('get-caller-identity')) return `${accountId}\n` as any;
      if (args?.includes('head-bucket')) {
        if (exists) return '' as any;
        throw new Error('404 Not Found');
      }
      return '' as any;
    });
  }

  function writeTemplate(resources: Record<string, unknown> = {}): void {
    fs.writeFileSync(templatePath, JSON.stringify({ AWSTemplateFormatVersion: '2010-09-09', Resources: resources }));
  }

  test('monta s3 mb (bucket ausente) + package + deploy, na ordem certa', async () => {
    mockAccountAndBucket({ bucketExists: false });
    writeTemplate();
    const ctx: DeployContext = { cwd, stackName: 'main-stack', templatePath, region: 'us-east-1' };

    const commands = await awsExecutor.planDeploy(ctx);

    expect(commands).toHaveLength(3);
    expect(commands[0].args).toEqual(['s3', 'mb', 's3://iacmp-deploy-artifacts-536068784882-us-east-1', '--region', 'us-east-1']);
    expect(commands[1].args).toEqual(
      expect.arrayContaining(['cloudformation', 'package', '--template-file', ctx.templatePath, '--s3-bucket', 'iacmp-deploy-artifacts-536068784882-us-east-1', '--region', 'us-east-1'])
    );
    expect(commands[2].args).toEqual(
      expect.arrayContaining(['cloudformation', 'deploy', '--stack-name', 'main-stack', '--region', 'us-east-1', '--no-fail-on-empty-changeset'])
    );
    expect(commands[2].args).toEqual(expect.arrayContaining(['--capabilities', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND']));
  });

  test('omite o `s3 mb` quando o bucket de artefatos já existe', async () => {
    mockAccountAndBucket({ bucketExists: true });
    writeTemplate();
    const ctx: DeployContext = { cwd, stackName: 'main-stack', templatePath, region: 'us-east-1' };

    const commands = await awsExecutor.planDeploy(ctx);

    expect(commands).toHaveLength(2);
    expect(commands[0].args).toEqual(expect.arrayContaining(['cloudformation', 'package']));
    expect(commands[1].args).toEqual(expect.arrayContaining(['cloudformation', 'deploy']));
  });

  test('o template-file do deploy é o output-template-file do package (mesmo arquivo)', async () => {
    mockAccountAndBucket({ bucketExists: true });
    writeTemplate();
    const ctx: DeployContext = { cwd, stackName: 'main-stack', templatePath, region: 'us-east-1' };

    const commands = await awsExecutor.planDeploy(ctx);
    const packageOutputIdx = commands[0].args.indexOf('--output-template-file');
    const deployTemplateIdx = commands[1].args.indexOf('--template-file');
    expect(commands[0].args[packageOutputIdx + 1]).toBe(commands[1].args[deployTemplateIdx + 1]);
  });

  test('cria o diretório .packaged/ antes de retornar (necessário pro --output-template-file)', async () => {
    mockAccountAndBucket({ bucketExists: true });
    writeTemplate();
    const ctx: DeployContext = { cwd, stackName: 'main-stack', templatePath, region: 'us-east-1' };

    await awsExecutor.planDeploy(ctx);

    expect(fs.existsSync(path.join(path.dirname(templatePath), '.packaged'))).toBe(true);
  });

  test('sem Function.Lambda no template → empacota o template original (sem reescrita)', async () => {
    mockAccountAndBucket({ bucketExists: true });
    writeTemplate({ Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } });
    const ctx: DeployContext = { cwd, stackName: 'main-stack', templatePath, region: 'us-east-1' };

    const commands = await awsExecutor.planDeploy(ctx);
    const templateFileIdx = commands[0].args.indexOf('--template-file');
    expect(commands[0].args[templateFileIdx + 1]).toBe(templatePath);
  });

  test('Code relativo (ex: "dist/") é reescrito para absoluto relativo a ctx.cwd, não ao diretório do template', async () => {
    mockAccountAndBucket({ bucketExists: true });
    writeTemplate({
      HelloFn: { Type: 'AWS::Lambda::Function', Properties: { Code: 'dist/' } },
    });
    const ctx: DeployContext = { cwd, stackName: 'main-stack', templatePath, region: 'us-east-1' };

    const commands = await awsExecutor.planDeploy(ctx);
    const templateFileIdx = commands[0].args.indexOf('--template-file');
    const inputTemplatePath = commands[0].args[templateFileIdx + 1] as string;

    // não reusa o template original — escreve um intermediário com Code absoluto
    expect(inputTemplatePath).not.toBe(templatePath);
    const rewritten = JSON.parse(fs.readFileSync(inputTemplatePath, 'utf-8'));
    expect(rewritten.Resources.HelloFn.Properties.Code).toBe(path.resolve(cwd, 'dist/'));
  });

  test('Code já absoluto → empacota o template original, sem reescrever', async () => {
    mockAccountAndBucket({ bucketExists: true });
    const absoluteCode = path.join(cwd, 'dist');
    writeTemplate({
      HelloFn: { Type: 'AWS::Lambda::Function', Properties: { Code: absoluteCode } },
    });
    const ctx: DeployContext = { cwd, stackName: 'main-stack', templatePath, region: 'us-east-1' };

    const commands = await awsExecutor.planDeploy(ctx);
    const templateFileIdx = commands[0].args.indexOf('--template-file');
    expect(commands[0].args[templateFileIdx + 1]).toBe(templatePath);
  });
});

describe('awsExecutor.planDestroy', () => {
  test('monta delete-stack seguido de wait stack-delete-complete', async () => {
    const ctx: DestroyContext = { cwd: '/tmp', stackName: 'main-stack', region: 'us-east-1' };
    const commands = await awsExecutor.planDestroy(ctx);

    expect(commands).toHaveLength(2);
    expect(commands[0].args).toEqual(['cloudformation', 'delete-stack', '--stack-name', 'main-stack', '--region', 'us-east-1']);
    expect(commands[1].args).toEqual(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', 'main-stack', '--region', 'us-east-1']);
  });
});
