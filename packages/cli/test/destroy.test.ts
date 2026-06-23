import { runCli, makeProject, rmrf, defaultStackJs } from './helpers';

/**
 * Comando `destroy` (src/commands/destroy.ts) — chama a CLI nativa de cada
 * nuvem via subprocess, então a maioria dos testes usa `--dry-run` (monta e
 * imprime o plano sem rodar nada e sem exigir a CLI nativa instalada).
 *
 * O fluxo de confirmação interativa (sem --force) é testado fora do dry-run:
 * a pergunta "tem certeza?" acontece ANTES da checagem da CLI nativa, então
 * "n" cancela sem nunca tocar em nenhum binário, e "y" chega até a checagem
 * da CLI nativa (que falha de forma determinística em CI, onde nenhuma das
 * CLIs de nuvem está instalada).
 */
describe('destroy --dry-run', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmrf(dir);
  });

  function synthed(provider = 'aws', iacmpJson?: Record<string, unknown>): string {
    const d = makeProject({ provider, iacmpJson });
    const r = runCli(['synth', '--provider', provider], { cwd: d });
    expect(r.status).toBe(0);
    return d;
  }

  test('aws: monta delete-stack + wait com --stack-name correto', () => {
    dir = synthed('aws');
    const r = runCli(['destroy', '--provider', 'aws', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('main-stack');
    expect(r.stdout).toContain('aws cloudformation delete-stack');
    expect(r.stdout).toContain('--stack-name main-stack');
    expect(r.stdout).toContain('aws cloudformation wait stack-delete-complete');
    expect(r.stdout).toContain('Destroy concluído.');
    // --dry-run nunca pede confirmação
    expect(r.stdout).not.toContain('Tem certeza');
  });

  test('conta recursos (Total de recursos) de forma provider-aware', () => {
    dir = synthed('aws');
    const r = runCli(['destroy', '--provider', 'aws', '--dry-run'], { cwd: dir });
    expect(r.stdout).toMatch(/Total de recursos: [1-9]\d* em AWS/);
  });

  test('terraform: opera no diretório inteiro (terraform destroy), não por stack', () => {
    dir = synthed('terraform');
    const r = runCli(['destroy', '--provider', 'terraform', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('terraform destroy -auto-approve');
  });

  test('azure: exige resourceGroup configurado', () => {
    dir = synthed('azure', { name: 'test', provider: 'azure', region: 'eastus', resourceGroup: 'meu-rg' });
    const r = runCli(['destroy', '--provider', 'azure', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('az stack group delete');
    expect(r.stdout).toContain('--resource-group meu-rg');
  });

  test('gcp: usa o projectId do iacmp.json', () => {
    dir = synthed('gcp', { name: 'test', provider: 'gcp', region: 'us-central1', projectId: 'meu-projeto' });
    const r = runCli(['destroy', '--provider', 'gcp', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gcloud deployment-manager deployments delete');
    expect(r.stdout).toContain('--project meu-projeto');
  });

  test('--stack limita à stack indicada', () => {
    dir = makeProject({
      provider: 'aws',
      stacks: { 'rede.js': defaultStackJs('rede'), 'banco.js': defaultStackJs('banco') },
    });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);
    const r = runCli(['destroy', '--provider', 'aws', '--stack', 'rede', '--dry-run'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('rede');
    expect(r.stdout).not.toContain('banco');
  });

  test('terraform: --stack não é suportado', () => {
    dir = synthed('terraform');
    const r = runCli(['destroy', '--provider', 'terraform', '--stack', 'main-stack', '--dry-run'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('--stack não é suportado para --provider terraform');
  });

  test('erro quando não há synth-out', () => {
    dir = makeProject({ provider: 'aws' }); // sem rodar synth
    const r = runCli(['destroy', '--provider', 'aws', '--dry-run'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('synth');
  });

  test('erro quando o projeto não está inicializado', () => {
    dir = makeProject({ noConfig: true });
    const r = runCli(['destroy', '--dry-run'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('init');
  });
});

describe('destroy — confirmação interativa (sem --force, sem --dry-run)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmrf(dir);
  });

  test('input "n" cancela ANTES de checar a CLI nativa — nunca toca em nenhum binário', () => {
    dir = makeProject({ provider: 'aws' });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);

    const r = runCli(['destroy', '--provider', 'aws'], { cwd: dir, input: 'n\n' });
    expect(r.status).toBe(0);
    expect(r.all).toContain('Tem certeza que deseja destruir esses recursos?');
    expect(r.all).toContain('Operação cancelada');
    expect(r.all).not.toContain('cloudformation');
  });

  test('input "y" prossegue e chega na checagem da CLI nativa (gcloud não instalada em CI)', () => {
    dir = makeProject({
      provider: 'gcp',
      iacmpJson: { name: 'test', provider: 'gcp', region: 'us-central1', projectId: 'meu-projeto' },
    });
    expect(runCli(['synth', '--provider', 'gcp'], { cwd: dir }).status).toBe(0);

    const r = runCli(['destroy', '--provider', 'gcp'], { cwd: dir, input: 'y\n' });
    // Confirmou (não cancelou) e seguiu até checar a CLI nativa — falha
    // determinística aqui significa que o fluxo de confirmação funcionou.
    expect(r.all).toContain('Tem certeza que deseja destruir esses recursos?');
    expect(r.all).not.toContain('Operação cancelada');
    expect(r.all).toContain('gcloud não encontrado no PATH');
  });
});
