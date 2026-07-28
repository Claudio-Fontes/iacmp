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
    tfDir = path.join(cwd, 'synth-out', 'aws-tf');
    fs.mkdirSync(tfDir, { recursive: true });
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  test('remove o _provider.tf legado (o _providers.tf.json do synth já tem o provider)', async () => {
    fs.writeFileSync(path.join(tfDir, '_provider.tf'), 'provider "aws" {}');
    const ctx: DeployContext = { cwd, stackName: 'iacmp', templatePath: '', region: 'us-west-2' };
    await terraformExecutor.planDeploy(ctx);

    expect(fs.existsSync(path.join(tfDir, '_provider.tf'))).toBe(false);
  });

  test('retorna init seguido de apply com -var aws_region, ambos em synth-out/aws-tf/', async () => {
    const ctx: DeployContext = { cwd, stackName: 'iacmp', templatePath: '', region: 'us-east-1' };
    const commands = await terraformExecutor.planDeploy(ctx);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({ bin: 'terraform', args: ['init', '-input=false'], cwd: tfDir });
    expect(commands[1]).toEqual({ bin: 'terraform', args: ['apply', '-auto-approve', '-var', 'aws_region=us-east-1'], cwd: tfDir });
  });
});

describe('terraformExecutor.planDestroy', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-deploy-tf-destroy-'));
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  test('retorna init seguido de destroy com -var aws_region, em synth-out/aws-tf/', async () => {
    const ctx: DestroyContext = { cwd, stackName: 'iacmp', region: 'us-east-1' };
    const commands = await terraformExecutor.planDestroy(ctx);

    const tfDir = path.join(cwd, 'synth-out', 'aws-tf');
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({ bin: 'terraform', args: ['init', '-input=false'], cwd: tfDir });
    expect(commands[1]).toEqual({ bin: 'terraform', args: ['destroy', '-auto-approve', '-var', 'aws_region=us-east-1'], cwd: tfDir });
  });
});
