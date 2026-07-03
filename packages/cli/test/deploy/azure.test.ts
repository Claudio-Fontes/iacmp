jest.mock('child_process');

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { azureExecutor, resourceGroupExists, describeStackStatus } from '../../src/deploy/azure';
import { DeployContext, DestroyContext } from '../../src/deploy/types';

const mockedCp = cp as jest.Mocked<typeof cp>;

describe('resourceGroupExists', () => {
  beforeEach(() => jest.resetAllMocks());

  test('retorna true quando `az group exists` imprime "true"', () => {
    mockedCp.execFileSync.mockReturnValue('true\n' as any);
    expect(resourceGroupExists('meu-rg')).toBe(true);
  });

  test('retorna false quando `az group exists` imprime "false"', () => {
    mockedCp.execFileSync.mockReturnValue('false\n' as any);
    expect(resourceGroupExists('meu-rg')).toBe(false);
  });

  test('retorna false quando o comando falha (az ausente, etc.)', () => {
    mockedCp.execFileSync.mockImplementation(() => {
      throw new Error('az not found');
    });
    expect(resourceGroupExists('meu-rg')).toBe(false);
  });
});

describe('describeStackStatus', () => {
  beforeEach(() => jest.resetAllMocks());

  test('retorna deployed:true com provisioningState quando `az stack group show` tem sucesso', () => {
    mockedCp.execFileSync.mockReturnValue('Succeeded\n' as any);
    expect(describeStackStatus('main-stack', 'meu-rg')).toEqual({ deployed: true, status: 'Succeeded' });
  });

  test('retorna deployed:false quando o comando falha (stack não existe)', () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('not found'); });
    expect(describeStackStatus('main-stack', 'meu-rg')).toEqual({ deployed: false });
  });
});

describe('azureExecutor.describeStatus', () => {
  beforeEach(() => jest.resetAllMocks());

  test('sem resourceGroup no ctx → deployed:false sem chamar az', () => {
    expect(azureExecutor.describeStatus!('main-stack', {})).toEqual({ deployed: false });
    expect(mockedCp.execFileSync).not.toHaveBeenCalled();
  });

  test('com resourceGroup → delega pra describeStackStatus', () => {
    mockedCp.execFileSync.mockReturnValue('Succeeded\n' as any);
    expect(azureExecutor.describeStatus!('main-stack', { resourceGroup: 'meu-rg' })).toEqual({ deployed: true, status: 'Succeeded' });
  });
});

describe('azureExecutor.planDeploy', () => {
  test('monta `az stack group create` com resource group e template corretos', async () => {
    const ctx: DeployContext = {
      cwd: '/tmp',
      stackName: 'main-stack',
      templatePath: '/tmp/synth-out/azure/main-stack.json',
      region: 'eastus',
      resourceGroup: 'meu-rg',
    };

    const commands = await azureExecutor.planDeploy(ctx);

    expect(commands).toHaveLength(1);
    expect(commands[0].bin).toBe('az');
    expect(commands[0].args).toEqual(
      expect.arrayContaining(['stack', 'group', 'create', '--name', 'main-stack', '--resource-group', 'meu-rg', '--template-file', ctx.templatePath])
    );
  });

  test('lança erro claro quando resourceGroup não está configurado', async () => {
    const ctx: DeployContext = { cwd: '/tmp', stackName: 'main-stack', templatePath: '/tmp/x.json', region: 'eastus' };
    await expect(azureExecutor.planDeploy(ctx)).rejects.toThrow('resourceGroup');
  });

  test('param cross-stack casa com output em camelCase (Azure devolve itemsTableName p/ ItemsTableName)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-az-'));
    const templatePath = path.join(dir, 'api-stack.bicep');
    fs.writeFileSync(templatePath, 'param location string = resourceGroup().location\nparam ItemsTableName string\n');
    const ctx: DeployContext = {
      cwd: dir, stackName: 'api-stack', templatePath, region: 'westus', resourceGroup: 'rg',
      outputParams: { itemsTableName: 'itemstable' }, // camelCase, como o `az stack group show` devolve
    };

    const commands = await azureExecutor.planDeploy(ctx);
    const az = commands.find(c => c.bin === 'az')!;
    expect(az.args).toEqual(expect.arrayContaining(['--parameters', 'ItemsTableName=itemstable']));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('param cross-stack SEM output correspondente → erro claro (nunca prompt interativo)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-az-'));
    const templatePath = path.join(dir, 'api-stack.bicep');
    fs.writeFileSync(templatePath, 'param ItemsTableName string\n');
    const ctx: DeployContext = {
      cwd: dir, stackName: 'api-stack', templatePath, region: 'westus', resourceGroup: 'rg',
      outputParams: {},
    };
    await expect(azureExecutor.planDeploy(ctx)).rejects.toThrow('ItemsTableName');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('azureExecutor.planDestroy', () => {
  test('monta `az stack group delete` com --action-on-unmanage deleteAll', async () => {
    const ctx: DestroyContext = { cwd: '/tmp', stackName: 'main-stack', region: 'eastus', resourceGroup: 'meu-rg' };
    const commands = await azureExecutor.planDestroy(ctx);

    expect(commands).toHaveLength(1);
    expect(commands[0].args).toEqual(
      expect.arrayContaining(['stack', 'group', 'delete', '--name', 'main-stack', '--resource-group', 'meu-rg', '--action-on-unmanage', 'deleteAll'])
    );
  });

  test('lança erro claro quando resourceGroup não está configurado', async () => {
    const ctx: DestroyContext = { cwd: '/tmp', stackName: 'main-stack', region: 'eastus' };
    await expect(azureExecutor.planDestroy(ctx)).rejects.toThrow('resourceGroup');
  });
});
