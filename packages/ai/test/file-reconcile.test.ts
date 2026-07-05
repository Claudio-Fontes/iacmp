import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeOrphanedGeneratedFiles } from '../src/tools/file-deleter';
import { GeneratedFile } from '../src/parser/code-extractor';

function write(dir: string, rel: string, content = '// gerado\n'): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function exists(dir: string, rel: string): boolean {
  return fs.existsSync(path.join(dir, rel));
}

function file(p: string): GeneratedFile {
  return { path: p, content: `// ${p}\n` };
}

// Coleta todas as .ts em stacks/ (recursivo), relativas ao projeto.
function listStacks(dir: string): string[] {
  const root = path.join(dir, 'stacks');
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) out.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

describe('removeOrphanedGeneratedFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-reconcile-'));
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Cenário real p11 AWS: a tentativa 1 gerou bucket e lambda em stacks separadas;
  // o guard de synth pediu para juntá-los. A tentativa 2 gera bucket+lambda no
  // mesmo arquivo. Sem reconciliação, os arquivos antigos ficariam em stacks/ e o
  // synth continuaria vendo constructs duplicados.
  test('remove os stacks órfãos da tentativa anterior e converge para o novo conjunto', () => {
    // Tentativa 1: bucket e lambda em stacks separadas (o guard de synth vai
    // pedir para juntá-las).
    const attempt1 = [
      'stacks/storage/raw-data-bucket-stack.ts',
      'stacks/compute/data-processor-lambda-stack.ts',
      'stacks/pipeline/raw-data-processing-stack.ts',
      'src/processData.ts',
    ];
    for (const f of attempt1) write(dir, f);
    // synth-out gerado a partir de um stack órfão (deve sumir junto)
    write(dir, 'synth-out/aws/raw-data-bucket-stack.json', '{}\n');

    // Tentativa 2 (correção): bucket+lambda no mesmo arquivo.
    const attempt2: GeneratedFile[] = [
      file('stacks/storage/raw-data-bucket-and-lambda-stack.ts'),
      file('stacks/pipeline/raw-data-processing-stack.ts'),
      file('src/processData.ts'),
    ];

    // Ordem real do runtime: 1º escreve a nova geração, 2º reconcilia os órfãos.
    for (const f of attempt2) write(dir, f.path, f.content);
    const removed = removeOrphanedGeneratedFiles(attempt1, attempt2, dir);

    // Órfãos removidos
    expect(removed.sort()).toEqual([
      'stacks/compute/data-processor-lambda-stack.ts',
      'stacks/storage/raw-data-bucket-stack.ts',
    ]);
    expect(exists(dir, 'stacks/storage/raw-data-bucket-stack.ts')).toBe(false);
    expect(exists(dir, 'stacks/compute/data-processor-lambda-stack.ts')).toBe(false);
    // synth-out do órfão também some
    expect(exists(dir, 'synth-out/aws/raw-data-bucket-stack.json')).toBe(false);
    // Presentes em ambas as tentativas permanecem
    expect(exists(dir, 'stacks/pipeline/raw-data-processing-stack.ts')).toBe(true);
    expect(exists(dir, 'src/processData.ts')).toBe(true);

    // Convergência: o conjunto final de stacks é EXATAMENTE o da tentativa 2,
    // sem nenhum órfão da tentativa 1.
    expect(listStacks(dir)).toEqual([
      'stacks/pipeline/raw-data-processing-stack.ts',
      'stacks/storage/raw-data-bucket-and-lambda-stack.ts',
    ]);
  });

  test('geração normal (sem tentativa anterior) não remove nada', () => {
    write(dir, 'stacks/api-stack.ts');
    const removed = removeOrphanedGeneratedFiles([], [file('stacks/api-stack.ts')], dir);
    expect(removed).toEqual([]);
    expect(exists(dir, 'stacks/api-stack.ts')).toBe(true);
  });

  test('conjunto idêntico entre tentativas não remove nada', () => {
    write(dir, 'stacks/api-stack.ts');
    write(dir, 'src/handler.ts');
    const same = ['stacks/api-stack.ts', 'src/handler.ts'];
    const removed = removeOrphanedGeneratedFiles(same, [file('stacks/api-stack.ts'), file('src/handler.ts')], dir);
    expect(removed).toEqual([]);
    expect(exists(dir, 'stacks/api-stack.ts')).toBe(true);
    expect(exists(dir, 'src/handler.ts')).toBe(true);
  });

  test('nunca remove arquivo feito à mão que a IA não gerou (fora de previousPaths)', () => {
    write(dir, 'stacks/hand-made-stack.ts', '// escrito pelo usuário\n');
    write(dir, 'stacks/old-ai-stack.ts');
    // A IA só rastreia o que ELA escreveu — o hand-made não está em previousPaths.
    const removed = removeOrphanedGeneratedFiles(['stacks/old-ai-stack.ts'], [file('stacks/new-ai-stack.ts')], dir);
    expect(removed).toEqual(['stacks/old-ai-stack.ts']);
    expect(exists(dir, 'stacks/old-ai-stack.ts')).toBe(false);
    // o hand-made sobrevive mesmo estando ausente do novo conjunto
    expect(exists(dir, 'stacks/hand-made-stack.ts')).toBe(true);
  });

  test('ignora caminhos que não são artefatos gerados (config/docs) mesmo que estejam em previousPaths', () => {
    write(dir, 'package.json', '{}\n');
    write(dir, 'README.md', '# doc\n');
    write(dir, 'iacmp.json', '{}\n');
    const removed = removeOrphanedGeneratedFiles(
      ['package.json', 'README.md', 'iacmp.json'],
      [file('stacks/api-stack.ts')],
      dir
    );
    expect(removed).toEqual([]);
    expect(exists(dir, 'package.json')).toBe(true);
    expect(exists(dir, 'README.md')).toBe(true);
    expect(exists(dir, 'iacmp.json')).toBe(true);
  });

  test('nunca remove fora do projeto por path traversal', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-outside-'));
    const victim = path.join(outside, 'victim.ts');
    fs.writeFileSync(victim, '// não pode sumir\n', 'utf-8');
    try {
      const removed = removeOrphanedGeneratedFiles(['../' + path.basename(outside) + '/victim.ts'], [], dir);
      expect(removed).toEqual([]);
      expect(fs.existsSync(victim)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('remove handler órfão em src/ e mantém o que segue na nova geração', () => {
    write(dir, 'src/listItems.ts');
    write(dir, 'src/createItem.ts');
    const removed = removeOrphanedGeneratedFiles(
      ['src/listItems.ts', 'src/createItem.ts'],
      [file('src/createItem.ts')],
      dir
    );
    expect(removed).toEqual(['src/listItems.ts']);
    expect(exists(dir, 'src/listItems.ts')).toBe(false);
    expect(exists(dir, 'src/createItem.ts')).toBe(true);
  });
});
