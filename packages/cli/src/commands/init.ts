import { Command, Args, Flags } from '@oclif/core';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Templates de stack — embutidos no CLI, funcionam após npm install -g iacmp
// ---------------------------------------------------------------------------

interface Template {
  description: string;
  constructs: string[];    // lista para exibir no --list
  stackContent: (projectName: string) => string;
}

const TEMPLATES: Record<string, Template> = {
  default: {
    description: 'Servidor web simples com bucket de assets',
    constructs: ['Compute.Instance', 'Storage.Bucket'],
    stackContent: (name) => `import { Stack, Compute, Storage } from '@iacmp/core';

const stack = new Stack('${name}');

new Compute.Instance(stack, 'Web', {
  instanceType: 'small',
  image: 'ubuntu-22.04',
});

new Storage.Bucket(stack, 'Assets', {
  versioning: true,
  publicAccess: false,
});

export default stack;
`,
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
    description: 'API serverless com Lambda e VPC',
    constructs: ['Network.VPC', 'Function.Lambda'],
    stackContent: (name) => `import { Stack, Network, Fn } from '@iacmp/core';

const stack = new Stack('${name}');

new Network.VPC(stack, 'Rede', {
  cidr: '10.0.0.0/16',
  maxAzs: 2,
});

new Fn.Lambda(stack, 'Handler', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 512,
  timeout: 30,
});

export default stack;
`,
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

function testContent(projectName: string, stackFile: string): string {
  return `import { Stack } from '@iacmp/core';
import stack from '../stacks/${stackFile}';

test('${projectName} stack tem pelo menos um construct', () => {
  expect(stack).toBeInstanceOf(Stack);
  expect(stack.constructs.length).toBeGreaterThan(0);
});
`;
}

function packageJson(projectName: string): string {
  return JSON.stringify({
    name: projectName,
    version: '0.1.0',
    private: true,
    scripts: {
      build: 'tsc',
      watch: 'tsc -w',
      test: 'jest',
      synth: 'iacmp synth',
      deploy: 'iacmp deploy',
    },
    devDependencies: {
      '@types/jest': '^30',
      '@types/node': '^22',
      jest: '^30',
      'ts-jest': '^29',
      'ts-node': '^10',
      typescript: '~5.5.0',
    },
    jest: {
      preset: 'ts-jest',
      testEnvironment: 'node',
    },
  }, null, 2) + '\n';
}

function tsConfig(corePath: string): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      moduleResolution: 'node',
      lib: ['es2022'],
      declaration: true,
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      noImplicitReturns: true,
      experimentalDecorators: true,
      strictPropertyInitialization: false,
      skipLibCheck: true,
      outDir: 'dist',
      rootDir: '.',
      paths: {
        '@iacmp/core': [corePath],
        '@iacmp/core/*': [`${corePath}/*`],
      },
    },
    exclude: ['node_modules', 'dist'],
  }, null, 2) + '\n';
}

function gitignore(): string {
  return ['node_modules/', 'dist/', 'synth-out/', 'audit/', '*.js.map', '*.d.ts', '.DS_Store', '.env'].join('\n') + '\n';
}

function dotenv(): string {
  return `# Chave da API Anthropic — necessária para usar iacmp ai
ANTHROPIC_API_KEY=

# Token do GitHub Copilot (alternativa ao Anthropic)
# GITHUB_TOKEN=
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
    template: Flags.string({
      char: 't',
      description: `Template de stack a usar (default, rds, webapp, network, serverless, fullstack)`,
      default: 'default',
    }),
    list: Flags.boolean({ description: 'Lista os templates disponíveis', default: false }),
  };

  static examples = [
    '$ iacmp init meu-projeto',
    '$ iacmp init meu-projeto --template rds',
    '$ iacmp init meu-projeto --template webapp --provider azure',
    '$ iacmp init meu-projeto --template serverless',
    '$ iacmp init meu-projeto --template fullstack',
    '$ iacmp init --list',
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
    const config = { name: projectName, provider: flags.provider, region: 'us-east-1', language: flags.language };
    fs.writeFileSync(path.join(projectDir, 'iacmp.json'), JSON.stringify(config, null, 2) + '\n');

    // .gitignore
    fs.writeFileSync(path.join(projectDir, '.gitignore'), gitignore());

    // .env
    fs.writeFileSync(path.join(projectDir, '.env'), dotenv());

    // stacks/
    const stacksDir = path.join(projectDir, 'stacks');
    fs.mkdirSync(stacksDir, { recursive: true });

    const stackFileName = `${projectName}-stack.ts`;

    if (flags.language === 'typescript') {
      // package.json
      fs.writeFileSync(path.join(projectDir, 'package.json'), packageJson(projectName));

      // tsconfig.json
      const corePkgJson = require.resolve('@iacmp/core/package.json');
      const corePath = path.dirname(corePkgJson);
      fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), tsConfig(corePath));

      // stack (usa o template escolhido)
      fs.writeFileSync(path.join(stacksDir, stackFileName), template.stackContent(projectName));

      // test/
      const testDir = path.join(projectDir, 'test');
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, `${projectName}.test.ts`),
        testContent(projectName, `${projectName}-stack`),
      );

      // CI/CD
      const githubWorkflowsDir = path.join(projectDir, '.github', 'workflows');
      fs.mkdirSync(githubWorkflowsDir, { recursive: true });
      fs.writeFileSync(path.join(githubWorkflowsDir, 'iacmp.yml'), githubActionsYml());
      fs.writeFileSync(path.join(projectDir, '.gitlab-ci.yml'), gitlabCiYml());
    } else {
      fs.writeFileSync(path.join(stacksDir, 'exemplo_stack.py'), PYTHON_PLACEHOLDER);
    }

    // git init
    try {
      execSync('git init', { cwd: projectDir, stdio: 'pipe' });
    } catch {}

    const rel = args.name ?? '.';
    const isDefault = flags.template === 'default';
    const templateLabel = isDefault ? '' : ` (template: ${flags.template})`;

    this.log(`\nProjeto '${projectName}' inicializado${templateLabel}.\n`);
    this.log(`  ${rel}/iacmp.json`);
    this.log(`  ${rel}/.env`);
    if (flags.language === 'typescript') {
      this.log(`  ${rel}/package.json`);
      this.log(`  ${rel}/tsconfig.json`);
      this.log(`  ${rel}/stacks/${stackFileName}`);
      this.log(`  ${rel}/test/${projectName}.test.ts`);
      this.log(`  ${rel}/.github/workflows/iacmp.yml`);
      this.log(`  ${rel}/.gitlab-ci.yml`);
    }

    // mostra os constructs do template
    if (!isDefault) {
      this.log(`\nRecursos incluídos:`);
      for (const c of template.constructs) {
        this.log(`  · ${c}`);
      }
    }

    this.log('\nPróximos passos:');
    if (args.name) this.log(`  cd ${args.name}`);
    this.log('  npm install');
    this.log('  iacmp synth');
  }
}
