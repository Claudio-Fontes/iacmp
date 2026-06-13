export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIResponse {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AIProvider {
  name: string;
  chat(messages: AIMessage[]): Promise<AIResponse>;
  stream(messages: AIMessage[], onChunk: (chunk: string) => void): Promise<void>;
}
