import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chunkStackFile, chunkIacmpDocs, chunkKnowledgeFile } from '../src/rag/chunker';

describe('chunkStackFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('extrai constructs de stack TypeScript', () => {
    const content = `
import { Stack, Compute, Storage } from '@iacmp/core';
const stack = new Stack('prod');
new Compute.Instance(stack, 'WebServer', { instanceType: 'medium', image: 'ubuntu-22.04' });
new Storage.Bucket(stack, 'Assets', { versioning: true });
`;
    const file = path.join(tmpDir, 'stacks', 'prod.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);

    const chunks = chunkStackFile(file, tmpDir);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const ids = chunks.map(c => c.metadata.constructId);
    expect(ids).toContain('WebServer');
    expect(ids).toContain('Assets');
  });

  test('metadata.source é project-stack', () => {
    const file = path.join(tmpDir, 'stacks', 'app.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `new Compute.Instance(stack, 'Api', { instanceType: 'small', image: 'x' });`);

    const chunks = chunkStackFile(file, tmpDir);
    for (const c of chunks) {
      expect(c.metadata.source).toBe('project-stack');
    }
  });

  test('arquivo sem constructs gera chunk do arquivo inteiro', () => {
    const file = path.join(tmpDir, 'stacks', 'empty.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `// apenas comentário\nconst x = 1;`);

    const chunks = chunkStackFile(file, tmpDir);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toContain(':full');
  });

  test('chunk.id contém caminho relativo', () => {
    const file = path.join(tmpDir, 'stacks', 'api.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });`);

    const chunks = chunkStackFile(file, tmpDir);
    expect(chunks[0].id).toContain('stacks/api.ts');
  });
});

describe('chunkIacmpDocs', () => {
  const systemPrompt = `
# Sistema iacmp

## Introdução
Texto de intro.

### Compute.Instance
Instância de VM. Props: instanceType, image.

### Storage.Bucket
Bucket de armazenamento. Props: versioning, publicAccess.

### Fn.Lambda
Função serverless. Props: runtime, handler, code.
`;

  test('retorna chunk por seção ###', () => {
    const chunks = chunkIacmpDocs(systemPrompt);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  test('metadata.source é iacmp-docs', () => {
    const chunks = chunkIacmpDocs(systemPrompt);
    for (const c of chunks) {
      expect(c.metadata.source).toBe('iacmp-docs');
    }
  });

  test('chunk.id é derivado do título da seção', () => {
    const chunks = chunkIacmpDocs(systemPrompt);
    const ids = chunks.map(c => c.id);
    expect(ids.some(id => id.includes('Compute'))).toBe(true);
    expect(ids.some(id => id.includes('Storage'))).toBe(true);
  });

  test('ignora seções muito curtas', () => {
    const sparse = `### TituloA\nok\n### TituloB\n${' texto longo '.repeat(5)}`;
    const chunks = chunkIacmpDocs(sparse);
    // TituloA (< 30 chars) deve ser ignorado
    expect(chunks.every(c => !c.id.includes('TituloA'))).toBe(true);
  });

  test('prompt vazio retorna array vazio', () => {
    expect(chunkIacmpDocs('')).toHaveLength(0);
  });
});

describe('chunkKnowledgeFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('divide arquivo markdown em chunks por seção', () => {
    const md = `# AWS Lambda

## Limites
Timeout máximo: 15 minutos. Memória: 128MB a 10GB.

## Preço
$0.20 por milhão de invocações.

## Casos de uso
Processamento de eventos, APIs REST, automações.
`;
    const file = path.join(tmpDir, 'limits.md');
    fs.writeFileSync(file, md);

    const chunks = chunkKnowledgeFile(file, 'aws');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test('metadata.platform é propagado', () => {
    const md = `## Serviço\nConteúdo suficiente para não ser ignorado porque precisa de mais de 50 chars aqui.`;
    const file = path.join(tmpDir, 'test.md');
    fs.writeFileSync(file, md);

    const chunks = chunkKnowledgeFile(file, 'azure');
    expect(chunks.every(c => c.metadata.platform === 'azure')).toBe(true);
  });

  test('metadata.source é platform-knowledge', () => {
    const md = `## VNet\nVirtual Network é o bloco fundamental de rede no Azure com suporte a subnets e peering.`;
    const file = path.join(tmpDir, 'net.md');
    fs.writeFileSync(file, md);

    const chunks = chunkKnowledgeFile(file, 'azure');
    expect(chunks.every(c => c.metadata.source === 'platform-knowledge')).toBe(true);
  });

  test('seções > 2000 chars são subdivididas', () => {
    const longSection = `## Seção Longa\n\n${'parágrafo com conteúdo técnico importante. '.repeat(30)}\n\n${'outro parágrafo com mais detalhes técnicos. '.repeat(30)}`;
    const file = path.join(tmpDir, 'long.md');
    fs.writeFileSync(file, longSection);

    const chunks = chunkKnowledgeFile(file, 'gcp');
    // Deve ter sido subdividida em mais de 1 chunk
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('chunk.content inclui prefixo [PLATFORM]', () => {
    const md = `## IAM\nControle de acesso granular por recurso no GCP, diferente do AWS que é por identidade central.`;
    const file = path.join(tmpDir, 'iam.md');
    fs.writeFileSync(file, md);

    const chunks = chunkKnowledgeFile(file, 'gcp');
    expect(chunks[0].content).toContain('[GCP]');
  });
});
