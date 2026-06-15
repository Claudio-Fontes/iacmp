import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VectorStore } from '../src/rag/vector-store';

function makeVector(size: number, seed: number): number[] {
  // Vetor determinístico por seed — não normalizado (VectorStore normaliza internamente)
  return Array.from({ length: size }, (_, i) => Math.sin(seed * (i + 1)));
}

describe('VectorStore — operações básicas', () => {
  test('inicia vazio', () => {
    const store = new VectorStore();
    expect(store.size()).toBe(0);
  });

  test('add aumenta size', () => {
    const store = new VectorStore();
    store.add('a', makeVector(8, 1), { id: 'a', source: 'platform-knowledge' });
    store.add('b', makeVector(8, 2), { id: 'b', source: 'platform-knowledge' });
    expect(store.size()).toBe(2);
  });

  test('clear zera o store', () => {
    const store = new VectorStore();
    store.add('a', makeVector(8, 1), { id: 'a', source: 'platform-knowledge' });
    store.clear();
    expect(store.size()).toBe(0);
  });

  test('search em store vazio retorna []', () => {
    const store = new VectorStore();
    expect(store.search(makeVector(8, 1))).toHaveLength(0);
  });
});

describe('VectorStore — similaridade cosseno', () => {
  test('vetor idêntico retorna score ≈ 1', () => {
    const store = new VectorStore();
    const v = makeVector(16, 42);
    store.add('x', v, { id: 'x', source: 'platform-knowledge' });
    const [result] = store.search(v, 1);
    expect(result.score).toBeCloseTo(1, 3);
  });

  test('retorna o mais similar no topo', () => {
    const store = new VectorStore();
    const target = makeVector(16, 7);
    store.add('similar', target, { id: 'similar', source: 'platform-knowledge' });
    store.add('diferente', makeVector(16, 99), { id: 'diferente', source: 'platform-knowledge' });
    const [top] = store.search(target, 2);
    expect(top.id).toBe('similar');
  });

  test('topK limita resultados', () => {
    const store = new VectorStore();
    for (let i = 0; i < 10; i++) {
      store.add(`v${i}`, makeVector(8, i + 1), { id: `v${i}`, source: 'platform-knowledge' });
    }
    expect(store.search(makeVector(8, 1), 3)).toHaveLength(3);
  });

  test('scores retornados em ordem decrescente', () => {
    const store = new VectorStore();
    for (let i = 0; i < 5; i++) {
      store.add(`v${i}`, makeVector(8, i + 1), { id: `v${i}`, source: 'platform-knowledge' });
    }
    const results = store.search(makeVector(8, 1), 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test('metadata é retornada corretamente', () => {
    const store = new VectorStore();
    const meta = { id: 'chunk-1', source: 'platform-knowledge', platform: 'aws', section: 'Lambda' };
    store.add('chunk-1', makeVector(8, 3), meta);
    const [result] = store.search(makeVector(8, 3), 1);
    expect(result.metadata).toEqual(meta);
  });
});

describe('VectorStore — persistência binária', () => {
  let tmpDir: string;
  let indexPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vstore-test-'));
    indexPath = path.join(tmpDir, 'vector-index.bin');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('save + load recupera entradas com fidelidade', () => {
    const store = new VectorStore();
    const meta1 = { id: 'a1', source: 'platform-knowledge', platform: 'aws' };
    const meta2 = { id: 'b2', source: 'platform-knowledge', platform: 'azure' };
    store.add('a1', makeVector(8, 10), meta1);
    store.add('b2', makeVector(8, 20), meta2);
    store.save(indexPath);

    const store2 = new VectorStore();
    const ok = store2.load(indexPath);
    expect(ok).toBe(true);
    expect(store2.size()).toBe(2);
  });

  test('load em arquivo inexistente retorna false', () => {
    const store = new VectorStore();
    expect(store.load('/nao/existe/index.bin')).toBe(false);
  });

  test('load em arquivo corrompido retorna false', () => {
    fs.writeFileSync(indexPath, 'dados corrompidos que não são binário válido');
    const store = new VectorStore();
    expect(store.load(indexPath)).toBe(false);
  });

  test('load em arquivo com magic errado retorna false', () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(0xDEADBEEF, 0); // magic errado
    fs.writeFileSync(indexPath, buf);
    const store = new VectorStore();
    expect(store.load(indexPath)).toBe(false);
  });

  test('save cria diretório se não existir', () => {
    const deepPath = path.join(tmpDir, 'sub', 'dir', 'index.bin');
    const store = new VectorStore();
    store.add('x', makeVector(4, 1), { id: 'x', source: 'platform-knowledge' });
    expect(() => store.save(deepPath)).not.toThrow();
    expect(fs.existsSync(deepPath)).toBe(true);
  });

  test('busca após load produz resultado correto', () => {
    const v = makeVector(16, 5);
    const store = new VectorStore();
    store.add('target', v, { id: 'target', source: 'platform-knowledge' });
    store.add('other', makeVector(16, 99), { id: 'other', source: 'platform-knowledge' });
    store.save(indexPath);

    const store2 = new VectorStore();
    store2.load(indexPath);
    const [top] = store2.search(v, 1);
    expect(top.id).toBe('target');
    expect(top.score).toBeCloseTo(1, 2);
  });
});
