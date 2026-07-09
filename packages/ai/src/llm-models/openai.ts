import OpenAI from 'openai';
import { AIProvider, AIMessage, AIResponse } from './base';
import { SYSTEM_PROMPT } from '../prompts/system-prompt';
import { withRetry } from './retry';

export class OpenAIProvider implements AIProvider {
  name = 'openai';
  private client: OpenAI;
  private model: string;
  private temperature: number;

  constructor(apiKey: string, model = 'gpt-4o', temperature = 1) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.temperature = temperature;
  }

  private usesCompletionTokens(): boolean {
    return /^(gpt-5|o1|o3|o4)/.test(this.model);
  }

  async chat(messages: AIMessage[]): Promise<AIResponse> {
    const openaiMessages = messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }));

    if (!openaiMessages.find(m => m.role === 'system')) {
      openaiMessages.unshift({ role: 'system', content: SYSTEM_PROMPT });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = { model: this.model, temperature: this.temperature, messages: openaiMessages };
    if (this.usesCompletionTokens()) params.max_completion_tokens = 12000;
    else params.max_tokens = 12000;

    const response = await withRetry(() => this.client.chat.completions.create(params));

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

    let accumulated = '';
    let attempts = 0;
    const MAX_ATTEMPTS = 3;

    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      try {
        // Se já temos parte da resposta, pede ao modelo para continuar de onde parou
        const msgs = accumulated
          ? [...openaiMessages, { role: 'assistant' as const, content: accumulated }, { role: 'user' as const, content: 'Continue exatamente de onde parou, sem repetir o que já foi gerado.' }]
          : openaiMessages;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const streamParams: any = { model: this.model, temperature: this.temperature, messages: msgs, stream: true };
        if (this.usesCompletionTokens()) streamParams.max_completion_tokens = 12000;
        else streamParams.max_tokens = 12000;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stream = await this.client.chat.completions.create(streamParams) as any;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            accumulated += delta;
            onChunk(delta);
          }
        }
        return; // stream completou normalmente
      } catch (err: any) {
        const retryable = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.status === 500 || err.status === 502 || err.status === 503;
        if (!retryable || attempts >= MAX_ATTEMPTS) throw err;
        await new Promise(r => setTimeout(r, 500 * 2 ** (attempts - 1)));
      }
    }
  }
}
