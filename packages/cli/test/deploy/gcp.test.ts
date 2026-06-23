jest.mock('child_process');

import * as cp from 'child_process';
import { gcpExecutor, resolveProjectId, deploymentExists } from '../../src/deploy/gcp';
import { DeployContext, DestroyContext } from '../../src/deploy/types';

const mockedCp = cp as jest.Mocked<typeof cp>;

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

describe('deploymentExists', () => {
  beforeEach(() => jest.resetAllMocks());

  test('retorna true quando describe tem sucesso', () => {
    mockedCp.execFileSync.mockReturnValue('' as any);
    expect(deploymentExists('main-stack', 'meu-projeto')).toBe(true);
  });

  test('retorna false quando describe falha (deployment não existe)', () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('not found'); });
    expect(deploymentExists('main-stack', 'meu-projeto')).toBe(false);
  });
});

describe('gcpExecutor.describeStatus', () => {
  beforeEach(() => jest.resetAllMocks());

  test('deployment existe → deployed:true', () => {
    mockedCp.execFileSync.mockReturnValue('' as any);
    expect(gcpExecutor.describeStatus!('main-stack', { projectId: 'meu-projeto' })).toEqual({ deployed: true });
  });

  test('deployment não existe → deployed:false', () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('not found'); });
    expect(gcpExecutor.describeStatus!('main-stack', { projectId: 'meu-projeto' })).toEqual({ deployed: false });
  });

  test('sem projectId resolvível → deployed:false, sem lançar', () => {
    mockedCp.execFileSync.mockReturnValue('(unset)\n' as any);
    expect(gcpExecutor.describeStatus!('main-stack', {})).toEqual({ deployed: false });
  });
});

describe('gcpExecutor.planDeploy', () => {
  beforeEach(() => jest.resetAllMocks());

  test('usa "create" quando o deployment ainda não existe', async () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('not found'); });
    const ctx: DeployContext = { cwd: '/tmp', stackName: 'main-stack', templatePath: '/tmp/x.json', region: 'us-central1', projectId: 'meu-projeto' };

    const commands = await gcpExecutor.planDeploy(ctx);

    expect(commands).toHaveLength(1);
    expect(commands[0].args).toEqual(
      expect.arrayContaining(['deployment-manager', 'deployments', 'create', 'main-stack', '--config', ctx.templatePath, '--project', 'meu-projeto'])
    );
  });

  test('usa "update" quando o deployment já existe', async () => {
    mockedCp.execFileSync.mockReturnValue('' as any); // describe tem sucesso
    const ctx: DeployContext = { cwd: '/tmp', stackName: 'main-stack', templatePath: '/tmp/x.json', region: 'us-central1', projectId: 'meu-projeto' };

    const commands = await gcpExecutor.planDeploy(ctx);

    expect(commands[0].args).toEqual(
      expect.arrayContaining(['deployment-manager', 'deployments', 'update', 'main-stack'])
    );
  });
});

describe('gcpExecutor.planDestroy', () => {
  test('monta deployments delete com --quiet', async () => {
    const ctx: DestroyContext = { cwd: '/tmp', stackName: 'main-stack', region: 'us-central1', projectId: 'meu-projeto' };
    const commands = await gcpExecutor.planDestroy(ctx);

    expect(commands).toHaveLength(1);
    expect(commands[0].args).toEqual(['deployment-manager', 'deployments', 'delete', 'main-stack', '--project', 'meu-projeto', '--quiet']);
  });
});
