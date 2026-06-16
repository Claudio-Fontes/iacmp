import { AIMessage } from '../providers/base';

export class ChatSession {
  private messages: AIMessage[] = [];

  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  addAssistantMessage(content: string): void {
    this.messages.push({ role: 'assistant', content });
  }

  getMessages(): AIMessage[] {
    return [...this.messages];
  }

  removeLast(): void {
    this.messages.pop();
  }

  clear(): void {
    this.messages = [];
  }
}
