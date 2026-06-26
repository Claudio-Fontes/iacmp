import OpenAI from 'openai';
import { AIProvider, AIMessage, AIResponse } from './base';
import { SYSTEM_PROMPT } from '../prompts/system-prompt';
import { withRetry } from './retry';

export class OpenAIProvider implements AIProvider {
  name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = 'gpt-4o') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async chat(messages: AIMessage[]): Promise<AIResponse> {
    const openaiMessages = messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }));

    if (!openaiMessages.find(m => m.role === 'system')) {
      openaiMessages.unshift({ role: 'system', content: SYSTEM_PROMPT });
    }

    const response = await withRetry(() => this.client.chat.completions.create({
      model: this.model,
      max_tokens: 16384,
      messages: openaiMessages,
      response_format: { type: 'json_object' },
    }));

    return {
      content: response.choices[0]?.message?.content ?? '',
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  async stream(messages: AIMessage[], onChunk: (chunk: string) => void): Promise<void> {
    const openaiMessages = messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }));

    if (!openaiMessages.find(m => m.role === 'system')) {
      openaiMessages.unshift({ role: 'system', content: SYSTEM_PROMPT });
    }

    let emittedAny = false;
    await withRetry(async () => {
      if (emittedAny) throw Object.assign(new Error('stream interrompido após início — sem retry'), { noRetry: true });

      const stream = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 16384,
        messages: openaiMessages,
        response_format: { type: 'json_object' },
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          emittedAny = true;
          onChunk(delta);
        }
      }
    });
  }
}
