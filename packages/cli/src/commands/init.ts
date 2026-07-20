import { Command, Args, Flags } from '@oclif/core';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import ora from 'ora';
import { analyzeDiagramImage } from '@iacmp/ai';

// ---------------------------------------------------------------------------
// Templates de stack — embutidos no CLI, funcionam após npm install -g iacmp
// ---------------------------------------------------------------------------

interface TemplateFile {
  path: string;   // relativo à raiz do projeto, ex: 'stacks/compute/hello-fn.ts'
  content: (projectName: string) => string;
}

interface Template {
  description: string;
  constructs: string[];    // lista para exibir no --list
  stackSubDir?: string;    // subpasta dentro de stacks/ para o arquivo principal (ex: 'stacks/compute')
  stackContent?: (projectName: string) => string; // arquivo principal — ausente = projeto vazio (ex: blank)
  extraFiles?: TemplateFile[];                     // arquivos adicionais
}

const TEMPLATES: Record<string, Template> = {
  // Template padrão (sem --template): projeto vazio, só estrutura base. Pensado
  // para o fluxo `iacmp ai`, que preenche stacks/ com exatamente o que foi
  // pedido — sem scaffold de exemplo que vire referência órfã ou ruído.
  blank: {
    description: 'Projeto vazio (sem scaffold) — ideal para usar com `iacmp ai`',
    constructs: [],
  },

  hello: {
    description: 'Lambda Hello World exposta via API Gateway REST (arquivos separados)',
    constructs: ['Fn.Lambda', 'Fn.ApiGateway'],
    stackSubDir: 'stacks/compute',
    stackContent: (name) => `import { Stack, Fn } from '@iacmp/core';

const stack = new Stack('${name}-lambda');

new Fn.Lambda(stack, 'HelloWorldFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 128,
  timeout: 10,
});

export default stack;
`,
    extraFiles: [
      {
        path: 'stacks/network/api-gateway-stack.ts',
        content: (name) => `import { Stack, Fn } from '@iacmp/core';

const stack = new Stack('${name}-api');

new Fn.ApiGateway(stack, 'HelloWorldApi', {
  name: '${name}-api',
  type: 'REST',
  stageName: 'prod',
  cors: true,
  authType: 'NONE',
  routes: [
    {
      method: 'GET',
      path: '/hello',
      lambdaId: 'HelloWorldFn',
    },
  ],
});

export default stack;
`,
      },
      {
        path: 'src/index.ts',
        content: () => helloHandlerContent(),
      },
    ],
  },

  rds: {
    description: 'Banco de dados RDS (postgres) com VPC Multi-AZ e réplica de leitura',
    constructs: ['Network.VPC', 'Database.SQL (principal)', 'Database.SQL (replica)'],
    stackContent: (name) => `import { Stack, Network, Database } from '@iacmp/core';

const stack = new Stack('${name}');

new Network.VPC(stack, 'VPC', {
  cidr: '10.0.0.0/16',
  maxAzs: 3,
});

new Database.SQL(stack, 'Principal', {
  engine: 'postgres',
  instanceType: 'medium',
  multiAz: true,
});

new Database.SQL(stack, 'Replica', {
  engine: 'postgres',
  instanceType: 'small',
  multiAz: false,
});

export default stack;
`,
  },

  webapp: {
    description: 'Site estático com VPC, bucket público e bucket privado de assets',
    constructs: ['Network.VPC', 'Storage.Bucket (site público)', 'Storage.Bucket (assets privados)'],
    stackContent: (name) => `import { Stack, Network, Storage } from '@iacmp/core';

const stack = new Stack('${name}');

new Network.VPC(stack, 'Rede', {
  cidr: '10.0.0.0/16',
});

new Storage.Bucket(stack, 'SiteBucket', {
  versioning: false,
  publicAccess: true,
});

new Storage.Bucket(stack, 'AssetsBucket', {
  versioning: true,
  publicAccess: false,
});

export default stack;
`,
  },

  network: {
    description: 'Infraestrutura de rede completa com VPC multi-AZ, bastion e app server',
    constructs: ['Network.VPC', 'Compute.Instance (bastion)', 'Compute.Instance (app server)'],
    stackContent: (name) => `import { Stack, Network, Compute } from '@iacmp/core';

const stack = new Stack('${name}');

new Network.VPC(stack, 'VpcPrincipal', {
  cidr: '10.0.0.0/8',
  maxAzs: 3,
});

new Compute.Instance(stack, 'Bastion', {
  instanceType: 'small',
  image: 'ubuntu-22.04',
});

new Compute.Instance(stack, 'AppServer', {
  instanceType: 'large',
  image: 'ubuntu-22.04',
});

export default stack;
`,
  },

  serverless: {
    description: 'API serverless com múltiplas Lambdas e API Gateway',
    constructs: ['Fn.Lambda', 'Fn.ApiGateway'],
    stackSubDir: 'stacks/compute',
    stackContent: (name) => `import { Stack, Fn } from '@iacmp/core';

const stack = new Stack('${name}');

new Fn.Lambda(stack, 'HelloFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 256,
  timeout: 30,
});

new Fn.Lambda(stack, 'UsersFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 256,
  timeout: 30,
});

export default stack;
`,
    extraFiles: [
      {
        path: 'stacks/network/api-gateway-stack.ts',
        content: (name) => `import { Stack, Fn } from '@iacmp/core';

const stack = new Stack('${name}-api');

new Fn.ApiGateway(stack, 'Api', {
  name: '${name}-api',
  type: 'REST',
  stageName: 'prod',
  cors: true,
  authType: 'NONE',
  routes: [
    { method: 'GET', path: '/hello', lambdaId: 'HelloFn' },
    { method: 'GET', path: '/users', lambdaId: 'UsersFn' },
    { method: 'POST', path: '/users', lambdaId: 'UsersFn' },
  ],
});

export default stack;
`,
      },
      {
        path: 'src/index.ts',
        content: () => helloHandlerContent(),
      },
    ],
  },

  fullstack: {
    description: 'Aplicação completa: VPC, compute, banco postgres e bucket',
    constructs: ['Network.VPC', 'Compute.Instance', 'Database.SQL', 'Storage.Bucket'],
    stackContent: (name) => `import { Stack, Network, Compute, Database, Storage } from '@iacmp/core';

const stack = new Stack('${name}');

new Network.VPC(stack, 'VPC', {
  cidr: '10.0.0.0/16',
  maxAzs: 3,
});

new Compute.Instance(stack, 'App', {
  instanceType: 'medium',
  image: 'ubuntu-22.04',
});

new Database.SQL(stack, 'DB', {
  engine: 'postgres',
  instanceType: 'medium',
  multiAz: true,
});

new Storage.Bucket(stack, 'Uploads', {
  versioning: true,
  publicAccess: false,
});

export default stack;
`,
  },
};

// ---------------------------------------------------------------------------
// Helpers de arquivo
// ---------------------------------------------------------------------------

function helloHandlerContent(): string {
  return `export async function handler(): Promise<{ statusCode: number; body: string }> {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Hello, World!' }),
  };
}
`;
}

function packageJson(projectName: string, coreRef: string): string {
  return JSON.stringify({
    name: projectName,
    version: '0.1.0',
    private: true,
    scripts: {
      build: 'tsc',
      watch: 'tsc -w',
      synth: 'iacmp synth',
      deploy: 'iacmp deploy',
    },
    dependencies: {
      '@iacmp/core': coreRef,
    },
    devDependencies: {
      '@types/node': '^22',
      'tsx': '*',
      typescript: '~5.5.0',
    },
  }, null, 2) + '\n';
}

function tsConfig(hasAppCode: boolean): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      moduleResolution: 'bundler',
      lib: ['es2022'],
      types: ['node'],
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      noImplicitReturns: true,
      experimentalDecorators: true,
      strictPropertyInitialization: false,
      skipLibCheck: true,
      outDir: 'dist',
      // src/ é o código de aplicação (handlers de Fn.Lambda) — é o único
      // que precisa de JS compilado de verdade (vai pro zip da Lambda).
      // stacks/ e test/ não entram aqui: stacks/ é carregada via ts-node
      // por `iacmp synth`/`deploy`, e test/ via ts-jest — nenhum dos dois
      // passa por `tsc`, então não tem por que poluir dist/ com eles.
      rootDir: hasAppCode ? 'src' : '.',
      // @iacmp/core é resolvido via node_modules após `npm install`
    },
    ...(hasAppCode ? { include: ['src/**/*'] } : {}),
    exclude: ['node_modules', 'dist'],
  }, null, 2) + '\n';
}

function gitignore(): string {
  return ['node_modules/', 'dist/', 'synth-out/', 'audit/', '*.js.map', '*.d.ts', '.DS_Store', '.env', '.iacmp/', '.iacmp-validate-*/'].join('\n') + '\n';
}

function claudeMd(projectName: string): string {
  return `# iacmp — ${projectName}

> **REGRA ABSOLUTA:** Este projeto usa **exclusivamente o iacmp CLI** com constructs TypeScript do \`@iacmp/core\`.
> NUNCA pergunte "qual formato de IaC?", "Terraform ou CloudFormation?", "qual framework?".
> A resposta é sempre: **iacmp + TypeScript**. Vá direto à geração.

## O que é iacmp

O iacmp CLI gera CloudFormation, Bicep ou Terraform a partir de stacks TypeScript usando \`@iacmp/core\`.
O único trabalho aqui é escrever arquivos \`stacks/**/*.ts\` e validar com \`iacmp synth\`.

## Fluxo de trabalho (OBRIGATÓRIO)

### Com ferramentas MCP do servidor \`iacmp\` disponíveis (modo preferido)

1. \`search_examples <palavras-chave>\` — busca exemplos validados
2. \`write_stack\` — escreve cada arquivo de stack no projeto
3. \`synth_project\` — valida; **nunca entregue sem synth verde**
4. Se falhar: corrija com \`write_stack\` e repita o synth até passar
5. Só depois mostre o resultado ao usuário

### Sem ferramentas MCP (fallback)

1. Escreva os arquivos diretamente com o tool \`Write\` em \`stacks/**/*.ts\`
2. Execute: \`iacmp synth\` via Bash para validar
3. Se falhar: leia o erro, corrija os arquivos e repita o synth
4. Só depois mostre o resultado ao usuário

O synth não é opcional em nenhum dos dois caminhos.

## Organização de stacks (OBRIGATÓRIO)

Cada camada em sua própria subpasta dentro de \`stacks/\`:

| Pasta | Constructs |
|---|---|
| \`stacks/compute/\` | \`Compute.*\`, \`Fn.Lambda\` |
| \`stacks/database/\` | \`Database.*\`, \`Cache.*\` |
| \`stacks/storage/\` | \`Storage.*\` |
| \`stacks/network/\` | \`Network.*\`, \`Fn.ApiGateway\` |
| \`stacks/messaging/\` | \`Messaging.*\`, \`Events.*\` |
| \`stacks/policy/\` | \`Policy.IAM\` |
| \`stacks/security/\` | \`Secret.*\`, \`Certificate.*\` |
| \`stacks/monitoring/\` | \`Monitoring.*\`, \`Logging.*\` |
| \`stacks/workflow/\` | \`Workflow.*\` |

## Regras de código

- Import único: \`import { Stack, ... } from '@iacmp/core';\`
- Inclua \`ref\` se usar \`ref()\`: \`import { Stack, Fn, ref } from '@iacmp/core';\`
- Sempre exporte a stack como default: \`export default stack;\`
- Nomes derivados do domínio do usuário — nunca copie nomes de exemplo
- Não invente propriedades que não existem no catálogo do @iacmp/core

## Referências cross-stack

**Padrão preferido — export tipado:**
\`\`\`typescript
// stacks/database/usuarios-table-stack.ts
export const table = new Database.DynamoDB(stack, 'UsuariosTable', { ... });

// stacks/compute/usuarios-lambda-stack.ts
import { table } from '../database/usuarios-table-stack';
environment: { TABLE_NAME: table.name }
resources: [table.arn]
\`\`\`

**Alternativa com ref() — quando não há import entre stacks:**
\`\`\`typescript
environment: { TABLE_NAME: ref('UsuariosTable', 'Name') }
resources:   [ref('UsuariosTable', 'Arn')]
\`\`\`

- \`ref()\` é um objeto interno — NUNCA chame \`.toString()\` nele
- \`environment\` com recurso: SEMPRE \`ref()\` ou \`table.name\` — nunca string literal

## Restrições

- NUNCA pergunte sobre formato de IaC, framework ou ferramenta — é sempre iacmp
- NUNCA modifique \`package.json\`, \`tsconfig.json\`, \`.env\` ou \`iacmp.json\`
- NUNCA use aws-cdk-lib, constructs ou qualquer pacote fora do @iacmp/core
- NUNCA deixe código incompleto (sem \`// TODO\` ou placeholders)
- Deploy e destroy: só quando o usuário pedir explicitamente
`;
}

function claudeSettings(projectDir: string): string {
  const coreDir = (() => {
    try {
      const corePkgJson = require.resolve('@iacmp/core/package.json');
      return path.dirname(corePkgJson);
    } catch {
      return path.join(projectDir, 'node_modules', '@iacmp', 'core');
    }
  })();
  return JSON.stringify({
    permissions: {
      allow: [
        `Read(${coreDir}/src/**)`,
        `Read(${coreDir}/dist/**)`,
        'Bash(npm run *)',
        'Bash(iacmp *)',
        'Bash(npx iacmp *)',
      ],
    },
  }, null, 2) + '\n';
}

function dotenv(): string {
  return `# Chave da API Anthropic
ANTHROPIC_API_KEY=

# Chave da API OpenAI (alternativa ao Anthropic)
OPENAI_API_KEY=

# Token do GitHub Copilot (alternativa ao Anthropic/OpenAI)
# GITHUB_TOKEN=

# Provider de IA a usar quando mais de uma key estiver configurada (anthropic | openai | copilot)
# Se vazio, a prioridade é: anthropic → openai → copilot
IACMP_PROVIDER_AI=

# Modelo de IA (deixe vazio para usar o padrão de cada provider)
# Anthropic: claude-sonnet-4-6 | claude-opus-4-8 | claude-haiku-4-5-20251001
# OpenAI:    gpt-4o | gpt-4o-mini | gpt-4-turbo | gpt-3.5-turbo
IACMP_MODEL=
`;
}

function githubActionsYml(): string {
  return `name: iacmp

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  synth:
    name: Synth & Validate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm install -g iacmp
      - run: iacmp synth
      - run: npm test
`;
}

function gitlabCiYml(): string {
  return `image: node:20

stages:
  - validate

synth:
  stage: validate
  cache:
    paths:
      - node_modules/
  script:
    - npm ci
    - npm install -g iacmp
    - iacmp synth
    - npm test
`;
}

const PYTHON_PLACEHOLDER = `# iacmp — Stack Python (suporte completo disponível na Fase 4)
#
# from iacmp_core import Stack, Compute, Storage
#
# stack = Stack("minha-stack")
# Compute.Instance(stack, "Web", { "instanceType": "small", "image": "ubuntu-22.04" })
`;

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

    const validProviders = ['aws', 'azure', 'gcp', 'terraform'];
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
      fs.writeFileSync(path.join(projectDir, 'package.json'), packageJson(projectName, coreRef));

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

    // .claude/ — CLAUDE.md com instruções para uso via Claude Code + settings.local.json
    const claudeDir = path.join(projectDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), claudeMd(projectName));
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
    this.log(`  ${rel}/.claude/CLAUDE.md`);
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
        const spinner = ora('Analisando diagrama via IA...').start();
        try {
          const rawModel = process.env['IACMP_MODEL'] ?? '';
          const claudeModel = rawModel.startsWith('claude-') ? rawModel : 'claude-sonnet-4-6';
          const result = await analyzeDiagramImage(
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
