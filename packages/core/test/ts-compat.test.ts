import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectTypeScriptMajor, tsCompilerOptions } from '../src';

function makeProjectWithTs(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-tscompat-'));
  const tsDir = path.join(dir, 'node_modules', 'typescript');
  fs.mkdirSync(tsDir, { recursive: true });
  fs.writeFileSync(path.join(tsDir, 'package.json'), JSON.stringify({ name: 'typescript', version }));
  return dir;
}

describe('detectTypeScriptMajor', () => {
  let dir: string;
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  test('lê a major do typescript instalado', () => {
    dir = makeProjectWithTs('5.5.4');
    expect(detectTypeScriptMajor(dir)).toBe(5);
  });

  test('detecta TS 6', () => {
    dir = makeProjectWithTs('6.0.3');
    expect(detectTypeScriptMajor(dir)).toBe(6);
  });

  test('null quando typescript não está instalado', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-nots-'));
    expect(detectTypeScriptMajor(dir)).toBeNull();
  });
});

describe('tsCompilerOptions', () => {
  let dir: string;
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  test('TS 5 → ignoreDeprecations 5.0', () => {
    dir = makeProjectWithTs('5.5.4');
    expect(tsCompilerOptions(dir).ignoreDeprecations).toBe('5.0');
  });

  test('TS 6 → ignoreDeprecations 6.0', () => {
    dir = makeProjectWithTs('6.0.3');
    expect(tsCompilerOptions(dir).ignoreDeprecations).toBe('6.0');
  });

  test('sem typescript → omite ignoreDeprecations (não quebra TS antigo)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-nots-'));
    expect(tsCompilerOptions(dir).ignoreDeprecations).toBeUndefined();
  });

  test('base sempre presente, extra sobrescreve', () => {
    dir = makeProjectWithTs('5.5.4');
    const opts = tsCompilerOptions(dir, { noEmit: true, strict: true });
    expect(opts.target).toBe('ES2022');
    expect(opts.moduleResolution).toBe('node');
    expect(opts.noEmit).toBe(true);
    expect(opts.strict).toBe(true); // extra venceu o default false
  });
});
