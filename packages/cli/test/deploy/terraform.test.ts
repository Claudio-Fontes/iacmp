import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { terraformExecutor } from '../../src/deploy/terraform';
import { DeployContext, DestroyContext } from '../../src/deploy/types';

describe('terraformExecutor.planDeploy', () => {
  let cwd: string;
  let tfDir: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-deploy-tf-'));
    tfDir = path.join(cwd, 'synth-out', 'terraform');
    fs.mkdirSync(tfDir, { recursive: true });
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  test('escreve _provider.tf com a região configurada', async () => {
    const ctx: DeployContext = { cwd, stackName: 'iacmp', templatePath: '', region: 'us-west-2' };
    await terraformExecutor.planDeploy(ctx);

    const content = fs.readFileSync(path.join(tfDir, '_provider.tf'), 'utf-8');
    expect(content).toContain('provider "aws"');
    expect(content).toContain('region = "us-west-2"');
  });

  test('retorna init seguido de apply, ambos no diretório synth-out/terraform/', async () => {
    const ctx: DeployContext = { cwd, stackName: 'iacmp', templatePath: '', region: 'us-east-1' };
    const commands = await terraformExecutor.planDeploy(ctx);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({ bin: 'terraform', args: ['init', '-input=false'], cwd: tfDir });
    expect(commands[1]).toEqual({ bin: 'terraform', args: ['apply', '-auto-approve'], cwd: tfDir });
  });
});

describe('terraformExecutor.planDestroy', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-deploy-tf-destroy-'));
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  test('retorna init seguido de destroy, no diretório synth-out/terraform/', async () => {
    const ctx: DestroyContext = { cwd, stackName: 'iacmp', region: 'us-east-1' };
    const commands = await terraformExecutor.planDestroy(ctx);

    const tfDir = path.join(cwd, 'synth-out', 'terraform');
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({ bin: 'terraform', args: ['init', '-input=false'], cwd: tfDir });
    expect(commands[1]).toEqual({ bin: 'terraform', args: ['destroy', '-auto-approve'], cwd: tfDir });
  });
});
