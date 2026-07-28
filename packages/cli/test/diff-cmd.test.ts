import { runCli, makeProject, rmrf, defaultStackJs } from './helpers';

/**
 * Testes black-box do comando `diff` (src/commands/diff.ts).
 *
 * `diff` compara o template salvo pelo último `synth` (em synth-out/<provider>/)
 * com o synth ATUAL da stack (carregada de stacks/*.js). Cobrimos:
 *  - sem mudança após synth NÃO acusa alteração (sem diff fantasma);
 *  - alterar a stack (adicionar construct) MOSTRA linhas +/-;
 *  - stack nova sem synth anterior tem mensagem própria;
 *  - flag --stack filtra a stack analisada;
 *  - caminhos de erro (sem projeto, sem synth anterior).
 *
 * Observação importante de comportamento (não-bug): `diff` SEMPRE sai com
 * status 0, mesmo quando há diferenças. A presença/ausência de diff é sinalizada
 * apenas pela saída em texto, não pelo exit code.
 */

/** Stack VPC+Bucket COM um bucket extra — usada para forçar um diff aditivo.
 *  (mesma camada storage, para não acionar a validação de separação por camada) */
function stackWithQueueJs(name = 'main-stack'): string {
  return `const { Stack, Network, Storage } = require('@iacmp/core');
const stack = new Stack('${name}');
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });
new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });
new Storage.Bucket(stack, 'Jobs', { versioning: false, publicAccess: false });
module.exports = stack;
`;
}

/** Stack mínima (só um Bucket) com nome arbitrário. */
function bucketStackJs(name: string, bucketId = 'Logs'): string {
  return `const { Stack, Storage } = require('@iacmp/core');
const stack = new Stack('${name}');
new Storage.Bucket(stack, '${bucketId}', { versioning: false, publicAccess: false });
module.exports = stack;
`;
}

describe('diff: caso feliz (sem alteração)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('após synth, diff sem mudar a stack NÃO acusa alteração', () => {
    dir = makeProject({ provider: 'aws' });

    const synth = runCli(['synth', '--provider', 'aws'], { cwd: dir });
    expect(synth.status).toBe(0);

    const diff = runCli(['diff', '--provider', 'aws'], { cwd: dir });
    expect(diff.status).toBe(0);
    // mensagens do "sem diff": por-stack "(sem alterações)" e o resumo final.
    expect(diff.all).toContain('(sem alterações)');
    expect(diff.all).toContain('Nenhuma alteração detectada');
    // não deve haver NENHUMA linha de adição/remoção.
    expect(diff.stdout).not.toMatch(/^[+-] /m);
  });

  test('diff usa o provider do iacmp.json quando --provider é omitido', () => {
    dir = makeProject({ provider: 'aws' });
    runCli(['synth', '--provider', 'aws'], { cwd: dir });

    const diff = runCli(['diff'], { cwd: dir });
    expect(diff.status).toBe(0);
    expect(diff.all).toContain('Nenhuma alteração detectada');
  });
});

describe('diff: stack modificada mostra diferença', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('adicionar um construct gera linhas + no diff', () => {
    // synthetiza a stack padrão (VPC+Bucket)...
    dir = makeProject({ provider: 'aws' });
    runCli(['synth', '--provider', 'aws'], { cwd: dir });

    // ...e reescreve a stack adicionando um segundo bucket (mesma camada).
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    fs.writeFileSync(path.join(dir, 'stacks', 'main-stack.js'), stackWithQueueJs('main-stack'));

    const diff = runCli(['diff', '--provider', 'aws'], { cwd: dir });
    expect(diff.status).toBe(0);
    // o resumo "Nenhuma alteração" NÃO deve aparecer.
    expect(diff.all).not.toContain('Nenhuma alteração detectada');
    // deve haver linhas de adição (prefixo "+ ").
    expect(diff.stdout).toMatch(/^\+ /m);
    // o recurso adicionado deve aparecer no diff.
    expect(diff.stdout).toContain('Jobs');
    // cabeçalho com o nome da stack.
    expect(diff.stdout).toContain('main-stack.json');
  });

  test('remover um construct gera linhas - no diff', () => {
    // synthetiza uma stack COM fila...
    dir = makeProject({
      provider: 'aws',
      stacks: { 'main-stack.js': stackWithQueueJs('main-stack') },
    });
    runCli(['synth', '--provider', 'aws'], { cwd: dir });

    // ...e reescreve removendo o segundo bucket (volta pro VPC+Bucket padrão).
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    fs.writeFileSync(path.join(dir, 'stacks', 'main-stack.js'), defaultStackJs('main-stack'));

    const diff = runCli(['diff', '--provider', 'aws'], { cwd: dir });
    expect(diff.status).toBe(0);
    expect(diff.all).not.toContain('Nenhuma alteração detectada');
    // deve haver linhas de remoção (prefixo "- ").
    expect(diff.stdout).toMatch(/^- /m);
    // o recurso removido deve aparecer entre as linhas removidas.
    expect(diff.stdout).toContain('Jobs');
  });
});

describe('diff: stack nova sem synth anterior', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('stack sem template salvo recebe mensagem "Stack nova"', () => {
    // duas stacks; só a "main-stack" é synthetizada.
    dir = makeProject({
      provider: 'aws',
      stacks: {
        'main-stack.js': defaultStackJs('main-stack'),
        'extra-stack.js': bucketStackJs('extra-stack'),
      },
    });
    // synth só da main-stack para deixar extra-stack sem template salvo.
    runCli(['synth', '--provider', 'aws', '--stack', 'main-stack'], { cwd: dir });

    const diff = runCli(['diff', '--provider', 'aws'], { cwd: dir });
    expect(diff.status).toBe(0);
    expect(diff.all).toContain('Stack nova (sem synth anterior): extra-stack');
    // main-stack (synthetizada e inalterada) não deve disparar diff.
    expect(diff.all).toContain('(sem alterações)');
  });
});

describe('diff: flag --stack', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('--stack limita a análise à stack indicada', () => {
    dir = makeProject({
      provider: 'aws',
      stacks: {
        'main-stack.js': defaultStackJs('main-stack'),
        'extra-stack.js': bucketStackJs('extra-stack'),
      },
    });
    // synth de ambas para terem templates salvos.
    runCli(['synth', '--provider', 'aws'], { cwd: dir });

    // diff só de extra-stack: NÃO deve mencionar main-stack.
    const diff = runCli(['diff', '--provider', 'aws', '--stack', 'extra-stack'], { cwd: dir });
    expect(diff.status).toBe(0);
    expect(diff.all).toContain('Nenhuma alteração detectada');
    expect(diff.all).not.toContain('main-stack');
  });

  test('--stack isola a stack alterada das demais', () => {
    dir = makeProject({
      provider: 'aws',
      stacks: {
        'main-stack.js': defaultStackJs('main-stack'),
        'extra-stack.js': bucketStackJs('extra-stack'),
      },
    });
    runCli(['synth', '--provider', 'aws'], { cwd: dir });

    // altera APENAS a main-stack.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    fs.writeFileSync(path.join(dir, 'stacks', 'main-stack.js'), stackWithQueueJs('main-stack'));

    // diff focado em main-stack mostra a diferença...
    const onlyMain = runCli(['diff', '--provider', 'aws', '--stack', 'main-stack'], { cwd: dir });
    expect(onlyMain.status).toBe(0);
    expect(onlyMain.stdout).toMatch(/^\+ /m);
    expect(onlyMain.all).not.toContain('extra-stack');

    // ...enquanto diff focado em extra-stack (inalterada) não mostra diferença.
    const onlyExtra = runCli(['diff', '--provider', 'aws', '--stack', 'extra-stack'], { cwd: dir });
    expect(onlyExtra.status).toBe(0);
    expect(onlyExtra.all).toContain('Nenhuma alteração detectada');
    expect(onlyExtra.stdout).not.toMatch(/^[+-] /m);
  });
});

describe('diff: caminhos de erro', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('sem iacmp.json → erro "Projeto não inicializado"', () => {
    dir = makeProject({ noConfig: true });
    const r = runCli(['diff'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('Projeto não inicializado');
    expect(r.all.toLowerCase()).toContain('init');
  });

  test('sem synth anterior → mensagem própria e status 0', () => {
    // projeto válido (config + stacks) mas nunca synthetizado.
    dir = makeProject({ provider: 'aws' });
    const r = runCli(['diff', '--provider', 'aws'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.all).toContain('Nenhum synth anterior encontrado');
    expect(r.all.toLowerCase()).toContain('synth');
    // não deve renderizar nenhum diff.
    expect(r.stdout).not.toMatch(/^[+-] /m);
  });
});
