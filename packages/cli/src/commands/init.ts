import { Command, Args, Flags } from '@oclif/core';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import ora from 'ora';
import { t } from '../i18n';
import { loadAi, PRO_MESSAGE } from '../pro';
import { TEMPLATES } from '../init/templates';
import { claudeMd } from '../init/claude-md';
import { packageJson, tsConfig, gitignore, claudeSettings, dotenv, githubActionsYml, gitlabCiYml, PYTHON_PLACEHOLDER } from '../init/scaffold';


// ---------------------------------------------------------------------------
// Comando
// ---------------------------------------------------------------------------

export default class Init extends Command {
  static description = t('Inicializa um novo projeto iacmp. Se um nome for passado, cria a pasta do projeto.', 'Initializes a new iacmp project. If a name is given, creates the project folder.');

  static args = {
    name: Args.string({ description: t('Nome do projeto (cria a pasta automaticamente)', 'Project name (creates the folder automatically)'), required: false }),
  };

  static flags = {
    language: Flags.string({ char: 'l', description: t('Linguagem (typescript, python)', 'Language (typescript, python)'), default: 'typescript' }),
    provider: Flags.string({ char: 'p', description: t('Provider padrão (aws, azure, gcp, terraform)', 'Default provider (aws, azure, gcp, terraform)'), default: 'aws' }),
    accountTier: Flags.string({ description: t('Tier da conta cloud: free ou standard (afeta defaults de RDS, backup, criptografia)', 'Cloud account tier: free or standard (affects RDS, backup and encryption defaults)'), default: 'free', options: ['free', 'standard'] }),
    azureRegion: Flags.string({ description: t('Região Azure do projeto (grava azureRegion no iacmp.json)', 'Azure region for the project (writes azureRegion to iacmp.json)'), default: 'eastus2' }),
    template: Flags.string({
      char: 't',
      description: t(`Template de stack a usar (blank, hello, rds, webapp, network, serverless, fullstack)`, `Stack template to use (blank, hello, rds, webapp, network, serverless, fullstack)`),
      default: 'hello',
    }),
    list: Flags.boolean({ description: t('Lista os templates disponíveis', 'Lists the available templates'), default: false }),
    diagram: Flags.string({
      description: t('Caminho para imagem de diagrama de arquitetura — analisa via IA e gera stacks automaticamente', 'Path to an architecture diagram image — analyzed by AI to generate stacks automatically'),
    }),
  };

  static examples = [
    '$ iacmp init meu-projeto',
    '$ iacmp init meu-projeto --template rds',
    '$ iacmp init meu-projeto --template webapp --provider azure',
    '$ iacmp init meu-projeto --template serverless',
    '$ iacmp init meu-projeto --template fullstack',
    '$ iacmp init --list',
    '$ iacmp init meu-projeto --diagram ~/Downloads/arquitetura.png',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Init);

    // --list: exibe templates e sai
    if (flags.list) {
      this.log(t('\nTemplates disponíveis:\n', '\nAvailable templates:\n'));
      const nameWidth = Math.max(...Object.keys(TEMPLATES).map(k => k.length)) + 2;
      for (const [name, tpl] of Object.entries(TEMPLATES)) {
        this.log(`  ${name.padEnd(nameWidth)} ${tpl.description}`);
        for (const c of tpl.constructs) {
          this.log(`  ${' '.repeat(nameWidth)}   · ${c}`);
        }
        this.log('');
      }
      this.log(t(`Uso: iacmp init meu-projeto --template <nome>`, `Usage: iacmp init my-project --template <name>`));
      return;
    }

    const validLanguages = ['typescript', 'python'];
    if (!validLanguages.includes(flags.language)) {
      this.error(t(`Linguagem '${flags.language}' não suportada. Use: ${validLanguages.join(', ')}`, `Language '${flags.language}' not supported. Use: ${validLanguages.join(', ')}`));
    }

    const validProviders = ['aws', 'azure', 'gcp']; // 'terraform' desabilitado — use --provider aws --format tf
    if (!validProviders.includes(flags.provider)) {
      this.error(t(`Provider '${flags.provider}' não suportado. Use: ${validProviders.join(', ')}`, `Provider '${flags.provider}' not supported. Use: ${validProviders.join(', ')}`));
    }

    const template = TEMPLATES[flags.template];
    if (!template) {
      const available = Object.keys(TEMPLATES).join(', ');
      this.error(t(`Template '${flags.template}' não encontrado. Disponíveis: ${available}\n\nUse 'iacmp init --list' para ver todos os templates.`, `Template '${flags.template}' not found. Available: ${available}\n\nUse 'iacmp init --list' to see all templates.`));
    }

    const cwd = process.cwd();
    const projectName = args.name ?? path.basename(cwd);
    const projectDir = args.name ? path.join(cwd, args.name) : cwd;

    if (args.name) {
      if (fs.existsSync(projectDir)) {
        this.error(t(`A pasta '${args.name}' já existe.`, `The folder '${args.name}' already exists.`));
      }
      fs.mkdirSync(projectDir, { recursive: true });
    } else {
      if (fs.existsSync(path.join(projectDir, 'iacmp.json'))) {
        this.error(t(`Projeto já inicializado em ${path.join(projectDir, 'iacmp.json')}`, `Project already initialized at ${path.join(projectDir, 'iacmp.json')}`));
      }
    }

    // iacmp.json
    const accountTier = flags.accountTier ?? 'free';
    const config = {
      name: projectName,
      provider: flags.provider,
      region: 'us-east-1',
      // DR opcional "comentado": JSON não tem comentário — chaves com _ são
      // ignoradas pela ferramenta; renomear (tirar o _) ativa o recurso.
      _drRegion: 'us-west-2 (DR na AWS — renomeie para drRegion para ativar)',
      resourceGroup: `${projectName}-rg`,
      azureRegion: flags.azureRegion ?? 'eastus2',
      _azureDrRegion: 'centralus (DR na Azure — renomeie para azureDrRegion; RA-GRS usa o par fixo da região)',
      language: flags.language,
      accountTier,
    };
    fs.writeFileSync(path.join(projectDir, 'iacmp.json'), JSON.stringify(config, null, 2) + '\n');

    // .gitignore
    fs.writeFileSync(path.join(projectDir, '.gitignore'), gitignore());

    // .env — só cria se não existir para não sobrescrever keys já configuradas
    const envPath = path.join(projectDir, '.env');
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, dotenv());
    }

    // stacks/
    const stacksDir = path.join(projectDir, 'stacks');
    fs.mkdirSync(stacksDir, { recursive: true });

    const stackFileName = `${projectName}-stack.ts`;

    if (flags.language === 'typescript') {
      // package.json — usa file: quando rodando do monorepo local; usa ^versão quando instalado do npm
      const coreRef = (() => {
        try {
          const corePkgJson = require.resolve('@iacmp/core/package.json');
          const coreDir = path.dirname(corePkgJson);
          // Monorepo local: o pacote está em packages/core dentro do repositório iacmp
          if (coreDir.includes(`${path.sep}packages${path.sep}core`)) {
            return `file:${path.relative(projectDir, coreDir)}`;
          }
          const version = (JSON.parse(fs.readFileSync(corePkgJson, 'utf-8')) as { version: string }).version;
          return `^${version}`;
        } catch {
          return '^1.0.0';
        }
      })();
      fs.writeFileSync(path.join(projectDir, 'package.json'), packageJson(projectName, coreRef, flags.provider));

      // tsconfig.json
      const hasAppCode = !!template.extraFiles?.some(f => f.path.startsWith('src/'));
      fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), tsConfig(hasAppCode));

      // stack principal — só quando o template define uma (blank não define).
      // Sem stackContent, stacks/ nasce vazio para o `iacmp ai` preencher.
      if (template.stackContent) {
        const stackSubDir = template.stackSubDir
          ? path.join(projectDir, template.stackSubDir)
          : stacksDir;
        fs.mkdirSync(stackSubDir, { recursive: true });
        fs.writeFileSync(path.join(stackSubDir, stackFileName), template.stackContent(projectName));
      }

      // arquivos extras do template (ex: stacks separadas)
      if (template.extraFiles) {
        for (const extra of template.extraFiles) {
          const extraPath = path.join(projectDir, extra.path);
          fs.mkdirSync(path.dirname(extraPath), { recursive: true });
          fs.writeFileSync(extraPath, extra.content(projectName));
        }
      }

      // CI/CD
      const githubWorkflowsDir = path.join(projectDir, '.github', 'workflows');
      fs.mkdirSync(githubWorkflowsDir, { recursive: true });
      fs.writeFileSync(path.join(githubWorkflowsDir, 'iacmp.yml'), githubActionsYml());
      fs.writeFileSync(path.join(projectDir, '.gitlab-ci.yml'), gitlabCiYml());
    } else {
      fs.writeFileSync(path.join(stacksDir, 'exemplo_stack.py'), PYTHON_PLACEHOLDER);
    }

    // CLAUDE.md na raiz — lido pelo Claude Code com prioridade alta.
    // Se o diretório já tem um CLAUDE.md (init em projeto existente), o arquivo
    // é do usuário — nunca sobrescrever: gravamos como CLAUDE.iacmp.md e avisamos.
    const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    let claudeMdFile = 'CLAUDE.md';
    if (fs.existsSync(claudeMdPath)) {
      claudeMdFile = 'CLAUDE.iacmp.md';
      fs.writeFileSync(path.join(projectDir, claudeMdFile), claudeMd(projectName));
      this.log(t(
        '  CLAUDE.md já existia — as instruções do iacmp foram gravadas em CLAUDE.iacmp.md (importe com @CLAUDE.iacmp.md no seu CLAUDE.md)',
        '  CLAUDE.md already existed — iacmp instructions were written to CLAUDE.iacmp.md (import it with @CLAUDE.iacmp.md from your CLAUDE.md)',
      ));
    } else {
      fs.writeFileSync(claudeMdPath, claudeMd(projectName));
    }

    // .claude/ — settings.local.json com permissões
    const claudeDir = path.join(projectDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    if (!fs.existsSync(path.join(claudeDir, 'settings.local.json'))) {
      fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), claudeSettings(projectDir));
    }

    // git init
    try {
      execSync('git init', { cwd: projectDir, stdio: 'pipe' });
    } catch {}

    // npm install automático (TypeScript only)
    if (flags.language === 'typescript') {
      const installSpinner = ora(t('Instalando dependências...', 'Installing dependencies...')).start();
      try {
        execSync('npm install', { cwd: projectDir, stdio: 'pipe' });
        installSpinner.succeed(t('Dependências instaladas', 'Dependencies installed'));
      } catch {
        installSpinner.warn(t('npm install falhou — rode manualmente na pasta do projeto', 'npm install failed — run it manually in the project folder'));
      }
    }

    const rel = args.name ?? '.';
    const isBlank = !template.stackContent;
    const templateLabel = flags.template === 'blank' ? '' : ` (template: ${flags.template})`;

    this.log(t(`\nProjeto '${projectName}' inicializado${templateLabel}.\n`, `\nProject '${projectName}' initialized${templateLabel}.\n`));
    this.log(`  ${rel}/iacmp.json`);
    this.log(`  ${rel}/.env`);
    this.log(`  ${rel}/${claudeMdFile}`);
    if (flags.language === 'typescript') {
      this.log(`  ${rel}/package.json`);
      this.log(`  ${rel}/tsconfig.json`);
      if (!isBlank) {
        const stackRelPath = template.stackSubDir
          ? `${template.stackSubDir}/${stackFileName}`
          : `stacks/${stackFileName}`;
        this.log(`  ${rel}/${stackRelPath}`);
      }
      this.log(`  ${rel}/.github/workflows/iacmp.yml`);
      this.log(`  ${rel}/.gitlab-ci.yml`);
    }

    // mostra os constructs do template (blank não tem)
    if (template.constructs.length > 0) {
      this.log(t(`\nRecursos incluídos:`, `\nIncluded resources:`));
      for (const c of template.constructs) {
        this.log(`  · ${c}`);
      }
    }

    // --diagram: analisa imagem via visão e gera stacks no projeto recém-criado
    if (flags.diagram) {
      const diagramPath = path.resolve(flags.diagram);
      if (!fs.existsSync(diagramPath)) {
        this.error(t(`Diagrama não encontrado: ${diagramPath}`, `Diagram not found: ${diagramPath}`));
      }

      const anthropicKey = process.env['ANTHROPIC_API_KEY'];
      const openaiKey = process.env['OPENAI_API_KEY'];
      if (!anthropicKey && !openaiKey) {
        this.warn(t('Nenhuma API key encontrada. Configure ANTHROPIC_API_KEY ou OPENAI_API_KEY no .env do projeto.', 'No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the project\'s .env.'));
      } else {
        this.log('');
        // Gate Pro: análise de diagrama usa o iacmp-pro — sem ele, o init segue
        // normalmente, só sem gerar as stacks a partir da imagem.
        const ai = loadAi();
        if (!ai) this.error(PRO_MESSAGE);
        const spinner = ora(t('Analisando diagrama via IA...', 'Analyzing diagram with AI...')).start();
        try {
          const rawModel = process.env['IACMP_MODEL'] ?? '';
          const claudeModel = rawModel.startsWith('claude-') ? rawModel : 'claude-sonnet-4-6';
          const result = await ai.analyzeDiagramImage(
            diagramPath,
            { anthropic: anthropicKey, openai: openaiKey },
            anthropicKey ? claudeModel : undefined,
            { accountTier: config.accountTier ?? 'free' },
          );
          spinner.succeed(t('Diagrama analisado', 'Diagram analyzed'));

          if (result.explanation) {
            this.log(`\n${result.explanation}\n`);
          }

          for (const file of result.files) {
            const filePath = path.join(projectDir, file.path);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, file.content);
            this.log(`  ✓ ${file.path}`);
          }

          if (result.warnings.length > 0) {
            this.log('');
            for (const w of result.warnings) this.warn(w);
          }
        } catch (err) {
          spinner.fail(t('Falha ao analisar o diagrama', 'Failed to analyze the diagram'));
          this.warn(err instanceof Error ? err.message : String(err));
          this.log(t('  Rode `iacmp ai "descreva a arquitetura"` para gerar stacks manualmente.', '  Run `iacmp ai "describe the architecture"` to generate stacks manually.'));
        }
      }
    }

    this.log(t('\nPróximos passos:', '\nNext steps:'));
    if (args.name) this.log(`  cd ${args.name}`);
    if (isBlank && !flags.diagram) {
      this.log(t('  # projeto vazio — escreva sua primeira stack em stacks/ (exemplos: iacmp registry list)', '  # empty project — write your first stack in stacks/ (examples: iacmp registry list)'));
      this.log(t('  # ou gere com o Claude Code: iacmp setup && abra o Claude no projeto', '  # or generate with Claude Code: iacmp setup && open Claude in the project'));
    }
    this.log(t('  iacmp synth                # gera os templates + validações', '  iacmp synth                # generates the templates + validations'));
    this.log(t('  iacmp deploy --dry-run     # mostra o plano sem executar nada', '  iacmp deploy --dry-run     # shows the plan without executing anything'));
    this.log(t('  iacmp deploy               # deploy real (CLI da nuvem: iacmp doctor)', '  iacmp deploy               # real deploy (cloud CLI: iacmp doctor)'));
    this.log('');
    this.log(t('Gerar stacks com o Claude Code (incluso):', 'Generate stacks with Claude Code (included):'));
    this.log(t('  iacmp setup                # registra as ferramentas MCP; depois abra o Claude Code aqui', '  iacmp setup                # registers the MCP tools; then open Claude Code here'));
    this.log('');
    this.log('Docs: https://github.com/Claudio-Fontes/iacmp');
  }
}
