import { runCli, makeProject, rmrf } from './helpers';

/**
 * Testes black-box do comando `ls` (src/commands/ls.ts).
 *
 * Comportamento observado do binário real:
 *  - recursa em stacks/ (incluindo subpastas) e reconhece `.ts` e `.js`,
 *    espelhando a descoberta de synth/deploy (o nome listado é o caminho
 *    relativo a stacks/ sem a extensão, ex.: `network/vpc`);
 *  - imprime o header "Stacks disponíveis:" e uma linha por stack contendo
 *    o nome e "modificado: <data>";
 *  - sem o diretório stacks/  -> instrui a rodar `iacmp init`;
 *  - stacks/ sem nenhuma stack -> "Nenhuma stack encontrada em stacks/";
 *  - sempre sai com status 0 (inclusive nos caminhos "vazios").
 */

describe('comando ls', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmrf(dir);
    dir = undefined;
  });

  describe('caso feliz', () => {
    test('lista o nome de uma única stack .ts', () => {
      dir = makeProject({ stacks: { 'network.ts': 'export const x = 1;\n' } });

      const r = runCli(['ls'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Stacks disponíveis:');
      // nome SEM a extensão .ts
      expect(r.stdout).toContain('network');
      expect(r.stdout).not.toContain('network.ts');
      // metadado de cada linha
      expect(r.stdout).toContain('modificado:');
      // formato exato da linha: nome (padded) + "modificado: <data>"
      expect(r.stdout).toMatch(/^ {2}network\s+modificado: .+/m);
    });

    test('lista múltiplas stacks .ts (todos os nomes presentes)', () => {
      dir = makeProject({
        stacks: {
          'network.ts': 'export const a = 1;\n',
          'compute.ts': 'export const b = 2;\n',
          'storage.ts': 'export const c = 3;\n',
        },
      });

      const r = runCli(['ls'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Stacks disponíveis:');
      expect(r.stdout).toContain('network');
      expect(r.stdout).toContain('compute');
      expect(r.stdout).toContain('storage');

      // uma linha "modificado:" por stack (3 stacks)
      const modLines = r.stdout.split('\n').filter(l => l.includes('modificado:'));
      expect(modLines).toHaveLength(3);
    });

    test('lista .ts e .js, ignorando arquivos que não são stacks', () => {
      dir = makeProject({
        stacks: {
          'real.ts': 'export const a = 1;\n',
          'helper.js': 'module.exports = {};\n',
          'notes.md': '# nao e uma stack\n',
          'config.json': '{}\n',
        },
      });

      const r = runCli(['ls'], { cwd: dir });

      expect(r.status).toBe(0);
      // .ts e .js são reconhecidos como stacks...
      expect(r.stdout).toContain('real');
      expect(r.stdout).toContain('helper');
      // ...e arquivos que não são stacks ficam de fora
      expect(r.stdout).not.toContain('notes');
      expect(r.stdout).not.toContain('config');
      // duas stacks reconhecidas (.ts + .js)
      const modLines = r.stdout.split('\n').filter(l => l.includes('modificado:'));
      expect(modLines).toHaveLength(2);
    });
  });

  describe('subpastas de stacks/', () => {
    /**
     * `ls` recursa em subpastas (como synth/deploy), então stacks aninhadas
     * aparecem listadas pelo seu caminho relativo a stacks/ (ex.: `network/vpc`).
     */
    test('recursa: stack em subpasta de stacks/ é listada pelo caminho relativo', () => {
      dir = makeProject({
        stacks: { 'network/vpc.ts': 'export const x = 1;\n' },
        noConfig: false,
      });

      const r = runCli(['ls'], { cwd: dir });

      expect(r.status).toBe(0);
      // a stack aninhada aparece pelo caminho relativo, sem extensão
      expect(r.stdout).toContain('Stacks disponíveis:');
      expect(r.stdout).toContain('network/vpc');
      expect(r.stdout).not.toContain('Nenhuma stack encontrada em stacks/');
    });

    test('mistura: lista as do topo e as de subpasta', () => {
      dir = makeProject({
        stacks: {
          'top.ts': 'export const a = 1;\n',
          'network/vpc.ts': 'export const b = 2;\n',
          'compute/ec2.ts': 'export const c = 3;\n',
        },
      });

      const r = runCli(['ls'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain('top');
      // as aninhadas aparecem pelo caminho relativo
      expect(r.stdout).toContain('network/vpc');
      expect(r.stdout).toContain('compute/ec2');
      const modLines = r.stdout.split('\n').filter(l => l.includes('modificado:'));
      expect(modLines).toHaveLength(3);
    });
  });

  describe('caminhos sem stacks', () => {
    test('sem o diretório stacks/ instrui a rodar init', () => {
      dir = makeProject({ noStacks: true });

      const r = runCli(['ls'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Diretório stacks/ não encontrado');
      expect(r.stdout).toContain('iacmp init');
      expect(r.stdout).not.toContain('Stacks disponíveis');
    });

    test('stacks/ vazio reporta "Nenhuma stack encontrada"', () => {
      // stacks: {} cria o diretório stacks/ sem nenhum arquivo dentro
      dir = makeProject({ stacks: {} });

      const r = runCli(['ls'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Nenhuma stack encontrada em stacks/');
      expect(r.stdout).not.toContain('Stacks disponíveis');
    });

    test('stacks/ com .js (default do harness) é listado', () => {
      // makeProject() default gera stacks em `.js`; o `ls` reconhece `.js`
      // (como synth/deploy), então o projeto "padrão" aparece com a stack.
      dir = makeProject(); // default: main-stack.js

      const r = runCli(['ls'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Stacks disponíveis:');
      expect(r.stdout).toContain('main-stack');
      expect(r.stdout).not.toContain('Nenhuma stack encontrada em stacks/');
    });
  });
});
