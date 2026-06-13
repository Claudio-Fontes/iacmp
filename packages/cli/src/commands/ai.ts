import { Command, Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import chalk from 'chalk';
import {
  AIProvider,
  AnthropicProvider,
  CopilotProvider,
  ChatSession,
  extractResponse,
  validateTypeScript,
  writeGeneratedFiles,
  runSynth,
  readProjectContext,
  printExplanation,
  printWarnings,
  printNextSteps,
  printStreamChunk,
  buildSystemPrompt,
  AIGeneratedResponse,
} from '@iacmp/ai';

function resolveAIProvider(): AIProvider {
  if (process.env['ANTHROPIC_API_KEY']) {
    return new AnthropicProvider(process.env['ANTHROPIC_API_KEY']);
  }
  if (process.env['GITHUB_TOKEN']) {
    return new CopilotProvider(process.env['GITHUB_TOKEN']);
  }
  throw new Error(
    'Configure ANTHROPIC_API_KEY ou GITHUB_TOKEN para usar iacmp ai\n' +
    '  export ANTHROPIC_API_KEY=sk-ant-...\n' +
    '  ou\n' +
    '  export GITHUB_TOKEN=ghp_...'
  );
}

function resolveIaCProvider(flags: { provider?: string }, cwd: string): string {
  if (flags.provider) return flags.provider;
  const configPath = path.join(cwd, 'iacmp.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if (typeof config['provider'] === 'string') return config['provider'];
    } catch {
      // ignora
    }
  }
  return 'aws';
}

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function runGeneration(
  provider: AIProvider,
  session: ChatSession,
  cwd: string,
  dryRun: boolean,
  iacProvider: string
): Promise<AIGeneratedResponse | null> {
  const rawChunks: string[] = [];

  console.log('\n' + chalk.dim('─'.repeat(50)));

  try {
    await provider.stream(session.getMessages(), chunk => {
      rawChunks.push(chunk);
      printStreamChunk(chunk);
    });
  } catch (err) {
    const error = err as Error;
    console.error('\n' + chalk.red('Erro ao chamar a IA: ' + error.message));
    return null;
  }

  console.log('\n' + chalk.dim('─'.repeat(50)) + '\n');

  const raw = rawChunks.join('');
  session.addAssistantMessage(raw);

  let parsed: AIGeneratedResponse;
  try {
    parsed = extractResponse(raw);
  } catch (err) {
    const error = err as Error;
    console.error(chalk.red('Erro ao extrair resposta da IA: ' + error.message));
    return null;
  }

  // Valida TypeScript se houver arquivos .ts
  const tsFiles = parsed.files.filter(f => f.path.endsWith('.ts'));
  if (tsFiles.length > 0) {
    const result = validateTypeScript(tsFiles, cwd);
    if (!result.valid) {
      console.log(chalk.yellow('\nValidação TypeScript falhou. Tentando corrigir...'));
      const errorMsg = result.errors.join('\n');
      session.addUserMessage(
        `O código gerado tem erros TypeScript. Corrija e retorne o JSON completo novamente:\n${errorMsg}`
      );

      const retryChunks: string[] = [];
      try {
        await provider.stream(session.getMessages(), chunk => {
          retryChunks.push(chunk);
          printStreamChunk(chunk);
        });
      } catch (err) {
        const error = err as Error;
        console.error('\n' + chalk.red('Erro no retry: ' + error.message));
        return parsed; // retorna o original mesmo com erros
      }

      console.log('\n');
      const retryRaw = retryChunks.join('');
      session.addAssistantMessage(retryRaw);

      try {
        parsed = extractResponse(retryRaw);
      } catch {
        // usa o original
      }
    }
  }

  printExplanation(parsed.explanation);
  printWarnings(parsed.warnings);

  if (parsed.files.length > 0) {
    await writeGeneratedFiles(parsed.files, cwd, dryRun);
  }

  printNextSteps(parsed.nextSteps);

  if (!dryRun && parsed.files.length > 0) {
    const answer = await promptLine('Quer rodar `iacmp synth` agora? (y/n) ');
    if (answer === 'y') {
      runSynth(cwd, iacProvider);
    }
  }

  return parsed;
}

export default class AI extends Command {
  static description = 'Gera stacks de infraestrutura via IA (Claude ou GitHub Copilot)';

  static args = {
    prompt: Args.string({ description: 'Descrição do que criar (obrigatório sem --chat)', required: false }),
  };

  static flags = {
    chat: Flags.boolean({
      description: 'Modo chat interativo',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: 'Gera e exibe sem salvar arquivos',
      default: false,
    }),
    provider: Flags.string({
      char: 'p',
      description: 'Provider alvo (aws, azure, gcp, terraform)',
    }),
  };

  static examples = [
    '$ iacmp ai "cria uma Lambda com API Gateway"',
    '$ iacmp ai --chat',
    '$ iacmp ai --dry-run "cria uma VPC com subnets"',
    '$ iacmp ai "migra a stack para azure" --provider azure',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AI);
    const cwd = process.cwd();
    const dryRun = flags['dry-run'];
    const iacProvider = resolveIaCProvider({ provider: flags.provider }, cwd);

    let aiProvider: AIProvider;
    try {
      aiProvider = resolveAIProvider();
    } catch (err) {
      this.error((err as Error).message);
    }

    // Lê contexto do projeto para injetar no system prompt
    const projectContext = readProjectContext(cwd);

    // Substitui o system prompt nos providers que aceitam o contexto dinâmico
    // Criamos um wrapper que injeta o contexto correto
    const contextualProvider = createContextualProvider(aiProvider, projectContext);

    const session = new ChatSession();

    if (flags.chat) {
      await this.runChatMode(contextualProvider, session, cwd, dryRun, iacProvider);
    } else {
      if (!args.prompt) {
        this.error('Informe o prompt ou use --chat para modo interativo.\nExemplo: iacmp ai "cria uma Lambda com API Gateway"');
      }
      session.addUserMessage(args.prompt);
      await runGeneration(contextualProvider, session, cwd, dryRun, iacProvider);
    }
  }

  private async runChatMode(
    provider: AIProvider,
    session: ChatSession,
    cwd: string,
    dryRun: boolean,
    iacProvider: string
  ): Promise<void> {
    console.log(chalk.cyan.bold('\niacmp ai — Modo Chat Interativo'));
    console.log(chalk.dim('Comandos: /sair, /quit — encerra | /limpar — limpa histórico\n'));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const askLine = (): Promise<string> =>
      new Promise(resolve => rl.question(chalk.bold('> Você: '), resolve));

    while (true) {
      let input: string;
      try {
        input = (await askLine()).trim();
      } catch {
        break;
      }

      if (!input) continue;

      if (input === '/sair' || input === '/quit') {
        console.log(chalk.dim('Encerrando chat.'));
        break;
      }

      if (input === '/limpar') {
        session.clear();
        console.log(chalk.dim('Histórico limpo.\n'));
        continue;
      }

      session.addUserMessage(input);
      await runGeneration(provider, session, cwd, dryRun, iacProvider);
    }

    rl.close();
  }
}

// Cria um provider que injeta o contexto do projeto no system prompt
function createContextualProvider(base: AIProvider, projectContext: string): AIProvider {
  const systemPrompt = buildSystemPrompt(projectContext);

  return {
    name: base.name,
    async chat(messages) {
      // Injeta o system prompt como primeira mensagem system
      const withContext = [{ role: 'system' as const, content: systemPrompt }, ...messages];
      return base.chat(withContext);
    },
    async stream(messages, onChunk) {
      const withContext = [{ role: 'system' as const, content: systemPrompt }, ...messages];
      return base.stream(withContext, onChunk);
    },
  };
}
