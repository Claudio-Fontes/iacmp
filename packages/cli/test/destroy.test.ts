import { runCli, makeProject, rmrf, defaultStackJs } from './helpers';

/**
 * Comando `destroy` (dry-run no MVP): lê os templates de synth-out/<provider>/,
 * conta recursos de forma agnóstica de provider e — sem --force — pede
 * confirmação via stdin antes de prosseguir.
 */
describe('destroy', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmrf(dir);
  });

  function synthed(provider = 'aws'): string {
    const d = makeProject({ provider });
    const r = runCli(['synth', '--provider', provider], { cwd: d });
    expect(r.status).toBe(0);
    return d;
  }

  test('--force pula a confirmação e mostra "Would destroy"', () => {
    dir = synthed('aws');
    const r = runCli(['destroy', '--provider', 'aws', '--force'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Would destroy \d+ resource\(s\) from AWS/);
    expect(r.stdout).toContain('main-stack');
    // CLI-05: banner amarelo no topo da saída avisando que destroy é dry-run
    expect(r.stdout).toContain('MVP: deploy/destroy real ainda não implementado nesta fase');
  });

  test('conta recursos (Total de recursos) de forma provider-aware', () => {
    dir = synthed('aws');
    const r = runCli(['destroy', '--provider', 'aws', '--force'], { cwd: dir });
    expect(r.stdout).toMatch(/Total de recursos: [1-9]\d* em AWS/);
  });

  test('funciona para terraform (.tf), não só AWS', () => {
    dir = synthed('terraform');
    const r = runCli(['destroy', '--provider', 'terraform', '--force'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Total de recursos: [1-9]\d* em TERRAFORM/);
    expect(r.stdout).toMatch(/Would destroy \d+ resource\(s\) from TERRAFORM/);
  });

  test('input "n" cancela a operação (sem --force)', () => {
    dir = synthed('aws');
    const r = runCli(['destroy', '--provider', 'aws'], { cwd: dir, input: 'n\n' });
    expect(r.status).toBe(0);
    expect(r.all).toContain('Operação cancelada');
    expect(r.all).not.toMatch(/Would destroy/);
  });

  test('input "y" prossegue com o destroy (dry-run)', () => {
    dir = synthed('aws');
    const r = runCli(['destroy', '--provider', 'aws'], { cwd: dir, input: 'y\n' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Would destroy \d+ resource/);
  });

  test('--stack limita à stack indicada', () => {
    dir = makeProject({
      provider: 'aws',
      stacks: { 'rede.js': defaultStackJs('rede'), 'banco.js': defaultStackJs('banco') },
    });
    expect(runCli(['synth', '--provider', 'aws'], { cwd: dir }).status).toBe(0);
    const r = runCli(['destroy', '--provider', 'aws', '--stack', 'rede', '--force'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('rede');
    expect(r.stdout).not.toContain('banco');
  });

  test('erro quando não há synth-out', () => {
    dir = makeProject({ provider: 'aws' }); // sem rodar synth
    const r = runCli(['destroy', '--provider', 'aws', '--force'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('synth');
  });

  test('erro quando o projeto não está inicializado', () => {
    dir = makeProject({ noConfig: true });
    const r = runCli(['destroy', '--force'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('init');
  });
});
