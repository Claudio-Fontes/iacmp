import { runCli, makeProject, rmrf, exists, ls } from './helpers';

/**
 * Prova do harness: comandos básicos + pipeline synth→deploy→diff de ponta a
 * ponta no binário real. Se este suite passa, o padrão black-box está validado.
 */

describe('CLI básico', () => {
  test('--help lista os comandos', () => {
    const r = runCli(['--help'], { cwd: process.cwd() });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('synth');
    expect(r.stdout).toContain('deploy');
    expect(r.stdout).toContain('diagram');
  });

  test('--version', () => {
    const r = runCli(['--version'], { cwd: process.cwd() });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/iacmp\/\d+\.\d+\.\d+/);
  });

  test('doctor roda sem projeto', () => {
    const dir = makeProject({ noConfig: true, noStacks: true });
    const r = runCli(['doctor'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.all.toLowerCase()).toContain('node');
    rmrf(dir);
  });
});

describe('synth → deploy → diff (pipeline E2E)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('synth grava em synth-out/<provider>/ e deploy lê de lá', () => {
    dir = makeProject({ provider: 'aws' });

    const synth = runCli(['synth', '--provider', 'aws'], { cwd: dir });
    expect(synth.status).toBe(0);
    expect(exists(dir, 'synth-out/aws/main-stack.json')).toBe(true);
    // não deve gravar no synth-out/ plano (regressão CLI-01)
    expect(exists(dir, 'synth-out/main-stack.json')).toBe(false);

    const deploy = runCli(['deploy', '--provider', 'aws'], { cwd: dir });
    expect(deploy.status).toBe(0);
    expect(deploy.stdout).toContain('main-stack');
    expect(deploy.stdout).toMatch(/Would deploy \d+ resource/);
  });

  test('diff não acusa mudança logo após synth (sem diff fantasma)', () => {
    dir = makeProject({ provider: 'aws' });
    runCli(['synth', '--provider', 'aws'], { cwd: dir });
    const diff = runCli(['diff', '--provider', 'aws'], { cwd: dir });
    expect(diff.status).toBe(0);
    expect(diff.all).toMatch(/sem alteraç|Nenhuma alteração/i);
  });

  test('providers diferentes não se sobrescrevem', () => {
    dir = makeProject({ provider: 'aws' });
    runCli(['synth', '--provider', 'aws'], { cwd: dir });
    runCli(['synth', '--provider', 'terraform'], { cwd: dir });
    expect(exists(dir, 'synth-out/aws/main-stack.json')).toBe(true);
    expect(exists(dir, 'synth-out/terraform/main-stack.tf')).toBe(true);
  });

  test('erro claro sem projeto inicializado', () => {
    dir = makeProject({ noConfig: true });
    const r = runCli(['synth'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('init');
  });
});
