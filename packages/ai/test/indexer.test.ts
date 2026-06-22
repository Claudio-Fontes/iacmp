import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildIndexes } from '../src/rag/indexer';
import { bm25Search } from '../src/rag/bm25';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-indexer-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-app', dependencies: {} }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));

  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(
    path.join(dir, 'src', 'handler.ts'),
    'export function processOrder() { return "pedido processado"; }'
  );

  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(
    path.join(dir, 'test', 'handler.test.ts'),
    'test("segredo de teste nao deve aparecer", () => {});'
  );

  fs.writeFileSync(path.join(dir, '.env'), 'API_SECRET=segredo123');

  fs.mkdirSync(path.join(dir, 'node_modules', 'alguma-lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'alguma-lib', 'index.js'), 'module.exports = {};');

  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));

  return dir;
}

describe('buildIndexes — corpus project-source', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('indexa src/ e configs, mas exclui test/, .env, node_modules e lockfiles', async () => {
    dir = makeProject();
    const indexes = await buildIndexes({ projectDir: dir, systemPromptTemplate: '' });

    const srcHits = bm25Search(indexes.sourceIndex, 'processOrder pedido', 5);
    expect(srcHits.length).toBeGreaterThan(0);
    const srcChunk = indexes.chunkMap.get(srcHits[0].id);
    expect(srcChunk?.metadata.file).toBe('src/handler.ts');

    const sourceChunks = [...indexes.chunkMap.values()].filter(c => c.metadata.source === 'project-source');
    const files = sourceChunks.map(c => c.metadata.file);

    expect(files).toContain('package.json');
    expect(files).toContain('tsconfig.json');

    expect(files.some(f => f?.startsWith('test/'))).toBe(false);
    expect(files).not.toContain('package-lock.json');
    expect(files.some(f => f?.includes('node_modules'))).toBe(false);
    expect(sourceChunks.some(c => c.content.includes('segredo123'))).toBe(false);
    expect(sourceChunks.some(c => c.content.includes('segredo de teste'))).toBe(false);
  });

  test('reutiliza chunks do cache quando o código-fonte não mudou', async () => {
    dir = makeProject();
    const first = await buildIndexes({ projectDir: dir, systemPromptTemplate: '' });
    const firstSourceCount = [...first.chunkMap.values()].filter(c => c.metadata.source === 'project-source').length;

    const second = await buildIndexes({ projectDir: dir, systemPromptTemplate: '' });
    const secondSourceCount = [...second.chunkMap.values()].filter(c => c.metadata.source === 'project-source').length;

    expect(secondSourceCount).toBe(firstSourceCount);
    expect(fs.existsSync(path.join(dir, '.iacmp', 'rag-source-index.json'))).toBe(true);
  });

  test('projeto sem código-fonte fora de stacks/ não quebra a indexação', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-indexer-empty-'));
    const indexes = await buildIndexes({ projectDir: dir, systemPromptTemplate: '' });
    const sourceChunks = [...indexes.chunkMap.values()].filter(c => c.metadata.source === 'project-source');
    expect(sourceChunks).toHaveLength(0);
  });
});
