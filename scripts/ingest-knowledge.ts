#!/usr/bin/env ts-node
/**
 * Script de ingestão da knowledge base — gera corpus3-index.json
 *
 * Uso:
 *   npx ts-node scripts/ingest-knowledge.ts
 *
 * Lê todos os .md em packages/ai/src/knowledge/
 * Chama o chunker e gera o índice BM25 do Corpus 3
 * Salva em packages/ai/src/knowledge/corpus3-index.json
 */

import * as fs from 'fs';
import * as path from 'path';

// Precisa rodar antes do build, então importa diretamente do src
const { chunkKnowledgeFile } = require('../packages/ai/src/rag/chunker');
const { buildBM25Index } = require('../packages/ai/src/rag/bm25');

const KNOWLEDGE_DIR = path.resolve(__dirname, '../packages/ai/src/knowledge');
const OUTPUT_FILE = path.resolve(__dirname, '../packages/ai/src/knowledge/corpus3-index.json');

interface Chunk {
  id: string;
  content: string;
  contextualContent?: string;
  metadata: {
    source: string;
    file?: string;
    section?: string;
    platform?: string;
  };
}

function loadKnowledgeChunks(): Chunk[] {
  const chunks: Chunk[] = [];
  const platforms = ['aws', 'azure', 'gcp', 'cross-cloud'] as const;

  for (const platform of platforms) {
    const platformDir = path.join(KNOWLEDGE_DIR, platform);
    if (!fs.existsSync(platformDir)) {
      console.log(`  Diretório não encontrado: ${platformDir} — pulando`);
      continue;
    }

    const files = fs.readdirSync(platformDir).filter((f: string) => f.endsWith('.md'));
    console.log(`  ${platform}/: ${files.length} arquivo(s)`);

    for (const file of files) {
      try {
        const fileChunks = chunkKnowledgeFile(path.join(platformDir, file), platform);
        console.log(`    ${file}: ${fileChunks.length} chunks`);
        chunks.push(...fileChunks);
      } catch (err) {
        console.warn(`    AVISO: falha ao processar ${file}: ${(err as Error).message}`);
      }
    }
  }

  return chunks;
}

async function main(): Promise<void> {
  console.log('=== Ingestão da knowledge base ===\n');
  console.log(`Diretório: ${KNOWLEDGE_DIR}\n`);

  // Carrega e chunkiza todos os markdown
  console.log('Carregando arquivos markdown...');
  const chunks = loadKnowledgeChunks();
  console.log(`\nTotal: ${chunks.length} chunks\n`);

  // Constrói índice BM25
  console.log('Construindo índice BM25...');
  const index = buildBM25Index(chunks);

  // Prepara output: índice serializado + metadata
  const output = {
    generatedAt: new Date().toISOString(),
    totalChunks: chunks.length,
    totalDocuments: index.totalDocs,
    avgLength: Math.round(index.avgLength),
    platforms: {
      aws: chunks.filter((c: Chunk) => c.metadata.platform === 'aws').length,
      azure: chunks.filter((c: Chunk) => c.metadata.platform === 'azure').length,
      gcp: chunks.filter((c: Chunk) => c.metadata.platform === 'gcp').length,
      'cross-cloud': chunks.filter((c: Chunk) => c.metadata.platform === 'cross-cloud').length,
    },
    // Índice BM25 completo para busca
    index: {
      documents: index.documents,
      df: index.df,
      avgLength: index.avgLength,
      totalDocs: index.totalDocs,
    },
    // Chunks com conteúdo para lookup
    chunks: chunks.map((c: Chunk) => ({
      id: c.id,
      content: c.content,
      metadata: c.metadata,
    })),
  };

  // Salva
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');

  const sizeKb = (fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1);
  console.log(`\nSalvo em: ${OUTPUT_FILE}`);
  console.log(`Tamanho: ${sizeKb} KB`);
  console.log('\nDistribuição por plataforma:');
  for (const [platform, count] of Object.entries(output.platforms)) {
    console.log(`  ${platform}: ${count} chunks`);
  }
  console.log('\nIngestão concluída.');
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
