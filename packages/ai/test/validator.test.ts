import * as fs from 'fs';
import * as path from 'path';
import { validateTypeScript } from '../src/parser/validator';

describe('validateTypeScript', () => {
  // packages/ai é o próprio projectDir do teste — `chalk` está realmente
  // instalado em node_modules aqui, então serve de "dependência de terceiros
  // já instalada" sem precisar instalar nada só para o teste.
  const projectDir = path.resolve(__dirname, '..');

  afterEach(() => {
    // a função já limpa o próprio tmpDir num finally — isso é só uma rede de
    // segurança caso um teste falhe antes da limpeza rodar.
    for (const entry of fs.readdirSync(projectDir)) {
      if (entry.startsWith('.iacmp-validate-')) {
        fs.rmSync(path.join(projectDir, entry), { recursive: true, force: true });
      }
    }
  });

  test('código que importa um pacote de terceiros JÁ INSTALADO no projeto valida com sucesso (regressão: tmpDir fora do projeto não via node_modules real)', () => {
    const result = validateTypeScript(
      [{ path: 'handler.ts', content: `import chalk from 'chalk';\nexport const x = chalk.red('oi');\n` }],
      projectDir
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('código que importa um pacote que NÃO existe de verdade ainda falha (a checagem real continua funcionando)', () => {
    const result = validateTypeScript(
      [{ path: 'handler.ts', content: `import { algo } from 'pacote-que-nao-existe-de-verdade-12345';\n` }],
      projectDir
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('pacote-que-nao-existe-de-verdade-12345');
  });

  test('código com erro de tipo de verdade (não relacionado a import) ainda é reportado', () => {
    const result = validateTypeScript(
      [{ path: 'handler.ts', content: `const x: number = 'isso não é um number';\n` }],
      projectDir
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('limpa o diretório temporário criado dentro do projeto após validar', () => {
    validateTypeScript([{ path: 'handler.ts', content: `export const x = 1;\n` }], projectDir);
    const leftover = fs.readdirSync(projectDir).filter((e) => e.startsWith('.iacmp-validate-'));
    expect(leftover).toEqual([]);
  });

  test('preserva a árvore de diretórios: mesmo basename em pastas diferentes NÃO colide', () => {
    // regressão: o flatten antigo fazia src/a/index.ts sobrescrever src/b/index.ts
    const result = validateTypeScript(
      [
        { path: 'src/a/index.ts', content: `export const a: number = 1;\n` },
        { path: 'src/b/index.ts', content: `export const b: string = 'x';\n` },
      ],
      projectDir
    );
    expect(result.valid).toBe(true);
  });

  test('import relativo entre arquivos gerados resolve (./util)', () => {
    const result = validateTypeScript(
      [
        { path: 'src/util.ts', content: `export function soma(a: number, b: number): number { return a + b; }\n` },
        { path: 'src/handler.ts', content: `import { soma } from './util';\nexport const x = soma(1, 2);\n` },
      ],
      projectDir
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('path malicioso (../fora) é ignorado, não escapa do tmpDir', () => {
    const escapePath = path.join(projectDir, 'ESCAPOU.ts');
    validateTypeScript(
      [{ path: '../ESCAPOU.ts', content: `export const x = 1;\n` }],
      projectDir
    );
    expect(fs.existsSync(escapePath)).toBe(false);
  });
});
