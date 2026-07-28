import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Testing } from '../src';

describe('Testing.loadStack', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-core-testing-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeStackFile(filename: string, content: string): string {
    const file = path.join(dir, filename);
    fs.writeFileSync(file, content);
    return file;
  }

  test('carrega a stack exportada via export default e encontra um construct pelo id', () => {
    writeStackFile(
      'minha-stack.ts',
      `
      import { Stack, Compute } from '${path.resolve(__dirname, '..', 'src')}';
      const stack = new Stack('minha-stack');
      new Compute.Instance(stack, 'Web', { instanceType: 'small', image: 'ubuntu-22.04' });
      export default stack;
      `
    );

    const loaded = Testing.loadStack(path.join(dir, 'minha-stack'));
    expect(loaded.raw.name).toBe('minha-stack');

    const web = loaded.findResource('Web');
    expect(web).toBeDefined();
    expect(web?.type).toBe('Compute.Instance');
    expect((web?.props as any).instanceType).toBe('small');
  });

  test('findResource retorna undefined quando o id não existe', () => {
    writeStackFile(
      'vazia-stack.ts',
      `
      import { Stack } from '${path.resolve(__dirname, '..', 'src')}';
      const stack = new Stack('vazia');
      export default stack;
      `
    );

    const loaded = Testing.loadStack(path.join(dir, 'vazia-stack'));
    expect(loaded.findResource('NaoExiste')).toBeUndefined();
  });

  test('lança erro claro quando o módulo não exporta uma Stack', () => {
    writeStackFile('invalida-stack.ts', `export const algo = 42;`);

    expect(() => Testing.loadStack(path.join(dir, 'invalida-stack'))).toThrow(
      /não exporta uma Stack válida/
    );
  });
});
