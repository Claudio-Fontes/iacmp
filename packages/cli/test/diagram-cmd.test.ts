import { runCli, makeProject, rmrf, read, exists, defaultStackJs } from './helpers';

/**
 * Black-box do comando `diagram` (src/commands/diagram.ts).
 *
 * Notas de comportamento real, confirmadas lendo a implementação:
 * - O nome da stack vem do NOME DO ARQUIVO (basename sem extensão), não do
 *   `new Stack('...')` — `loadStacks()` em src/audit.ts deriva `name` do arquivo.
 *   Logo `--stack <basename-do-arquivo>` é o que filtra.
 * - O conteúdo gerado usa `node.label`, que é o `id` do construct (ex: 'Vpc',
 *   'Assets'), não o tipo. Então é por esse id que verificamos o conteúdo.
 * - Structurizr → diagrams/workspace.dsl ; Mermaid → diagrams/workspace.md.
 */

/** Stack com nome de arquivo != nome do Stack(), p/ provar de onde vem o filtro. */
function lambdaDbStackJs(): string {
  return `const { Stack, Fn, Database } = require('@iacmp/core');
const stack = new Stack('payments-internal');
new Fn.Lambda(stack, 'ProcessorFn', { runtime: 'nodejs20', handler: 'index.handler', code: './src' });
new Database.SQL(stack, 'OrdersDb', { engine: 'postgres', instanceType: 'db.t3.micro' });
module.exports = stack;
`;
}

describe('diagram — Structurizr (default)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('gera diagrams/workspace.dsl com nome da stack e labels dos constructs', () => {
    dir = makeProject({ stacks: { 'main-stack.js': defaultStackJs('main-stack') } });
    const r = runCli(['diagram'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(exists(dir, 'diagrams/workspace.dsl')).toBe(true);
    // Structurizr não deve produzir o .md de mermaid
    expect(exists(dir, 'diagrams/workspace.md')).toBe(false);

    const dsl = read(dir, 'diagrams/workspace.dsl');
    // Sintaxe Structurizr DSL
    expect(dsl).toMatch(/^workspace "test" \{/m);
    expect(dsl).toContain('softwareSystem');
    expect(dsl).toContain('views {');
    expect(dsl).toContain('autoLayout');
    // Nome da stack (= nome do arquivo) vira um group
    expect(dsl).toContain('group "main-stack"');
    // Labels (ids) dos constructs da stack default: Vpc + Assets
    expect(dsl).toContain('container "Vpc"');
    expect(dsl).toContain('container "Assets"');
    // Tag do theme AWS para a VPC
    expect(dsl).toContain('Amazon Web Services - VPC');
  });

  test('saída no terminal resume stacks e recursos', () => {
    dir = makeProject({ stacks: { 'main-stack.js': defaultStackJs('main-stack') } });
    const r = runCli(['diagram'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Diagrama gerado');
    expect(r.stdout).toContain('Formato:  structurizr');
    expect(r.stdout).toContain('main-stack');
    // path relativo do arquivo salvo
    expect(r.stdout).toMatch(/diagrams[/\\]workspace\.dsl/);
  });

  test('--out muda o diretório de saída', () => {
    dir = makeProject();
    const r = runCli(['diagram', '--out', 'arch'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(exists(dir, 'arch/workspace.dsl')).toBe(true);
    expect(exists(dir, 'diagrams/workspace.dsl')).toBe(false);
  });

  test('--provider azure aplica o theme/tags do provider', () => {
    dir = makeProject();
    const r = runCli(['diagram', '--provider', 'azure'], { cwd: dir });

    expect(r.status).toBe(0);
    const dsl = read(dir, 'diagrams/workspace.dsl');
    expect(dsl).toContain('Microsoft Azure');
    expect(dsl).toContain('microsoft-azure'); // url do theme
    expect(r.stdout).toContain('(via --provider)');
  });
});

describe('diagram --format mermaid', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('gera diagrams/workspace.md com sintaxe mermaid', () => {
    dir = makeProject({ stacks: { 'main-stack.js': defaultStackJs('main-stack') } });
    const r = runCli(['diagram', '--format', 'mermaid'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(exists(dir, 'diagrams/workspace.md')).toBe(true);
    // mermaid não deve produzir o .dsl
    expect(exists(dir, 'diagrams/workspace.dsl')).toBe(false);

    const md = read(dir, 'diagrams/workspace.md');
    // Bloco de código mermaid + grafo
    expect(md).toContain('```mermaid');
    expect(md).toContain('graph TD');
    // Cabeçalho markdown da stack (= nome do arquivo)
    expect(md).toContain('## Stack: main-stack');
    // Labels dos constructs aparecem nos nós e na legenda
    expect(md).toContain('Vpc');
    expect(md).toContain('Assets');
    expect(md).toContain('Network.VPC');
    expect(md).toContain('**Recursos:**');
  });

  test('-f mermaid (alias curto) também funciona', () => {
    dir = makeProject();
    const r = runCli(['diagram', '-f', 'mermaid'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(exists(dir, 'diagrams/workspace.md')).toBe(true);
    expect(r.stdout).toContain('Formato:  mermaid');
  });

  test('relacionamento inferido (VPC -> demais) aparece como aresta tracejada', () => {
    dir = makeProject({ stacks: { 'main-stack.js': defaultStackJs('main-stack') } });
    const r = runCli(['diagram', '--format', 'mermaid'], { cwd: dir });

    expect(r.status).toBe(0);
    const md = read(dir, 'diagrams/workspace.md');
    // Uma única VPC infere setas tracejadas p/ os demais nós
    expect(md).toContain('-.->');
    expect(md).toContain('inferred');
  });
});

describe('diagram --stack (filtro)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('--stack restringe a saída a uma stack pelo nome do arquivo', () => {
    dir = makeProject({
      stacks: {
        'network.js': defaultStackJs('network'),
        'payments.js': lambdaDbStackJs(),
      },
    });
    const r = runCli(['diagram', '--stack', 'network'], { cwd: dir });

    expect(r.status).toBe(0);
    const dsl = read(dir, 'diagrams/workspace.dsl');
    // só a stack 'network' (nome do arquivo) entra
    expect(dsl).toContain('group "network"');
    expect(dsl).not.toContain('group "payments"');
    // constructs da 'payments' não devem aparecer
    expect(dsl).not.toContain('container "ProcessorFn"');
    expect(dsl).not.toContain('container "OrdersDb"');
    // a saída do terminal lista apenas a stack filtrada
    expect(r.stdout).toMatch(/Stacks:\s+network\b/);
    expect(r.stdout).not.toContain('payments');
  });

  test('--stack desconhecida → erro listando stacks disponíveis', () => {
    dir = makeProject({
      stacks: {
        'network.js': defaultStackJs('network'),
        'payments.js': lambdaDbStackJs(),
      },
    });
    const r = runCli(['diagram', '--stack', 'naoexiste'], { cwd: dir });

    expect(r.status).not.toBe(0);
    expect(r.all).toContain("Stack 'naoexiste' não encontrada");
    // lista as disponíveis (nomes dos arquivos)
    expect(r.all).toContain('network');
    expect(r.all).toContain('payments');
    // não deve ter gerado arquivo
    expect(exists(dir, 'diagrams/workspace.dsl')).toBe(false);
  });
});

describe('diagram — caminhos de erro', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('sem iacmp.json → erro pedindo init', () => {
    dir = makeProject({ noConfig: true });
    const r = runCli(['diagram'], { cwd: dir });

    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('init');
    expect(exists(dir, 'diagrams/workspace.dsl')).toBe(false);
  });

  test('sem diretório stacks/ → erro', () => {
    dir = makeProject({ noStacks: true });
    const r = runCli(['diagram'], { cwd: dir });

    expect(r.status).not.toBe(0);
    expect(r.all).toContain('stacks/');
  });

  test('--format inválido → erro listando formatos válidos', () => {
    dir = makeProject();
    const r = runCli(['diagram', '--format', 'png'], { cwd: dir });

    expect(r.status).not.toBe(0);
    expect(r.all).toContain("Formato 'png' inválido");
    expect(r.all).toContain('structurizr');
    expect(r.all).toContain('mermaid');
    expect(exists(dir, 'diagrams/workspace.dsl')).toBe(false);
    expect(exists(dir, 'diagrams/workspace.md')).toBe(false);
  });
});
