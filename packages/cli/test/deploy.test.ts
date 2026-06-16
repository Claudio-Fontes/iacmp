import { runCli, makeProject, rmrf, exists } from './helpers';

/**
 * Cobertura do comando `deploy` (src/commands/deploy.ts).
 *
 * O deploy é um dry-run no MVP: ele NÃO sintetiza — apenas LÊ os templates já
 * gravados em `synth-out/<provider>/` por um `synth` anterior, conta os recursos
 * de cada stack e imprime "Would deploy N resource(s)" (ou "Would apply N
 * resource(s)" para terraform). Por isso todo caso feliz roda `synth` antes.
 *
 * As contagens por provider são determinísticas para uma stack VPC+Bucket e foram
 * observadas rodando o binário real:
 *   aws=12, azure=3, gcp=2, terraform=4.
 * (VPC sozinha em aws=11, Bucket sozinho em aws=1 — usado nos testes multi-stack.)
 */

// Stack só com VPC (aws => 11 recursos).
function vpcStackJs(name = 'net-stack'): string {
  return `const { Stack, Network } = require('@iacmp/core');
const stack = new Stack('${name}');
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });
module.exports = stack;
`;
}

// Stack só com Bucket (aws => 1 recurso).
function bucketStackJs(name = 'data-stack'): string {
  return `const { Stack, Storage } = require('@iacmp/core');
const stack = new Stack('${name}');
new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });
module.exports = stack;
`;
}

describe('deploy — caso feliz por provider (synth antes)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('aws: conta 12 recursos e imprime "Would deploy ... to AWS"', () => {
    dir = makeProject({ provider: 'aws' });

    const synth = runCli(['synth', '--provider', 'aws'], { cwd: dir });
    expect(synth.status).toBe(0);
    expect(exists(dir, 'synth-out/aws/main-stack.json')).toBe(true);

    const r = runCli(['deploy', '--provider', 'aws'], { cwd: dir });
    expect(r.status).toBe(0);
    // ecoa a stack e a contagem por stack
    expect(r.stdout).toContain('Stack: main-stack — 12 recurso(s)');
    // resumo total + label do provider
    expect(r.stdout).toContain('Would deploy 12 resource(s) to AWS (CloudFormation)');
    // dry-run: nada de "apply" no caminho não-terraform
    expect(r.stdout).not.toContain('Would apply');
    // banner de MVP (CLI-05): no início e no fim
    expect(r.stdout).toContain('MVP: deploy/destroy real ainda não implementado nesta fase');
    expect(r.stdout).toContain('(MVP: deploy real não implementado nesta fase)');
  });

  test('azure: conta 3 recursos e usa label ARM Template', () => {
    dir = makeProject({ provider: 'azure' });
    expect(runCli(['synth', '--provider', 'azure'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'azure'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: main-stack — 3 recurso(s)');
    expect(r.stdout).toContain('Would deploy 3 resource(s) to Azure (ARM Template)');
  });

  test('gcp: conta 2 recursos e usa label Deployment Manager', () => {
    dir = makeProject({ provider: 'gcp' });
    expect(runCli(['synth', '--provider', 'gcp'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'gcp'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: main-stack — 2 recurso(s)');
    expect(r.stdout).toContain('Would deploy 2 resource(s) to GCP (Deployment Manager)');
  });

  test('terraform: conta 4 recursos e imprime "Would apply" (não "deploy")', () => {
    dir = makeProject({ provider: 'terraform' });
    const synth = runCli(['synth', '--provider', 'terraform'], { cwd: dir });
    expect(synth.status).toBe(0);
    // terraform grava .tf, não .json
    expect(exists(dir, 'synth-out/terraform/main-stack.tf')).toBe(true);

    const r = runCli(['deploy', '--provider', 'terraform'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: main-stack — 4 recurso(s)');
    expect(r.stdout).toContain('Would apply 4 resource(s) (Terraform)');
    // o caminho terraform NÃO usa o verbo "Would deploy"
    expect(r.stdout).not.toContain('Would deploy');
  });
});

describe('deploy — provider default vem do iacmp.json', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('sem --provider, usa o provider do config (aws)', () => {
    dir = makeProject({ provider: 'aws' });
    // synth precisa do mesmo provider para gravar os templates
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Sintetizando stacks para aws...');
    expect(r.stdout).toContain('Would deploy 12 resource(s) to AWS (CloudFormation)');
  });
});

describe('deploy — múltiplas stacks e filtro --stack', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('soma recursos de todas as stacks no total (11 + 1 = 12)', () => {
    dir = makeProject({
      provider: 'aws',
      stacks: {
        'net-stack.js': vpcStackJs('net-stack'),
        'data-stack.js': bucketStackJs('data-stack'),
      },
    });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'aws'], { cwd: dir });
    expect(r.status).toBe(0);
    // ambas as stacks aparecem na listagem
    expect(r.stdout).toContain('Stack: net-stack — 11 recurso(s)');
    expect(r.stdout).toContain('Stack: data-stack — 1 recurso(s)');
    // total é a soma
    expect(r.stdout).toContain('Would deploy 12 resource(s) to AWS (CloudFormation)');
  });

  test('--stack net-stack deploya só ela (11 recursos, ignora data-stack)', () => {
    dir = makeProject({
      provider: 'aws',
      stacks: {
        'net-stack.js': vpcStackJs('net-stack'),
        'data-stack.js': bucketStackJs('data-stack'),
      },
    });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'aws', '--stack', 'net-stack'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: net-stack — 11 recurso(s)');
    // a outra stack NÃO entra
    expect(r.stdout).not.toContain('data-stack');
    expect(r.stdout).toContain('Would deploy 11 resource(s) to AWS (CloudFormation)');
  });

  test('--stack data-stack deploya só ela (1 recurso)', () => {
    dir = makeProject({
      provider: 'aws',
      stacks: {
        'net-stack.js': vpcStackJs('net-stack'),
        'data-stack.js': bucketStackJs('data-stack'),
      },
    });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'aws', '-s', 'data-stack'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: data-stack — 1 recurso(s)');
    expect(r.stdout).not.toContain('net-stack');
    expect(r.stdout).toContain('Would deploy 1 resource(s) to AWS (CloudFormation)');
  });
});

describe('deploy — caminhos de erro', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('erro quando não há synth-out (synth nunca rodou)', () => {
    dir = makeProject({ provider: 'aws' });
    // NÃO roda synth antes
    const r = runCli(['deploy', '--provider', 'aws'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("Nenhum template encontrado para 'aws'");
    // a mensagem orienta a rodar synth do provider certo
    expect(r.all).toContain('iacmp synth --provider');
    // não deve ter chegado ao resumo de deploy
    expect(r.all).not.toContain('Would deploy');
  });

  test('erro quando o synth foi de OUTRO provider (synth aws, deploy gcp)', () => {
    dir = makeProject({ provider: 'aws' });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    // gcp não tem templates sintetizados
    const r = runCli(['deploy', '--provider', 'gcp'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("Nenhum template encontrado para 'gcp'");
  });

  test('--stack inexistente: nenhum template casa o filtro -> erro', () => {
    dir = makeProject({ provider: 'aws' });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'aws', '--stack', 'nao-existe'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("Nenhum template encontrado para 'aws'");
    expect(r.all).not.toContain('Would deploy');
  });

  test('erro quando projeto não inicializado (sem iacmp.json)', () => {
    dir = makeProject({ noConfig: true, noStacks: true });
    const r = runCli(['deploy'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('Projeto não inicializado');
    expect(r.all.toLowerCase()).toContain('init');
  });
});
