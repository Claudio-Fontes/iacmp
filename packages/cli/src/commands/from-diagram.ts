import { Command, Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import ora from 'ora';
import chalk from 'chalk';
import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, AiApi, loadAi, PRO_MESSAGE } from '../pro';
import { t } from '../i18n';
import { ensureProjectInitialized } from '../bootstrap';
import { runGeneration, AskFn } from '../generation';
import { loadEnv } from '../env-loader';

const MEDIA_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
};

const VISION_PROMPT = `Analise este diagrama de arquitetura e descreva a infraestrutura em termos de constructs do iacmp.

Retorne APENAS uma descrição técnica clara com:
1. Provider de nuvem identificado (AWS, Azure ou GCP)
2. Cada serviço/componente presente
3. As relações entre eles (fluxo de dados, chamadas, gatilhos)
4. Configurações visíveis (regiões, tipos de tier, autenticação, etc.)

Não gere código — apenas descreva para que outro modelo gere a infraestrutura.`;

async function retrieveContext(ai: AiApi, cwd: string, prompt: string, systemPromptTemplate: string): Promise<string> {
  try {
    const indexes = await ai.buildIndexes({ projectDir: cwd, systemPromptTemplate });
    const results = ai.retrieve(indexes, prompt, { projectK: 0, sourceK: 0, docsK: 0, knowledgeK: 4 });
    return ai.formatRetrievedContext(results);
  } catch {
    return '';
  }
}

function buildContextualProvider(ai: AiApi, base: AIProvider, projectContext: string, iacProvider: string): AIProvider {
  const systemPrompt = ai.buildSystemPrompt(projectContext, undefined, iacProvider);
  return {
    name: base.name,
    async chat(messages) {
      return base.chat([{ role: 'system' as const, content: systemPrompt }, ...messages]);
    },
    async stream(messages, onChunk) {
      return base.stream([{ role: 'system' as const, content: systemPrompt }, ...messages], onChunk);
    },
  };
}

function detectProvider(description: string): string {
  const lower = description.toLowerCase();
  if (lower.includes('azure') || lower.includes('microsoft')) return 'azure';
  if (lower.includes('gcp') || lower.includes('google cloud') || lower.includes('cloud run') ||
      lower.includes('pub/sub') || lower.includes('firestore') || lower.includes('bigquery')) return 'gcp';
  return 'aws';
}

export default class FromDiagram extends Command {
  static description = t('Gera stacks de infraestrutura a partir de um diagrama de arquitetura (imagem).', 'Generates infrastructure stacks from an architecture diagram (image).');

  static args = {
    image: Args.string({
      description: t('Caminho para o arquivo de imagem (PNG, JPG, WEBP, GIF)', 'Path to the image file (PNG, JPG, WEBP, GIF)'),
      required: true,
    }),
  };

  static flags = {
    provider: Flags.string({
      char: 'p',
      description: t('Provider alvo (aws, azure, gcp, terraform) — sobrepõe o detectado no diagrama', 'Target provider (aws, azure, gcp, terraform) — overrides the one detected in the diagram'),
    }),
    'dry-run': Flags.boolean({
      description: t('Gera e exibe sem salvar arquivos', 'Generates and shows without saving files'),
      default: false,
    }),
  };

  static examples = [
    '$ iacmp from-diagram ./arquitetura.png',
    '$ iacmp from-diagram ./diagrama.jpg --provider aws',
    '$ iacmp from-diagram ./arch.webp --provider azure --dry-run',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(FromDiagram);
    // Gate Pro: geração a partir de diagrama usa o pipeline do iacmp-pro.
    const ai = loadAi();
    if (!ai) this.error(PRO_MESSAGE);
    const cwd = process.cwd();
    loadEnv(cwd);

    // Validar imagem
    const imagePath = path.resolve(args.image);
    if (!fs.existsSync(imagePath)) this.error(`Arquivo não encontrado: ${imagePath}`);
    const ext = path.extname(imagePath).toLowerCase();
    const mediaType = MEDIA_TYPES[ext];
    if (!mediaType) this.error(`Formato não suportado: ${ext}. Use: ${Object.keys(MEDIA_TYPES).join(', ')}`);

    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) this.error('Configure ANTHROPIC_API_KEY no .env do projeto');

    const dryRun = flags['dry-run'];

    // Bootstrap: garante que o projeto está inicializado
    if (!dryRun) {
      const initProvider = flags.provider ?? 'aws';
      const initSpinner = ora({ text: 'Preparando projeto...', spinner: 'dots', discardStdin: false }).start();
      try {
        const result = ensureProjectInitialized(cwd, { provider: initProvider });
        if (result.bootstrapped) initSpinner.succeed(`Projeto inicializado (${result.created.join(', ')})`);
        else initSpinner.stop();
      } catch (err) {
        initSpinner.fail(`Falha ao preparar: ${(err as Error).message}`);
        this.error('Rode `iacmp init` manualmente.');
      }
    }

    // Passo 1: visão — Claude analisa a imagem e descreve a arquitetura
    const visionSpinner = ora({ text: 'Analisando diagrama...', spinner: 'dots', discardStdin: false }).start();
    let description: string;
    try {
      const imageBytes = fs.readFileSync(imagePath);
      const base64 = imageBytes.toString('base64');
      const client = new Anthropic({ apiKey });
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: VISION_PROMPT },
          ],
        }],
      });
      description = resp.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('\n');
      visionSpinner.succeed('Diagrama analisado');
    } catch (err) {
      visionSpinner.fail('Falha ao analisar o diagrama');
      this.error((err as Error).message);
    }

    // Mostrar o que foi detectado
    this.log('');
    this.log(chalk.bold('Arquitetura detectada'));
    this.log('─'.repeat(50));
    this.log(description);
    this.log('─'.repeat(50));
    this.log('');

    const iacProvider = flags.provider ?? detectProvider(description);
    this.log(chalk.dim(`Provider: ${iacProvider}`));
    this.log('');

    // Passo 2: geração — reutiliza o pipeline completo do `iacmp ai`
    const aiProvider = new ai.AnthropicProvider(apiKey, 'claude-sonnet-4-6');
    const ragSpinner = ora({ text: 'Recuperando conhecimento relevante...', spinner: 'dots', discardStdin: false }).start();
    const ragContext = await retrieveContext(ai, cwd, description, ai.buildSystemPrompt(''));
    let projectContext: string;
    if (ragContext) {
      projectContext = `${ai.readProjectMeta(cwd)}\n\n${ragContext}`;
      ragSpinner.succeed('Conhecimento recuperado (RAG)');
    } else {
      projectContext = ai.readProjectContext(cwd);
      ragSpinner.stop();
    }
    const kbExamples = ai.searchKnowledgeBase(description, iacProvider);
    if (kbExamples) projectContext = `${kbExamples}\n\n${projectContext}`;

    const provider = buildContextualProvider(ai, aiProvider, projectContext, iacProvider);
    const session = new ai.ChatSession();
    const prompt = `Gere a infraestrutura iacmp para a seguinte arquitetura detectada em um diagrama:\n\n${description}`;
    session.addUserMessage(prompt);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask: AskFn = (q: string) => new Promise(resolve => rl.question(q, (a: string) => resolve(a.trim())));
    try {
      await runGeneration(provider, session, cwd, dryRun, iacProvider, ask, prompt);
    } finally {
      rl.close();
    }
  }
}
