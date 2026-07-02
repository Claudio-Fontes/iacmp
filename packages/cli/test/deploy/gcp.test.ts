jest.mock('child_process');
jest.mock('fs');

import * as cp from 'child_process';
import * as fs from 'fs';
import { gcpExecutor, resolveProjectId } from '../../src/deploy/gcp';
import { DeployContext, DestroyContext } from '../../src/deploy/types';

const mockedCp = cp as jest.Mocked<typeof cp>;
const mockedFs = fs as jest.Mocked<typeof fs>;

describe('resolveProjectId', () => {
  beforeEach(() => jest.resetAllMocks());

  test('usa o projectId configurado quando fornecido, sem chamar gcloud', () => {
    expect(resolveProjectId('meu-projeto')).toBe('meu-projeto');
    expect(mockedCp.execFileSync).not.toHaveBeenCalled();
  });

  test('cai para `gcloud config get-value project` quando não configurado', () => {
    mockedCp.execFileSync.mockReturnValue('projeto-default\n' as any);
    expect(resolveProjectId(undefined)).toBe('projeto-default');
  });

  test('lança erro claro quando gcloud também não tem projeto configurado', () => {
    mockedCp.execFileSync.mockReturnValue('(unset)\n' as any);
    expect(() => resolveProjectId(undefined)).toThrow('projectId');
  });

  test('lança erro claro quando o comando gcloud falha', () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('gcloud not found'); });
    expect(() => resolveProjectId(undefined)).toThrow('projectId');
  });
});

describe('gcpExecutor.describeStatus', () => {
  test('sempre retorna deployed:false (terraform state não é por stack)', () => {
    expect(gcpExecutor.describeStatus!('main-stack', {})).toEqual({ deployed: false });
  });
});

describe('gcpExecutor.planDeploy', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedFs.writeFileSync.mockImplementation(() => undefined);
    mockedFs.existsSync.mockReturnValue(true);
  });

  test('monta terraform init + apply com project_id e region', async () => {
    const ctx: DeployContext = {
      cwd: '/tmp',
      stackName: 'main-stack',
      templatePath: '/tmp/x.tf.json',
      region: 'us-central1',
      projectId: 'meu-projeto',
    };

    const commands = await gcpExecutor.planDeploy(ctx);

    expect(commands).toHaveLength(2);
    expect(commands[0].bin).toBe('terraform');
    expect(commands[0].args).toContain('init');
    expect(commands[1].bin).toBe('terraform');
    expect(commands[1].args).toContain('apply');
    expect(commands[1].args.join(' ')).toContain('project_id=meu-projeto');
    expect(commands[1].args.join(' ')).toContain('gcp_region=us-central1');
  });
});

describe('gcpExecutor.planDestroy', () => {
  beforeEach(() => jest.resetAllMocks());

  test('monta terraform init + destroy com project_id', async () => {
    const ctx: DestroyContext = {
      cwd: '/tmp',
      stackName: 'main-stack',
      region: 'us-central1',
      projectId: 'meu-projeto',
    };

    const commands = await gcpExecutor.planDestroy(ctx);

    expect(commands).toHaveLength(2);
    expect(commands[0].args).toContain('init');
    expect(commands[1].args).toContain('destroy');
    expect(commands[1].args.join(' ')).toContain('project_id=meu-projeto');
  });
});
