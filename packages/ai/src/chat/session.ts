import { AIMessage } from '../llm-models/base';

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
    // Garante que a primeira mensagem é sempre 'user'
    while (this.messages.length > 0 && this.messages[0].role !== 'user') {
      this.messages.splice(0, 1);
    }
  }

  // Substitui o conteúdo das mensagens 'assistant' ANTIGAS por um stub curto,
  // preservando as últimas `keep`. No loop de auto-correção cada retry empilha o
  // JSON COMPLETO de todos os arquivos (~5-15k tokens); sem poda são 6-8 gerações
  // acumuladas, o que (a) faz o modelo ancorar em versões erradas anteriores →
  // oscilação fix-A-desfaz-fix-B, e (b) estoura o contexto (429 Request too large).
  // Mantém a geração mais recente intacta (é a que está sendo corrigida).
  compactAssistantHistory(keep = 1): void {
    const stub = '{"_omitido":"geração anterior — use a mais recente + a correção abaixo"}';
    const assistantIdx = this.messages
      .map((m, i) => (m.role === 'assistant' ? i : -1))
      .filter(i => i >= 0);
    for (const i of assistantIdx.slice(0, Math.max(0, assistantIdx.length - keep))) {
      if (this.messages[i].content !== stub) this.messages[i] = { role: 'assistant', content: stub };
    }
  }

  removeLast(): void {
    this.messages.pop();
  }

  clear(): void {
    this.messages = [];
  }
}
