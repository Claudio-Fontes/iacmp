import { Command, Args, Flags } from '@oclif/core';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import ora from 'ora';
import { loadAi, PRO_MESSAGE } from '../pro';
import { TEMPLATES } from '../init/templates';
import { claudeMd } from '../init/claude-md';
import { packageJson, tsConfig, gitignore, claudeSettings, dotenv, githubActionsYml, gitlabCiYml, PYTHON_PLACEHOLDER } from '../init/scaffold';


// ---------------------------------------------------------------------------
// Comando
// ---------------------------------------------------------------------------

export default class Init extends Command {
  static description = 'Inicializa um novo projeto iacmp. Se um nome for passado, cria a pasta do projeto.';

  static args = {
    name: Args.string({ description: 'Nome do projeto (cria a pasta automaticamente)', required: false }),
  };

  static flags = {
    language: Flags.string({ char: 'l', description: 'Linguagem (typescript, python)', default: 'typescript' }),
    provider: Flags.string({ char: 'p', description: 'Provider padrão (aws, azure, gcp, terraform)', default: 'aws' }),
    accountTier: Flags.string({ description: 'Tier da conta cloud: free ou standard (afeta defaults de RDS, backup, criptografia)', default: 'free', options: ['free', 'standard'] }),
    azureRegion: Flags.string({ description: 'Região Azure do projeto (grava azureRegion no iacmp.json)', default: 'eastus2' }),
    template: Flags.string({
      char: 't',
      description: `Template de stack a usar (blank, hello, rds, webapp, network, serverless, fullstack)`,
      default: 'blank',
    }),
    list: Flags.boolean({ description: 'Lista os templates disponíveis', default: false }),
    diagram: Flags.string({
      description: 'Caminho para imagem de diagrama de arquitetura — analisa via IA e gera stacks automaticamente',
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
      this.log('\nTemplates disponíveis:\n');
      const nameWidth = Math.max(...Object.keys(TEMPLATES).map(k => k.length)) + 2;
      for (const [name, tpl] of Object.entries(TEMPLATES)) {
        this.log(`  ${name.padEnd(nameWidth)} ${tpl.description}`);
        for (const c of tpl.constructs) {
          this.log(`  ${' '.repeat(nameWidth)}   · ${c}`);
        }
        this.log('');
      }
      this.log(`Uso: iacmp init meu-projeto --template <nome>`);
      return;
    }

    const validLanguages = ['typescript', 'python'];
    if (!validLanguages.includes(flags.language)) {
      this.error(`Linguagem '${flags.language}' não suportada. Use: ${validLanguages.join(', ')}`);
    }

    const validProviders = ['aws', 'azure', 'gcp']; // 'terraform' desabilitado — use --provider aws --format tf
    if (!validProviders.includes(flags.provider)) {
      this.error(`Provider '${flags.provider}' não suportado. Use: ${validProviders.join(', ')}`);
    }

    const template = TEMPLATES[flags.template];
    if (!template) {
      const available = Object.keys(TEMPLATES).join(', ');
      this.error(`Template '${flags.template}' não encontrado. Disponíveis: ${available}\n\nUse 'iacmp init --list' para ver todos os templates.`);
    }

    const cwd = process.cwd();
    const projectName = args.name ?? path.basename(cwd);
    const projectDir = args.name ? path.join(cwd, args.name) : cwd;

    if (args.name) {
      if (fs.existsSync(projectDir)) {
        this.error(`A pasta '${args.name}' já existe.`);
      }
      fs.mkdirSync(projectDir, { recursive: true });
    } else {
      if (fs.existsSync(path.join(projectDir, 'iacmp.json'))) {
        this.error(`Projeto já inicializado em ${path.join(projectDir, 'iacmp.json')}`);
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

    // CLAUDE.md na raiz — lido pelo Claude Code com prioridade alta
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), claudeMd(projectName));

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
      const installSpinner = ora('Instalando dependências...').start();
      try {
        execSync('npm install', { cwd: projectDir, stdio: 'pipe' });
        installSpinner.succeed('Dependências instaladas');
      } catch {
        installSpinner.warn('npm install falhou — rode manualmente na pasta do projeto');
      }
    }

    const rel = args.name ?? '.';
    const isBlank = !template.stackContent;
    const templateLabel = flags.template === 'blank' ? '' : ` (template: ${flags.template})`;

    this.log(`\nProjeto '${projectName}' inicializado${templateLabel}.\n`);
    this.log(`  ${rel}/iacmp.json`);
    this.log(`  ${rel}/.env`);
    this.log(`  ${rel}/CLAUDE.md`);
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
      this.log(`\nRecursos incluídos:`);
      for (const c of template.constructs) {
        this.log(`  · ${c}`);
      }
    }

    // --diagram: analisa imagem via visão e gera stacks no projeto recém-criado
    if (flags.diagram) {
      const diagramPath = path.resolve(flags.diagram);
      if (!fs.existsSync(diagramPath)) {
        this.error(`Diagrama não encontrado: ${diagramPath}`);
      }

      const anthropicKey = process.env['ANTHROPIC_API_KEY'];
      const openaiKey = process.env['OPENAI_API_KEY'];
      if (!anthropicKey && !openaiKey) {
        this.warn('Nenhuma API key encontrada. Configure ANTHROPIC_API_KEY ou OPENAI_API_KEY no .env do projeto.');
      } else {
        this.log('');
        // Gate Pro: análise de diagrama usa o iacmp-pro — sem ele, o init segue
        // normalmente, só sem gerar as stacks a partir da imagem.
        const ai = loadAi();
        if (!ai) this.error(PRO_MESSAGE);
        const spinner = ora('Analisando diagrama via IA...').start();
        try {
          const rawModel = process.env['IACMP_MODEL'] ?? '';
          const claudeModel = rawModel.startsWith('claude-') ? rawModel : 'claude-sonnet-4-6';
          const result = await ai.analyzeDiagramImage(
            diagramPath,
            { anthropic: anthropicKey, openai: openaiKey },
            anthropicKey ? claudeModel : undefined,
            { accountTier: config.accountTier ?? 'free' },
          );
          spinner.succeed('Diagrama analisado');

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
          spinner.fail('Falha ao analisar o diagrama');
          this.warn(err instanceof Error ? err.message : String(err));
          this.log('  Rode `iacmp ai "descreva a arquitetura"` para gerar stacks manualmente.');
        }
      }
    }

    this.log('\nPróximos passos:');
    if (args.name) this.log(`  cd ${args.name}`);
    if (flags.diagram) this.log('  iacmp synth');
    else if (isBlank) this.log('  iacmp ai "descreva a infraestrutura que você quer"');
    else this.log('  iacmp synth');
  }
}
