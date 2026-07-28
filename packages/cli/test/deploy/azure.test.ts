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
  // Isola ~/.iacmp num diretório temporário — sem isso os testes leem/escrevem o
  // azure-bootstrap.json REAL da máquina (poluição entre testes e com o uso real do iacmp).
  let iacmpHome: string;
  let originalHome: string | undefined;
  beforeEach(() => {
    jest.resetAllMocks();
    originalHome = process.env.HOME;
    iacmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-home-'));
    process.env.HOME = iacmpHome; // os.homedir() não é mockável via spyOn (propriedade não-configurável)
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    fs.rmSync(iacmpHome, { recursive: true, force: true });
  });

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

  test('containerBuilds no meta → agenda remoção do repositório ACR (preRun), sem apagar o ACR inteiro', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-az-destroy-'));
    const templatePath = path.join(dir, 'app-stack.bicep');
    fs.writeFileSync(templatePath, '');
    fs.writeFileSync(
      path.join(dir, 'app-stack.iacmp-meta.json'),
      JSON.stringify({ containerBuilds: [{ constructId: 'App', imageParamName: 'appImage', repository: 'proj-app', tag: 'latest', context: 'services/app' }] }),
    );
    const ctx: DestroyContext = { cwd: dir, stackName: 'app-stack', region: 'eastus', resourceGroup: 'rg', templatePath };

    const commands = await azureExecutor.planDestroy(ctx);
    expect(commands).toHaveLength(2);
    expect(commands[0].args).toEqual(expect.arrayContaining(['stack', 'group', 'delete']));
    const lazyCmd = commands[1];
    expect(lazyCmd.preRun).toBeDefined();

    mockedCp.execFileSync.mockImplementation((file: any, args: any = []) => {
      if (file === 'az' && args[0] === 'account') return 'sub-1234-5678-9999\n' as any;
      return '' as any;
    });
    expect(() => lazyCmd.preRun!()).not.toThrow();
    expect(mockedCp.execFileSync).toHaveBeenCalledWith(
      'az',
      expect.arrayContaining(['acr', 'repository', 'delete', '--repository', 'proj-app', '--yes']),
      expect.anything(),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('containerBuilds + nome de ACR persistido (fallback usado num deploy anterior) → repo delete usa o nome persistido, não o determinístico', async () => {
    fs.mkdirSync(path.join(iacmpHome, '.iacmp'), { recursive: true });
    fs.writeFileSync(path.join(iacmpHome, '.iacmp', 'azure-bootstrap.json'), JSON.stringify({ acrName: 'iacmpacrsub123fallbackabc' }));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-az-destroy-'));
    const templatePath = path.join(dir, 'app-stack.bicep');
    fs.writeFileSync(templatePath, '');
    fs.writeFileSync(
      path.join(dir, 'app-stack.iacmp-meta.json'),
      JSON.stringify({ containerBuilds: [{ constructId: 'App', imageParamName: 'appImage', repository: 'proj-app', tag: 'latest', context: 'services/app' }] }),
    );
    const ctx: DestroyContext = { cwd: dir, stackName: 'app-stack', region: 'eastus', resourceGroup: 'rg', templatePath };
    const commands = await azureExecutor.planDestroy(ctx);
    const lazyCmd = commands[1];

    mockedCp.execFileSync.mockImplementation((file: any, args: any = []) => {
      if (file === 'az' && args[0] === 'account') return 'sub-nao-deveria-ser-usado\n' as any;
      return '' as any;
    });
    lazyCmd.preRun!();
    expect(mockedCp.execFileSync).toHaveBeenCalledWith(
      'az',
      expect.arrayContaining(['acr', 'repository', 'delete', '--name', 'iacmpacrsub123fallbackabc']),
      expect.anything(),
    );
    // Nunca chamou `az account show` — o nome persistido já resolveu tudo sem precisar da subscription.
    expect(mockedCp.execFileSync).not.toHaveBeenCalledWith('az', expect.arrayContaining(['account', 'show']), expect.anything());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('sem containerBuilds no meta → só o comando de delete da stack (nada de ACR)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-az-destroy-'));
    const templatePath = path.join(dir, 'app-stack.bicep');
    fs.writeFileSync(templatePath, '');
    const ctx: DestroyContext = { cwd: dir, stackName: 'app-stack', region: 'eastus', resourceGroup: 'rg', templatePath };
    const commands = await azureExecutor.planDestroy(ctx);
    expect(commands).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('azureExecutor.planDeploy — Compute.Container com build (pipeline ACR)', () => {
  // Isola ~/.iacmp num diretório temporário — sem isso os testes leem/escrevem o
  // azure-bootstrap.json REAL da máquina (poluição entre testes e com o uso real do iacmp).
  let iacmpHome: string;
  let originalHome: string | undefined;
  beforeEach(() => {
    jest.resetAllMocks();
    originalHome = process.env.HOME;
    iacmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-home-'));
    process.env.HOME = iacmpHome; // os.homedir() não é mockável via spyOn (propriedade não-configurável)
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    fs.rmSync(iacmpHome, { recursive: true, force: true });
  });

  function writeBuildProject(dir: string, stackFile: string): string {
    const templatePath = path.join(dir, stackFile);
    fs.writeFileSync(
      templatePath,
      "param location string = resourceGroup().location\nparam appImage string = 'node:20-alpine'\nparam acrServer string = ''\nparam acrUser string = ''\n@secure()\nparam acrPassword string = ''\n",
    );
    fs.mkdirSync(path.join(dir, 'services', 'app'), { recursive: true });
    fs.writeFileSync(
      templatePath.replace(/\.bicep$/, '.iacmp-meta.json'),
      JSON.stringify({
        functions: [],
        containerBuilds: [{ constructId: 'App', imageParamName: 'appImage', repository: 'proj-app', tag: 'latest', context: 'services/app' }],
      }),
    );
    return templatePath;
  }

  test('Docker local disponível → docker build/push + acrServer/acrUser/<param>Image injetados como parâmetro', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-az-build-'));
    const templatePath = writeBuildProject(dir, 'app-stack.bicep');

    mockedCp.execFileSync.mockImplementation((file: any, args: any = []) => {
      if (file === 'az' && args[0] === 'account') return 'sub-123456789999\n' as any;
      if (file === 'az' && args[0] === 'group' && args[1] === 'exists') return 'true\n' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show' && args.includes('loginServer')) {
        return 'iacmpacrsub123456789.azurecr.io\n' as any;
      }
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show') return 'iacmpacrsub123456789\n' as any; // acrExists: já existe
      if (file === 'az' && args[0] === 'acr' && args[1] === 'update') return '' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'credential') return JSON.stringify({ username: 'acruser', password: 'acrpass' }) as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'login') return '' as any;
      if (file === 'docker' && args[0] === 'version') return '28.5.1\n' as any;
      if (file === 'docker') return '' as any;
      return '' as any;
    });

    const ctx: DeployContext = { cwd: dir, stackName: 'app-stack', templatePath, region: 'eastus', resourceGroup: 'rg' };
    const commands = await azureExecutor.planDeploy(ctx);

    const stackCmd = commands.find(c => c.bin === 'az' && c.args[0] === 'stack')!;
    const argsStr = stackCmd.args.join(' ');
    expect(argsStr).toContain('acrServer=iacmpacrsub123456789.azurecr.io');
    expect(argsStr).toContain('acrUser=acruser');
    expect(argsStr).toContain('appImage=iacmpacrsub123456789.azurecr.io/proj-app:latest');
    // acrPassword é secret — nunca na linha de comando (vai por @arquivo)
    expect(argsStr).not.toContain('acrpass');

    expect(mockedCp.execFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['build', '--platform', 'linux/amd64', '-t', 'iacmpacrsub123456789.azurecr.io/proj-app:latest']),
      expect.anything(),
    );
    expect(mockedCp.execFileSync).toHaveBeenCalledWith(
      'docker',
      ['push', 'iacmpacrsub123456789.azurecr.io/proj-app:latest'],
      expect.anything(),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Docker instalado mas daemon parado → erro explícito (NUNCA cai silenciosamente em ACR Tasks)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-az-build-'));
    const templatePath = writeBuildProject(dir, 'app-stack.bicep');

    mockedCp.execFileSync.mockImplementation((file: any, args: any = []) => {
      if (file === 'az' && args[0] === 'account') return 'sub-123456789999\n' as any;
      if (file === 'az' && args[0] === 'group' && args[1] === 'exists') return 'true\n' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show' && args.includes('loginServer')) {
        return 'iacmpacrsub123456789.azurecr.io\n' as any;
      }
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show') return 'iacmpacrsub123456789\n' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'update') return '' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'credential') return JSON.stringify({ username: 'acruser', password: 'acrpass' }) as any;
      if (file === 'docker') throw new Error('daemon not running');
      return '' as any;
    });
    mockedCp.spawnSync.mockReturnValue({ status: 0 } as any); // `docker --version` funciona → instalado, só o daemon está parado

    const ctx: DeployContext = { cwd: dir, stackName: 'app-stack', templatePath, region: 'eastus', resourceGroup: 'rg' };
    await expect(azureExecutor.planDeploy(ctx)).rejects.toThrow(/Docker Desktop/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Docker não instalado → fallback ACR Tasks (best-effort); bloqueio conhecido vira erro claro citando a subscription', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-az-build-'));
    const templatePath = writeBuildProject(dir, 'app-stack.bicep');

    mockedCp.execFileSync.mockImplementation((file: any, args: any = []) => {
      if (file === 'az' && args[0] === 'account') return 'sub-123456789999\n' as any;
      if (file === 'az' && args[0] === 'group' && args[1] === 'exists') return 'true\n' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show' && args.includes('loginServer')) {
        return 'iacmpacrsub123456789.azurecr.io\n' as any;
      }
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show') return 'iacmpacrsub123456789\n' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'update') return '' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'credential') return JSON.stringify({ username: 'acruser', password: 'acrpass' }) as any;
      if (file === 'docker' && args[0] === 'version') throw new Error('docker not found');
      if (file === 'az' && args[0] === 'acr' && args[1] === 'build') {
        const err = new Error('Command failed') as Error & { stderr?: Buffer };
        err.stderr = Buffer.from('ERROR: TasksOperationsNotAllowed: Tasks operations are not allowed for this subscription.');
        throw err;
      }
      return '' as any;
    });
    mockedCp.spawnSync.mockReturnValue({ status: 1 } as any); // `docker --version` também falha → não instalado

    const ctx: DeployContext = { cwd: dir, stackName: 'app-stack', templatePath, region: 'eastus', resourceGroup: 'rg' };
    await expect(azureExecutor.planDeploy(ctx)).rejects.toThrow(/TasksOperationsNotAllowed|subscription/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// Bug real de bateria: o nome de ACR determinístico (iacmpacr<subId[:12]>) pode estar
// reservado no namespace GLOBAL azurecr.io fora da nossa visão (outra subscription, um
// registro já purgado, etc.) — `az acr create` falha pra sempre com RegistryNameAlreadyInUse
// mesmo o nosso resource group nunca tendo tido esse ACR. Os 3 caminhos abaixo cobrem a
// correção: nome persistido tem prioridade, fallback com sufixo quando o determinístico
// está indisponível (e persiste a escolha), e corrida entre processos concorrentes.
describe('ensureBootstrapAcr — persistência, fallback de nome e corrida entre deploys concorrentes', () => {
  let iacmpHome: string;
  let originalHome: string | undefined;
  let dir: string;
  let templatePath: string;

  beforeEach(() => {
    jest.resetAllMocks();
    originalHome = process.env.HOME;
    iacmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-home-'));
    process.env.HOME = iacmpHome; // os.homedir() não é mockável via spyOn (propriedade não-configurável)

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-az-build-'));
    templatePath = path.join(dir, 'app-stack.bicep');
    fs.writeFileSync(
      templatePath,
      "param location string = resourceGroup().location\nparam appImage string = 'node:20-alpine'\nparam acrServer string = ''\nparam acrUser string = ''\n@secure()\nparam acrPassword string = ''\n",
    );
    fs.mkdirSync(path.join(dir, 'services', 'app'), { recursive: true });
    fs.writeFileSync(
      templatePath.replace(/\.bicep$/, '.iacmp-meta.json'),
      JSON.stringify({
        functions: [],
        containerBuilds: [{ constructId: 'App', imageParamName: 'appImage', repository: 'proj-app', tag: 'latest', context: 'services/app' }],
      }),
    );

    mockedCp.spawnSync.mockReturnValue({ status: 0 } as any); // não usado nesses testes (Docker sempre "available")
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    fs.rmSync(iacmpHome, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('nome persistido em ~/.iacmp/azure-bootstrap.json tem prioridade — reusa direto, sem check-name nem create', async () => {
    fs.mkdirSync(path.join(iacmpHome, '.iacmp'), { recursive: true });
    fs.writeFileSync(path.join(iacmpHome, '.iacmp', 'azure-bootstrap.json'), JSON.stringify({ acrName: 'iacmpacrpersisted99' }));

    mockedCp.execFileSync.mockImplementation((file: any, args: any = []) => {
      if (file === 'az' && args[0] === 'account') return 'sub-123456789999\n' as any;
      if (file === 'az' && args[0] === 'group' && args[1] === 'exists') return 'true\n' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show' && args.includes('loginServer')) {
        return 'iacmpacrpersisted99.azurecr.io\n' as any;
      }
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show') return 'iacmpacrpersisted99\n' as any; // já é nosso → reusa
      if (file === 'az' && args[0] === 'acr' && args[1] === 'update') return '' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'credential') return JSON.stringify({ username: 'acruser', password: 'acrpass' }) as any;
      if (file === 'docker' && args[0] === 'version') return '28.5.1\n' as any;
      if (file === 'docker') return '' as any;
      return '' as any;
    });

    const ctx: DeployContext = { cwd: dir, stackName: 'app-stack', templatePath, region: 'eastus', resourceGroup: 'rg' };
    const commands = await azureExecutor.planDeploy(ctx);
    const stackCmd = commands.find(c => c.bin === 'az' && c.args[0] === 'stack')!;
    expect(stackCmd.args.join(' ')).toContain('acrServer=iacmpacrpersisted99.azurecr.io');

    expect(mockedCp.execFileSync).not.toHaveBeenCalledWith('az', expect.arrayContaining(['acr', 'check-name']), expect.anything());
    expect(mockedCp.execFileSync).not.toHaveBeenCalledWith('az', expect.arrayContaining(['acr', 'create']), expect.anything());
  });

  test('nome determinístico indisponível globalmente (check-name diz não, e não é nosso) → gera fallback com sufixo e PERSISTE a escolha', async () => {
    mockedCp.execFileSync.mockImplementation((file: any, args: any = []) => {
      if (file === 'az' && args[0] === 'account') return 'sub-123456789999\n' as any;
      if (file === 'az' && args[0] === 'group' && args[1] === 'exists') return 'true\n' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show' && args.includes('loginServer')) {
        const name = args[args.indexOf('--name') + 1];
        return `${name}.azurecr.io\n` as any;
      }
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show') {
        throw new Error('ResourceNotFound'); // nunca é nosso, nem o determinístico nem o fallback
      }
      if (file === 'az' && args[0] === 'acr' && args[1] === 'check-name') {
        const name = args[args.indexOf('--name') + 1];
        // determinístico indisponível (de terceiros); qualquer fallback com sufixo está livre
        return (name === 'iacmpacrsub123456789' ? 'false' : 'true') as any;
      }
      if (file === 'az' && args[0] === 'acr' && args[1] === 'create') return '' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'credential') return JSON.stringify({ username: 'acruser', password: 'acrpass' }) as any;
      if (file === 'docker' && args[0] === 'version') return '28.5.1\n' as any;
      if (file === 'docker') return '' as any;
      return '' as any;
    });

    const ctx: DeployContext = { cwd: dir, stackName: 'app-stack', templatePath, region: 'eastus', resourceGroup: 'rg' };
    const commands = await azureExecutor.planDeploy(ctx);

    const state = JSON.parse(fs.readFileSync(path.join(iacmpHome, '.iacmp', 'azure-bootstrap.json'), 'utf-8')) as { acrName: string };
    expect(state.acrName.startsWith('iacmpacrsub123456789')).toBe(true);
    expect(state.acrName.length).toBeGreaterThan('iacmpacrsub123456789'.length);

    const stackCmd = commands.find(c => c.bin === 'az' && c.args[0] === 'stack')!;
    expect(stackCmd.args.join(' ')).toContain(`acrServer=${state.acrName}.azurecr.io`);
  });

  test('corrida entre processos: create falha com RegistryNameAlreadyInUse mas outro deploy já criou no NOSSO resource group → reusa (sem erro, sem fallback)', async () => {
    let acrShowCalls = 0;
    mockedCp.execFileSync.mockImplementation((file: any, args: any = []) => {
      if (file === 'az' && args[0] === 'account') return 'sub-123456789999\n' as any;
      if (file === 'az' && args[0] === 'group' && args[1] === 'exists') return 'true\n' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show' && args.includes('loginServer')) {
        return 'iacmpacrsub123456789.azurecr.io\n' as any;
      }
      if (file === 'az' && args[0] === 'acr' && args[1] === 'show') {
        acrShowCalls += 1;
        if (acrShowCalls === 1) throw new Error('ResourceNotFound'); // 1ª checagem: ainda não existe
        return 'iacmpacrsub123456789\n' as any; // 2ª checagem (pós-corrida): outro processo criou nesse meio-tempo
      }
      if (file === 'az' && args[0] === 'acr' && args[1] === 'check-name') return 'true\n' as any; // disponível no momento do check
      if (file === 'az' && args[0] === 'acr' && args[1] === 'create') {
        const err = new Error('Command failed') as Error & { stderr?: Buffer };
        err.stderr = Buffer.from('(RegistryNameAlreadyInUse) The registry name is already in use.');
        throw err;
      }
      if (file === 'az' && args[0] === 'acr' && args[1] === 'update') return '' as any;
      if (file === 'az' && args[0] === 'acr' && args[1] === 'credential') return JSON.stringify({ username: 'acruser', password: 'acrpass' }) as any;
      if (file === 'docker' && args[0] === 'version') return '28.5.1\n' as any;
      if (file === 'docker') return '' as any;
      return '' as any;
    });

    const ctx: DeployContext = { cwd: dir, stackName: 'app-stack', templatePath, region: 'eastus', resourceGroup: 'rg' };
    const commands = await azureExecutor.planDeploy(ctx);
    const stackCmd = commands.find(c => c.bin === 'az' && c.args[0] === 'stack')!;
    expect(stackCmd.args.join(' ')).toContain('acrServer=iacmpacrsub123456789.azurecr.io');

    const state = JSON.parse(fs.readFileSync(path.join(iacmpHome, '.iacmp', 'azure-bootstrap.json'), 'utf-8')) as { acrName: string };
    expect(state.acrName).toBe('iacmpacrsub123456789'); // resolveu pro MESMO nome determinístico — corrida, não fallback
  });
});
