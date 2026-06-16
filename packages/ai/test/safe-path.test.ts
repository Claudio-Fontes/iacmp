import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  safeJoin,
  isWithin,
  errMessage,
  assertValidStackName,
  assertValidProvider,
  NATIVE_PROVIDERS,
} from '../src/tools/safe-path';

describe('safeJoin', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-safejoin-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('aceita caminho relativo normal dentro do projeto', () => {
    const result = safeJoin(baseDir, 'stacks/api.ts');
    expect(result).toBe(path.resolve(baseDir, 'stacks/api.ts'));
    expect(result.startsWith(path.resolve(baseDir) + path.sep)).toBe(true);
  });

  test('aceita subpasta legitima profunda', () => {
    const result = safeJoin(baseDir, 'stacks/compute/network/api-gateway-stack.ts');
    expect(result).toBe(path.resolve(baseDir, 'stacks/compute/network/api-gateway-stack.ts'));
  });

  test('aceita arquivo na raiz do projeto', () => {
    const result = safeJoin(baseDir, 'iacmp.json');
    expect(result).toBe(path.resolve(baseDir, 'iacmp.json'));
  });

  test('rejeita .. no inicio do caminho', () => {
    expect(() => safeJoin(baseDir, '../escaped.ts')).toThrow(/fora do diretório do projeto|traversal/i);
  });

  test('rejeita .. no meio do caminho que escapa do projeto', () => {
    expect(() => safeJoin(baseDir, 'stacks/../../escaped.ts')).toThrow(/fora do diretório|traversal/i);
  });

  test('aceita .. no meio quando o resultado ainda esta dentro do projeto', () => {
    const result = safeJoin(baseDir, 'stacks/foo/../api.ts');
    expect(result).toBe(path.resolve(baseDir, 'stacks/api.ts'));
  });

  test('rejeita caminho absoluto /etc/passwd', () => {
    expect(() => safeJoin(baseDir, '/etc/passwd')).toThrow(/absoluto/i);
  });

  test('rejeita caminho absoluto para home do usuario', () => {
    expect(() => safeJoin(baseDir, '/Users/alex/.zshrc')).toThrow(/absoluto/i);
  });

  test('rejeita string vazia', () => {
    expect(() => safeJoin(baseDir, '')).toThrow(/vazio|inválido/i);
  });

  test('rejeita travessia profunda com varios ..', () => {
    expect(() => safeJoin(baseDir, '../../../../../etc/passwd')).toThrow(/fora do diretório|traversal/i);
  });

  test('link simbolico que aponta para fora — safeJoin nao segue symlink (path layer)', () => {
    // safeJoin opera puramente em nivel de strings/path; nao resolve symlinks.
    // O conteudo dentro do projeto continua sendo considerado dentro,
    // mesmo se o filesystem subjacente apontar para fora. Documentamos o limite.
    const linkPath = path.join(baseDir, 'inside-link');
    const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-outside-'));
    try {
      fs.symlinkSync(outsideTarget, linkPath);
      const result = safeJoin(baseDir, 'inside-link/file.ts');
      expect(result.startsWith(path.resolve(baseDir) + path.sep)).toBe(true);
    } catch (err) {
      // Em ambientes sem permissao p/ symlink (ex: Windows CI restrito), pulamos.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    } finally {
      try {
        fs.rmSync(outsideTarget, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe('isWithin', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-iswithin-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('retorna true para caminho relativo dentro', () => {
    expect(isWithin(baseDir, 'stacks/api.ts')).toBe(true);
  });

  test('retorna true para o proprio baseDir', () => {
    expect(isWithin(baseDir, baseDir)).toBe(true);
  });

  test('retorna false para .. que escapa', () => {
    expect(isWithin(baseDir, '../outside')).toBe(false);
  });

  test('retorna false para absoluto fora', () => {
    expect(isWithin(baseDir, '/etc/passwd')).toBe(false);
  });

  test('retorna true para absoluto dentro do baseDir', () => {
    expect(isWithin(baseDir, path.join(baseDir, 'stacks/api.ts'))).toBe(true);
  });
});

describe('errMessage', () => {
  test('extrai mensagem de Error', () => {
    expect(errMessage(new Error('boom'))).toBe('boom');
  });

  test('retorna string crua quando recebida', () => {
    expect(errMessage('falha textual')).toBe('falha textual');
  });

  test('extrai .message de objeto plain', () => {
    expect(errMessage({ message: 'do objeto' })).toBe('do objeto');
  });

  test('faz JSON.stringify para objeto sem message', () => {
    expect(errMessage({ code: 42 })).toContain('42');
  });

  test('lida com null/undefined sem crashar', () => {
    expect(typeof errMessage(null)).toBe('string');
    expect(typeof errMessage(undefined)).toBe('string');
  });
});

describe('assertValidStackName', () => {
  test('aceita nomes alfanumericos com hifen e underscore', () => {
    expect(() => assertValidStackName('my-stack_01')).not.toThrow();
    expect(() => assertValidStackName('Stack123')).not.toThrow();
  });

  test('rejeita ponto e virgula', () => {
    expect(() => assertValidStackName('stack;rm -rf /')).toThrow(/inválido/i);
  });

  test('rejeita espaco', () => {
    expect(() => assertValidStackName('stack name')).toThrow(/inválido/i);
  });

  test('rejeita string vazia', () => {
    expect(() => assertValidStackName('')).toThrow(/inválido/i);
  });

  test('rejeita caracteres de shell metacaracteres', () => {
    expect(() => assertValidStackName('stack$(whoami)')).toThrow(/inválido/i);
    expect(() => assertValidStackName('stack`id`')).toThrow(/inválido/i);
    expect(() => assertValidStackName('stack|cat')).toThrow(/inválido/i);
  });
});

describe('assertValidProvider', () => {
  test('aceita providers nativos', () => {
    for (const p of NATIVE_PROVIDERS) {
      expect(() => assertValidProvider(p)).not.toThrow();
    }
  });

  test('rejeita provider fora da allowlist nativa', () => {
    expect(() => assertValidProvider('digitalocean')).toThrow(/não permitido|allowlist/i);
  });

  test('aceita provider extra via allowlist customizada', () => {
    expect(() => assertValidProvider('digitalocean', ['aws', 'digitalocean'])).not.toThrow();
  });

  test('rejeita provider com caracteres de shell', () => {
    expect(() => assertValidProvider('aws;rm')).toThrow(/inválido/i);
    expect(() => assertValidProvider('aws$(x)')).toThrow(/inválido/i);
  });

  test('rejeita provider vazio', () => {
    expect(() => assertValidProvider('')).toThrow(/inválido/i);
  });
});
