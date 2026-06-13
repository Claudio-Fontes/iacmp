import { Command, Args, Flags } from '@oclif/core';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function stackExample(projectName: string): string {
  const className = projectName
    .split(/[-_]/)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join('') + 'Stack';

  return `import { Stack, Compute, Storage } from '@iacmp/core';

const stack = new Stack('${projectName}');

new Compute.Instance(stack, 'Web', {
  instanceType: 'small',
  image: 'ubuntu-22.04',
});

new Storage.Bucket(stack, 'Assets', {
  versioning: true,
  publicAccess: false,
});

export default stack;
`;
}

function testExample(projectName: string, stackFile: string): string {
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
      'jest': '^30',
      'ts-jest': '^29',
      'ts-node': '^10',
      'typescript': '~5.5.0',
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
  return [
    'node_modules/',
    'dist/',
    'synth-out/',
    '*.js.map',
    '*.d.ts',
    '.DS_Store',
  ].join('\n') + '\n';
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

export default class Init extends Command {
  static description = 'Inicializa um novo projeto iacmp. Se um nome for passado, cria a pasta do projeto.';

  static args = {
    name: Args.string({ description: 'Nome do projeto (cria a pasta automaticamente)', required: false }),
  };

  static flags = {
    language: Flags.string({ char: 'l', description: 'Linguagem (typescript, python)', default: 'typescript' }),
    provider: Flags.string({ char: 'p', description: 'Provider padrão (aws, azure, gcp, terraform)', default: 'aws' }),
  };

  static examples = [
    '$ iacmp init meu-projeto',
    '$ iacmp init meu-projeto --provider azure',
    '$ iacmp init --language python',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Init);

    const validLanguages = ['typescript', 'python'];
    if (!validLanguages.includes(flags.language)) {
      this.error(`Linguagem '${flags.language}' não suportada. Use: ${validLanguages.join(', ')}`);
    }

    const validProviders = ['aws', 'azure', 'gcp', 'terraform'];
    if (!validProviders.includes(flags.provider)) {
      this.error(`Provider '${flags.provider}' não suportado. Use: ${validProviders.join(', ')}`);
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

    // stacks/
    const stacksDir = path.join(projectDir, 'stacks');
    fs.mkdirSync(stacksDir, { recursive: true });

    if (flags.language === 'typescript') {
      // package.json
      fs.writeFileSync(path.join(projectDir, 'package.json'), packageJson(projectName));

      // tsconfig.json — aponta @iacmp/core para onde o CLI está instalado
      const corePkgJson = require.resolve('@iacmp/core/package.json');
      const corePath = path.dirname(corePkgJson);
      fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), tsConfig(corePath));

      // stacks/<nome>-stack.ts
      const stackFileName = `${projectName}-stack.ts`;
      fs.writeFileSync(path.join(stacksDir, stackFileName), stackExample(projectName));

      // test/
      const testDir = path.join(projectDir, 'test');
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, `${projectName}.test.ts`),
        testExample(projectName, `${projectName}-stack`),
      );

      // CI/CD — GitHub Actions
      const githubWorkflowsDir = path.join(projectDir, '.github', 'workflows');
      fs.mkdirSync(githubWorkflowsDir, { recursive: true });
      fs.writeFileSync(path.join(githubWorkflowsDir, 'iacmp.yml'), githubActionsYml());

      // CI/CD — GitLab CI
      fs.writeFileSync(path.join(projectDir, '.gitlab-ci.yml'), gitlabCiYml());
    } else {
      fs.writeFileSync(path.join(stacksDir, 'exemplo_stack.py'), PYTHON_PLACEHOLDER);
    }

    // git init
    try {
      execSync('git init', { cwd: projectDir, stdio: 'pipe' });
    } catch {}

    const rel = args.name ?? '.';
    this.log(`\nProjeto '${projectName}' inicializado com sucesso.\n`);
    this.log(`  ${rel}/iacmp.json`);
    if (flags.language === 'typescript') {
      this.log(`  ${rel}/package.json`);
      this.log(`  ${rel}/tsconfig.json`);
      this.log(`  ${rel}/stacks/${projectName}-stack.ts`);
      this.log(`  ${rel}/test/${projectName}.test.ts`);
      this.log(`  ${rel}/.github/workflows/iacmp.yml`);
      this.log(`  ${rel}/.gitlab-ci.yml`);
    }
    this.log('');
    this.log('Próximos passos:');
    if (args.name) this.log(`  cd ${args.name}`);
    this.log('  npm install');
    this.log('  iacmp synth');
  }
}
