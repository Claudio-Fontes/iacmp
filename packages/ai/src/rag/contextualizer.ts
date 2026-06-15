import Anthropic from '@anthropic-ai/sdk';
import { Chunk } from './chunker';

// Contextual Retrieval — técnica da Anthropic:
// Antes de indexar, Claude gera um parágrafo curto explicando o que o chunk
// representa dentro do documento maior. Isso melhora a qualidade da busca
// BM25/vetorial em 35-49% ao adicionar contexto que o chunk isolado não tem.
//
// Referência: https://www.anthropic.com/news/contextual-retrieval

const CONTEXTUALIZER_PROMPT = `Você está processando um chunk de documento para indexação em um sistema RAG de infraestrutura como código.

Dado o documento completo e o chunk específico abaixo, gere um parágrafo conciso (2-4 frases) que:
1. Explique o que este chunk representa no contexto do documento maior
2. Mencione conceitos-chave, serviços cloud, ou padrões de arquitetura relevantes
3. Inclua termos alternativos ou sinônimos que ajudem na busca (ex: "Lambda" e "função serverless", "RDS" e "banco relacional")

Seja direto e técnico. Não use markdown. Responda apenas com o parágrafo de contexto.

<documento_completo>
{DOCUMENT}
</documento_completo>

<chunk>
{CHUNK}
</chunk>`;

export class Contextualizer {
  private client: Anthropic;
  private model = 'claude-haiku-4-5'; // usa Haiku para minimizar custo — tarefa simples

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  // Enriquece um único chunk com contexto gerado pelo Claude
  async enrichChunk(chunk: Chunk, fullDocument: string): Promise<Chunk> {
    const prompt = CONTEXTUALIZER_PROMPT
      .replace('{DOCUMENT}', fullDocument.slice(0, 8000)) // limita o doc para evitar context overflow
      .replace('{CHUNK}', chunk.content.slice(0, 2000));

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      });

      const contextText = response.content[0].type === 'text'
        ? response.content[0].text.trim()
        : '';

      return {
        ...chunk,
        // contextualContent = contexto gerado + conteúdo original
        // É isso que vai para o índice BM25/vetorial
        contextualContent: `${contextText}\n\n${chunk.content}`,
      };
    } catch {
      // Se falhar, retorna o chunk sem enriquecimento
      return { ...chunk, contextualContent: chunk.content };
    }
  }

  // Enriquece um lote de chunks em paralelo com controle de concorrência
  async enrichBatch(
    chunks: Chunk[],
    fullDocument: string,
    options: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<Chunk[]> {
    const { concurrency = 5, onProgress } = options;
    const results: Chunk[] = new Array(chunks.length);
    let done = 0;

    // Processa em janelas de concurrency para não saturar a API
    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(chunk => this.enrichChunk(chunk, fullDocument))
      );
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
      done += batch.length;
      onProgress?.(done, chunks.length);
    }

    return results;
  }
}
