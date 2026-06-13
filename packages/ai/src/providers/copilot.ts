import { AIProvider, AIMessage, AIResponse } from './base';
import { SYSTEM_PROMPT } from '../prompts/system-prompt';

const COPILOT_ENDPOINT = 'https://api.githubcopilot.com/chat/completions';

export class CopilotProvider implements AIProvider {
  name = 'copilot';
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private buildMessages(messages: AIMessage[]): Array<{ role: string; content: string }> {
    const result: Array<{ role: string; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];
    for (const m of messages) {
      if (m.role !== 'system') {
        result.push({ role: m.role, content: m.content });
      }
    }
    return result;
  }

  async chat(messages: AIMessage[]): Promise<AIResponse> {
    const response = await fetch(COPILOT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Copilot-Integration-Id': 'iacmp-cli',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: this.buildMessages(messages),
        max_tokens: 8192,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Copilot API error ${response.status}: ${text}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices[0].message.content,
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
    };
  }

  async stream(messages: AIMessage[], onChunk: (chunk: string) => void): Promise<void> {
    const response = await fetch(COPILOT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Copilot-Integration-Id': 'iacmp-cli',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: this.buildMessages(messages),
        max_tokens: 8192,
        stream: true,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Copilot API error ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error('Copilot: response body vazio');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const raw = decoder.decode(value);
      const lines = raw.split('\n').filter(l => l.startsWith('data: '));

      for (const line of lines) {
        const json = line.slice(6).trim();
        if (json === '[DONE]') return;
        try {
          const parsed = JSON.parse(json) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const text = parsed.choices?.[0]?.delta?.content ?? '';
          if (text) onChunk(text);
        } catch {
          // ignora linhas malformadas
        }
      }
    }
  }
}
