import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, AIMessage, AIResponse } from './base';
import { SYSTEM_PROMPT } from '../prompts/system-prompt';
import { withRetry } from './retry';

export class AnthropicProvider implements AIProvider {
  name = 'anthropic';
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = 'claude-sonnet-4-6') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(messages: AIMessage[]): Promise<AIResponse> {
    const system = messages.find(m => m.role === 'system')?.content ?? SYSTEM_PROMPT;
    const filtered = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const response = await withRetry(() => this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system,
      messages: filtered,
    }));

    const block = response.content[0];
    return {
      content: block.type === 'text' ? block.text : '',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async stream(messages: AIMessage[], onChunk: (chunk: string) => void): Promise<void> {
    const system = messages.find(m => m.role === 'system')?.content ?? SYSTEM_PROMPT;
    const filtered = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Retry só cobre falhas antes do primeiro chunk emitido — depois disso,
    // repetir geraria texto duplicado, então o erro é propagado direto (sem novas tentativas).
    let emittedAny = false;
    await withRetry(async () => {
      if (emittedAny) throw Object.assign(new Error('stream interrompido após início — sem retry'), { noRetry: true });

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 8192,
        system,
        messages: filtered,
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          emittedAny = true;
          onChunk(chunk.delta.text);
        }
      }
    });
  }
}
