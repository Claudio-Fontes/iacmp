import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Chunk, chunkStackFile, chunkIacmpDocs, chunkKnowledgeFile } from './chunker';
import { Contextualizer } from './contextualizer';
import { buildBM25Index, BM25Index } from './bm25';
import { RetrieverIndexes } from './retriever';

const INDEX_FILE = '.iacmp/rag-index.json';
const KNOWLEDGE_DIR = path.join(__dirname, '../knowledge');

interface PersistedIndex {
  projectHash: string;
  chunks: Chunk[];
  builtAt: string;
}

// Hash dos arquivos de stack para detectar mudanças
function hashProjectStacks(projectDir: string): string {
  const stacksDir = path.join(projectDir, 'stacks');
  if (!fs.existsSync(stacksDir)) return 'empty';

  const findFiles = (dir: string): string[] => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...findFiles(full));
      else if (e.name.endsWith('.ts')) files.push(full);
    }
    return files.sort();
  };

  const files = findFiles(stacksDir);
  const content = files.map(f => `${f}:${fs.statSync(f).mtimeMs}`).join('\n');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

// Carrega chunks do projeto do disco (se o hash ainda bater)
function loadPersistedProjectChunks(projectDir: string, currentHash: string): Chunk[] | null {
  const indexPath = path.join(projectDir, INDEX_FILE);
  if (!fs.existsSync(indexPath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as PersistedIndex;
    if (data.projectHash !== currentHash) return null;
    return data.chunks;
  } catch {
    return null;
  }
}

// Persiste os chunks do projeto para evitar reindexar toda vez
function saveProjectChunks(projectDir: string, hash: string, chunks: Chunk[]): void {
  const indexPath = path.join(projectDir, INDEX_FILE);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const data: PersistedIndex = {
    projectHash: hash,
    chunks,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), 'utf-8');
}

// Carrega todos os markdowns de knowledge/
function loadKnowledgeChunks(): Chunk[] {
  const chunks: Chunk[] = [];
  if (!fs.existsSync(KNOWLEDGE_DIR)) return chunks;

  const platforms = ['aws', 'azure', 'gcp', 'cross-cloud'] as const;
  for (const platform of platforms) {
    const platformDir = path.join(KNOWLEDGE_DIR, platform);
    if (!fs.existsSync(platformDir)) continue;

    const files = fs.readdirSync(platformDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        const fileChunks = chunkKnowledgeFile(path.join(platformDir, file), platform);
        chunks.push(...fileChunks);
      } catch {
        // arquivo inválido, ignora
      }
    }
  }

  return chunks;
}

export interface IndexerOptions {
  projectDir: string;
  systemPromptTemplate: string;
  anthropicApiKey?: string;           // se fornecido, usa Contextual Retrieval
  useContextualRetrieval?: boolean;   // padrão: true se apiKey fornecida
  onProgress?: (msg: string) => void;
}

// Constrói todos os índices necessários para o RAG
export async function buildIndexes(options: IndexerOptions): Promise<RetrieverIndexes> {
  const {
    projectDir,
    systemPromptTemplate,
    anthropicApiKey,
    useContextualRetrieval = !!anthropicApiKey,
    onProgress,
  } = options;

  const log = (msg: string) => onProgress?.(msg);

  // ── Corpus 1: Stacks do projeto ──────────────────────────────────────
  log('Indexando stacks do projeto...');
  const currentHash = hashProjectStacks(projectDir);
  let projectChunks = loadPersistedProjectChunks(projectDir, currentHash);

  if (!projectChunks) {
    log('Stacks mudaram — reindexando...');
    const stacksDir = path.join(projectDir, 'stacks');
    const rawChunks: Chunk[] = [];

    if (fs.existsSync(stacksDir)) {
      const findFiles = (dir: string): string[] => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) files.push(...findFiles(full));
          else if (e.name.endsWith('.ts')) files.push(full);
        }
        return files;
      };

      for (const file of findFiles(stacksDir)) {
        rawChunks.push(...chunkStackFile(file, projectDir));
      }
    }

    // Contextual Retrieval para corpus do projeto
    if (useContextualRetrieval && anthropicApiKey && rawChunks.length > 0) {
      log(`Aplicando Contextual Retrieval em ${rawChunks.length} chunks de stacks...`);
      const contextualizer = new Contextualizer(anthropicApiKey);
      const fullDocument = rawChunks.map(c => c.content).join('\n\n');
      projectChunks = await contextualizer.enrichBatch(rawChunks, fullDocument, {
        concurrency: 5,
        onProgress: (done, total) => log(`  ${done}/${total} chunks enriquecidos`),
      });
    } else {
      projectChunks = rawChunks;
    }

    saveProjectChunks(projectDir, currentHash, projectChunks);
    log(`${projectChunks.length} chunks de stacks indexados.`);
  } else {
    log(`${projectChunks.length} chunks de stacks carregados do cache.`);
  }

  // ── Corpus 2: Docs de constructs iacmp ───────────────────────────────
  log('Indexando documentação de constructs...');
  let docsChunks = chunkIacmpDocs(systemPromptTemplate);

  if (useContextualRetrieval && anthropicApiKey && docsChunks.length > 0) {
    log(`Aplicando Contextual Retrieval em ${docsChunks.length} chunks de docs...`);
    const contextualizer = new Contextualizer(anthropicApiKey);
    const fullDoc = systemPromptTemplate;
    docsChunks = await contextualizer.enrichBatch(docsChunks, fullDoc, { concurrency: 5 });
  }

  log(`${docsChunks.length} chunks de docs indexados.`);

  // ── Corpus 3: Conhecimento de plataforma ─────────────────────────────
  log('Indexando base de conhecimento de plataforma...');
  const knowledgeChunks = loadKnowledgeChunks();
  log(`${knowledgeChunks.length} chunks de conhecimento indexados.`);

  // ── Constrói índices BM25 ─────────────────────────────────────────────
  const projectIndex = buildBM25Index(projectChunks);
  const docsIndex = buildBM25Index(docsChunks);
  const knowledgeIndex = buildBM25Index(knowledgeChunks);

  // Mapa id → chunk para lookup
  const chunkMap = new Map<string, Chunk>();
  for (const c of [...projectChunks, ...docsChunks, ...knowledgeChunks]) {
    chunkMap.set(c.id, c);
  }

  const total = projectChunks.length + docsChunks.length + knowledgeChunks.length;
  log(`RAG pronto — ${total} chunks indexados no total.`);

  return { projectIndex, docsIndex, knowledgeIndex, chunkMap };
}
