import { runCli, makeProject, rmrf, exists } from './helpers';

/**
 * Cobertura do comando `deploy` (src/commands/deploy.ts).
 *
 * `iacmp deploy` chama a CLI nativa de cada nuvem (aws/az/gcloud/terraform)
 * via subprocess — não dá pra testar a execução real em CI sem credenciais.
 * Por isso todo teste usa `--dry-run`, que monta e imprime o plano de
 * comandos sem executar nada e sem exigir a CLI nativa instalada (os helpers
 * de leitura usados no plano degradam graciosamente quando o binário falta).
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

describe('deploy --dry-run — caso feliz por provider (synth antes)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('aws: monta o plano package+deploy com --stack-name/--template-file corretos', () => {
    dir = makeProject({ provider: 'aws' });

    const synth = runCli(['synth', '--provider', 'aws'], { cwd: dir });
    expect(synth.status).toBe(0);
    expect(exists(dir, 'synth-out/aws/main-stack.json')).toBe(true);

    const r = runCli(['deploy', '--provider', 'aws', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: main-stack — 12 recurso(s)');
    expect(r.stdout).toContain('aws cloudformation package');
    expect(r.stdout).toContain('--s3-bucket');
    expect(r.stdout).toContain('aws cloudformation deploy');
    expect(r.stdout).toContain('--stack-name main-stack');
    expect(r.stdout).toContain('Deploy concluído.');
  });

  test('azure: exige resourceGroup configurado, e monta `az stack group create`', () => {
    dir = makeProject({
      provider: 'azure',
      iacmpJson: { name: 'test', provider: 'azure', region: 'eastus', resourceGroup: 'meu-rg' },
    });
    expect(runCli(['synth', '--provider', 'azure'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'azure', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: main-stack — 3 recurso(s)');
    expect(r.stdout).toContain('az stack group create');
    expect(r.stdout).toContain('--resource-group meu-rg');
  });

  test('azure: sem resourceGroup no iacmp.json -> erro claro', () => {
    dir = makeProject({ provider: 'azure' });
    expect(runCli(['synth', '--provider', 'azure'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'azure', '--dry-run'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('Configure "resourceGroup" no iacmp.json');
  });

  test('gcp: usa o projectId do iacmp.json e monta `deployments create`', () => {
    dir = makeProject({
      provider: 'gcp',
      iacmpJson: { name: 'test', provider: 'gcp', region: 'us-central1', projectId: 'meu-projeto' },
    });
    expect(runCli(['synth', '--provider', 'gcp'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'gcp', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: main-stack — 2 recurso(s)');
    expect(r.stdout).toContain('gcloud deployment-manager deployments create');
    expect(r.stdout).toContain('--project meu-projeto');
  });

  test('terraform: opera no diretório inteiro (terraform init + apply), não por stack', () => {
    dir = makeProject({ provider: 'terraform' });
    const synth = runCli(['synth', '--provider', 'terraform'], { cwd: dir });
    expect(synth.status).toBe(0);
    expect(exists(dir, 'synth-out/terraform/main-stack.tf')).toBe(true);

    const r = runCli(['deploy', '--provider', 'terraform', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: main-stack — 4 recurso(s)');
    expect(r.stdout).toContain('terraform init');
    expect(r.stdout).toContain('terraform apply -auto-approve');
  });

  test('terraform: --stack não é suportado', () => {
    dir = makeProject({ provider: 'terraform' });
    expect(runCli(['synth', '--provider', 'terraform'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'terraform', '--stack', 'main-stack', '--dry-run'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('--stack não é suportado para --provider terraform');
  });
});

describe('deploy --dry-run — provider default vem do iacmp.json', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('sem --provider, usa o provider do config (aws)', () => {
    dir = makeProject({ provider: 'aws' });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Provider: aws (dry-run)');
    expect(r.stdout).toContain('aws cloudformation deploy');
  });
});

describe('deploy --dry-run — múltiplas stacks e filtro --stack', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('lista recursos de todas as stacks', () => {
    dir = makeProject({
      provider: 'aws',
      stacks: {
        'net-stack.js': vpcStackJs('net-stack'),
        'data-stack.js': bucketStackJs('data-stack'),
      },
    });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'aws', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: net-stack — 11 recurso(s)');
    expect(r.stdout).toContain('Stack: data-stack — 1 recurso(s)');
    expect(r.stdout).toContain('--stack-name net-stack');
    expect(r.stdout).toContain('--stack-name data-stack');
  });

  test('--stack net-stack deploya só ela (ignora data-stack)', () => {
    dir = makeProject({
      provider: 'aws',
      stacks: {
        'net-stack.js': vpcStackJs('net-stack'),
        'data-stack.js': bucketStackJs('data-stack'),
      },
    });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'aws', '--stack', 'net-stack', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: net-stack — 11 recurso(s)');
    expect(r.stdout).not.toContain('data-stack');
  });

  test('-s data-stack deploya só ela', () => {
    dir = makeProject({
      provider: 'aws',
      stacks: {
        'net-stack.js': vpcStackJs('net-stack'),
        'data-stack.js': bucketStackJs('data-stack'),
      },
    });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'aws', '-s', 'data-stack', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stack: data-stack — 1 recurso(s)');
    expect(r.stdout).not.toContain('net-stack');
  });
});

describe('deploy — caminhos de erro', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('erro quando não há synth-out (synth nunca rodou)', () => {
    dir = makeProject({ provider: 'aws' });
    // NÃO roda synth antes
    const r = runCli(['deploy', '--provider', 'aws', '--dry-run'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("Nenhum template encontrado para 'aws'");
    expect(r.all).toContain('iacmp synth --provider');
  });

  test('erro quando o synth foi de OUTRO provider (synth aws, deploy gcp)', () => {
    dir = makeProject({ provider: 'aws' });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'gcp', '--dry-run'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("Nenhum template encontrado para 'gcp'");
  });

  test('--stack inexistente: nenhum template casa o filtro -> erro', () => {
    dir = makeProject({ provider: 'aws' });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'aws', '--stack', 'nao-existe', '--dry-run'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("Nenhum template encontrado para 'aws'");
  });

  test('erro quando projeto não inicializado (sem iacmp.json)', () => {
    dir = makeProject({ noConfig: true, noStacks: true });
    const r = runCli(['deploy', '--dry-run'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('Projeto não inicializado');
    expect(r.all.toLowerCase()).toContain('init');
  });

  test('provider desconhecido -> erro claro', () => {
    dir = makeProject({ provider: 'aws' });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['deploy', '--provider', 'oraculo', '--dry-run'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('Provider desconhecido: oraculo');
  });
});
