// Arquivos de scaffold do `iacmp init`: package.json, tsconfig, gitignore,
// settings do Claude, .env de exemplo, CI e placeholder Python.
import * as path from 'path';

export function packageJson(projectName: string, coreRef: string, provider: string): string {
  const awsSdkDeps = provider === 'aws' || provider === 'terraform' ? {
    '@aws-sdk/client-dynamodb': '*',
    '@aws-sdk/lib-dynamodb': '*',
    '@aws-sdk/client-s3': '*',
  } : {};
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
      ...awsSdkDeps,
    },
  }, null, 2) + '\n';
}

export function tsConfig(hasAppCode: boolean): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      moduleResolution: 'node',
      lib: ['es2022'],
      types: ['node'],
      strict: false,
      noImplicitAny: false,
      esModuleInterop: true,
      experimentalDecorators: true,
      strictPropertyInitialization: false,
      skipLibCheck: true,
      outDir: 'dist',
      rootDir: 'src',
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist'],
  }, null, 2) + '\n';
}

export function gitignore(): string {
  return ['node_modules/', 'dist/', 'synth-out/', 'audit/', '*.js.map', '*.d.ts', '.DS_Store', '.env', '.iacmp/', '.iacmp-validate-*/'].join('\n') + '\n';
}

export function claudeSettings(projectDir: string): string {
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

export function dotenv(): string {
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

export function githubActionsYml(): string {
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

export function gitlabCiYml(): string {
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

export const PYTHON_PLACEHOLDER = `# iacmp — Stack Python (suporte completo disponível na Fase 4)
#
# from iacmp_core import Stack, Compute, Storage
#
# stack = Stack("minha-stack")
# Compute.Instance(stack, "Web", { "instanceType": "small", "image": "ubuntu-22.04" })
`;
