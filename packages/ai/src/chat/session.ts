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

  estimateTokens(): number {
    return this.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
  }

  trimToTokenBudget(budget: number): void {
    if (this.messages.length <= 2) return;
    while (this.messages.length > 2 && this.estimateTokens() > budget) {
      this.messages.splice(0, 1);
    }
  }

  removeLast(): void {
    this.messages.pop();
  }

  clear(): void {
    this.messages = [];
  }
}
