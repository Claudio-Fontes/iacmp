/**
 * Contrato estrutural entre o CLI aberto e os módulos Pro (@iacmp/ai e
 * @iacmp/knowledge, repo privado iacmp-pro). O CLI NUNCA importa tipos ou
 * valores diretamente desses pacotes — tudo passa por aqui e pelo loader em
 * ./index.ts. Isso permite compilar e rodar o CLI sem os pacotes presentes
 * (instalação pública), degradando os comandos Pro com mensagem clara.
 *
 * Os tipos abaixo ESPELHAM a superfície pública real do iacmp-pro (tipagem
 * estrutural — o módulo carregado em runtime satisfaz as interfaces). Ao
 * evoluir a API do Pro, atualizar este contrato junto.
 */

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

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface AIGeneratedResponse {
  explanation: string;
  files: GeneratedFile[];
  deletions: string[];
  nextSteps: string[];
  warnings: string[];
  config?: Record<string, string>;
}

export interface ChatSession {
  addUserMessage(content: string): void;
  addAssistantMessage(content: string): void;
  getMessages(): AIMessage[];
  estimateTokens(): number;
  trimToTokenBudget(budget: number): void;
  compactAssistantHistory(keep?: number): void;
  removeLast(): void;
  clear(): void;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export type AskFn = (question: string) => Promise<string>;

/** Superfície de @iacmp/ai consumida pelo CLI. */
export interface AiApi {
  // Providers de LLM
  AnthropicProvider: new (apiKey: string, model?: string) => AIProvider;
  OpenAIProvider: new (apiKey: string, model?: string) => AIProvider;
  CopilotProvider: new (token: string) => AIProvider;
  ChatSession: new () => ChatSession;

  // Contexto e RAG
  readProjectContext(projectDir: string): string;
  readProjectMeta(projectDir: string): string;
  buildSystemPrompt(projectContext: string, lang?: unknown, provider?: string): string;
  buildIndexes(options: { projectDir: string; systemPromptTemplate: string }): Promise<unknown>;
  retrieve(indexes: unknown, query: string, opts?: Record<string, number>): unknown[];
  formatRetrievedContext(results: unknown[]): string;
  searchKnowledgeBase(query: string, provider: string, limit?: number): string;
  enrichPrompt(provider: AIProvider, userPrompt: string, iacProvider: string, ask: AskFn): Promise<string>;

  // Parser / geração
  extractResponse(raw: string): AIGeneratedResponse;
  validateTypeScript(files: GeneratedFile[], projectDir: string): ValidationResult;
  writeGeneratedFiles(files: GeneratedFile[], projectDir: string, dryRun: boolean, ask: AskFn): Promise<string[]>;
  removeOrphanedGeneratedFiles(previousPaths: Iterable<string>, currentFiles: GeneratedFile[], projectDir: string): string[];
  runSynthCapture(projectDir: string, provider: string): { success: boolean; output: string };

  // Render
  printExplanation(text: string): void;
  printWarnings(warnings: string[]): void;
  printNextSteps(steps: string[]): void;

  // Cache de resposta
  getCached(projectDir: string, prompt: string): string | null;
  setCache(projectDir: string, prompt: string, response: string): void;

  // Diagrama
  analyzeDiagramImage(
    imagePath: string,
    keys: { anthropic?: string; openai?: string } | string,
    model?: string,
    options?: { accountTier?: string },
  ): Promise<AIGeneratedResponse>;
}

export interface Provenance {
  schemaVersion: number;
  capturedAt: string;
  fingerprint: string;
  shareStatus: 'private' | 'shared';
}

export interface KnowledgeExample {
  id: string;
  title: string;
  provider: string;
  constructs: string[];
  tags: string[];
  stacks: Record<string, string>;
  handlers: Record<string, string>;
  notes: string[];
  validated: boolean;
}

/** Superfície de @iacmp/knowledge consumida pelo CLI (autolearn local). */
export interface KnowledgeApi {
  defaultDbPath(): string;
  fingerprintOf(provider: string, constructs: string[]): string;
  hasSimilarExample(opts: { dbPath?: string }, provider: string, constructs: string[]): boolean;
  addLocalExample(opts: { dbPath?: string }, ex: KnowledgeExample, provenance?: Provenance): void;
}
