# iacmp — IaC Multi Plataforma

> CLI unificado e inteligente para provisionamento de infraestrutura em AWS, Azure, GCP e Terraform, com suporte a geração de stacks via IA (Anthropic Claude ou GitHub Copilot).

---

## Sumário

1. [Visão Geral](#1-visão-geral)
2. [Objetivos](#2-objetivos)
3. [Instalação](#3-instalação)
4. [Comandos do CLI](#4-comandos-do-cli)
5. [Arquitetura do Projeto](#5-arquitetura-do-projeto)
6. [Abstração de Recursos (Constructs)](#6-abstração-de-recursos-constructs)
7. [Stack Tecnológica](#7-stack-tecnológica)
8. [Módulo AI — Geração de Stacks por IA](#8-módulo-ai--geração-de-stacks-por-ia)
9. [Modos de Interação com a IA](#9-modos-de-interação-com-a-ia)
10. [Arquitetura do Módulo AI](#10-arquitetura-do-módulo-ai)
11. [Interface AIProvider](#11-interface-aiprovider)
12. [Implementação dos Providers AI](#12-implementação-dos-providers-ai)
13. [System Prompt](#13-system-prompt)
14. [Fluxo de Execução da IA](#14-fluxo-de-execução-da-ia)
15. [Diff Colorido e Aprovação de Mudanças](#15-diff-colorido-e-aprovação-de-mudanças)
16. [Configuração do Provider AI](#16-configuração-do-provider-ai)
17. [Exemplos de Uso com IA](#17-exemplos-de-uso-com-ia)
18. [Roadmap de Desenvolvimento](#18-roadmap-de-desenvolvimento)
19. [Desafios e Mitigações](#19-desafios-e-mitigações)
20. [Segurança](#20-segurança)
21. [Dependências](#21-dependências)
22. [Referências e Inspirações](#22-referências-e-inspirações)

---

## 1. Visão Geral

O **iacmp** é um CLI que abstrai a complexidade de múltiplos provedores de cloud, permitindo ao desenvolvedor definir infraestrutura uma vez e fazer deploy em qualquer provedor com comandos simples e consistentes — inspirado na experiência do AWS CDK, mas indo além com geração inteligente de stacks via IA.

Com o módulo AI integrado, o desenvolvedor descreve o que precisa em linguagem natural e o `iacmp` gera automaticamente o código da stack, valida, e oferece o deploy imediato.

```bash
# Exemplo rápido
iacmp ai "cria uma API serverless com autenticação JWT e banco NoSQL na AWS"
# → Gera stacks/serverless-api-stack.ts com API Gateway + Lambda + DynamoDB + Cognito
# → Pergunta: Quer fazer o deploy agora? (y/n)
```

---

## 2. Objetivos

- Unificar a experiência de IaC para AWS, Azure, GCP e Terraform
- Permitir que o mesmo código de infraestrutura seja deployado em múltiplos provedores
- Oferecer uma DX (Developer Experience) próxima ao AWS CDK
- Gerar stacks automaticamente via IA a partir de descrições em linguagem natural
- Suportar TypeScript e Python como linguagens principais
- Ser extensível via plugins de provider

---

## 3. Instalação

O `iacmp` é distribuído via npm e instalado globalmente como qualquer CLI moderno.

### Requisitos

- Node.js 20+
- npm 10+ ou pnpm 9+

### Instalação Global

```bash
npm install -g iacmp
```

Após a instalação, o comando `iacmp` estará disponível globalmente:

```bash
iacmp --version   # iacmp/1.0.0 linux-x64 node-v20.x
iacmp --help      # lista todos os comandos disponíveis
```

### Atualização

```bash
npm update -g iacmp
```

### Verificar Ambiente

```bash
iacmp doctor
# ✓ Node.js v20.11.0
# ✓ iacmp v1.0.0
# ✓ AWS CLI detectado (v2.15.0)
# ✗ Azure CLI não encontrado  → instale com: brew install azure-cli
# ✓ Terraform detectado (v1.8.0)
# ✓ ANTHROPIC_API_KEY configurado
```

### Estrutura do `package.json` publicado

```json
{
  "name": "iacmp",
  "version": "1.0.0",
  "description": "IaC Multi Plataforma — CLI inteligente para AWS, Azure, GCP e Terraform",
  "keywords": ["iac", "cli", "aws", "azure", "gcp", "terraform", "ai", "devops"],
  "bin": {
    "iacmp": "./bin/run.js"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "files": [
    "/bin",
    "/dist",
    "/oclif.manifest.json"
  ]
}
```

### Uso sem instalação (npx)

```bash
npx iacmp init meu-projeto
npx iacmp ai "cria uma stack serverless"
```

---

## 4. Comandos do CLI

### Comandos Base

```bash
iacmp init                          # Inicializa novo projeto
iacmp synth [--provider aws]        # Gera template nativo do provider
iacmp deploy [--provider azure]     # Faz deploy no provider escolhido
iacmp destroy [--provider gcp]      # Destrói a infraestrutura
iacmp diff [--provider terraform]   # Mostra diferenças
iacmp ls                            # Lista stacks disponíveis
iacmp bootstrap --provider aws      # Prepara conta/região para uso
iacmp doctor                        # Verifica ambiente e dependências
iacmp watch                         # Deploy automático ao detectar mudanças
```

### Comandos AI

```bash
iacmp ai "descrição da stack"       # Gera stack via IA (comando único)
iacmp ai --chat                     # Modo chat interativo (igual ao Claude Code)
iacmp ai --dry-run "descrição"      # Prévia sem escrever arquivos
```

### Configuração

```bash
iacmp config set ai.provider anthropic
iacmp config set ai.apiKey sk-ant-...
iacmp config get ai
```

---

## 5. Arquitetura do Projeto

```
iacmp/
├── packages/
│   ├── cli/                        # Entry point do CLI (oclif)
│   ├── core/                       # Abstrações de recursos e engine principal
│   ├── ai/                         # Módulo de geração de stacks via IA
│   │   ├── providers/              # Anthropic e Copilot
│   │   ├── prompts/                # System prompts e templates
│   │   ├── parser/                 # Extração e validação de código
│   │   ├── chat/                   # Sessão e renderização no terminal
│   │   └── tools/                  # File writer, synth runner, context reader
│   ├── providers/
│   │   ├── aws/                    # Provider AWS (CDK / CloudFormation)
│   │   ├── azure/                  # Provider Azure (Bicep / ARM Templates)
│   │   ├── gcp/                    # Provider GCP (Deployment Manager)
│   │   └── terraform/              # Provider Terraform (HCL gerado)
│   └── constructs/                 # Constructs multi-cloud reutilizáveis
├── examples/
│   ├── webapp/
│   ├── database/
│   └── network/
└── docs/
```

---

## 6. Abstração de Recursos (Constructs)

Cada construct representa um recurso de forma agnóstica ao provider:

```typescript
import { Stack, Compute, Storage, Network } from '@iacmp/core';

const stack = new Stack('my-app');

// Compute agnóstico
const server = new Compute.Instance(stack, 'WebServer', {
  instanceType: 'small',   // mapeado para t3.small / B1s / e2-small
  image: 'ubuntu-22.04',
  region: 'us-east-1',
});

// Storage agnóstico
const bucket = new Storage.Bucket(stack, 'Assets', {
  versioning: true,
  publicAccess: false,
});
```

### Mapeamento por Provider

| Construct            | AWS            | Azure            | GCP              | Terraform          |
|----------------------|----------------|------------------|------------------|--------------------|
| `Compute.Instance`   | EC2 Instance   | Azure VM         | Compute Engine   | `aws_instance` etc |
| `Storage.Bucket`     | S3 Bucket      | Blob Storage     | Cloud Storage    | `*_bucket`         |
| `Network.VPC`        | VPC            | Virtual Network  | VPC Network      | `*_network`        |
| `Database.SQL`       | RDS            | Azure SQL        | Cloud SQL        | `*_db_instance`    |
| `Function.Lambda`    | Lambda         | Azure Functions  | Cloud Functions  | `*_function`       |

---

## 7. Stack Tecnológica

### Core
- **Runtime:** Node.js 20+
- **Linguagem:** TypeScript
- **CLI framework:** [oclif](https://oclif.io/)
- **Monorepo:** Turborepo ou Nx

### Providers de Infraestrutura

| Provider  | SDK / Ferramenta                              |
|-----------|-----------------------------------------------|
| AWS       | `aws-cdk-lib`, `aws-sdk-v3`                   |
| Azure     | `@azure/arm-*`, `@azure/identity`             |
| GCP       | `@google-cloud/*`, `@cdktf/provider-google`   |
| Terraform | CDKTF (`cdktf`, `constructs`)                 |

### Geração de Templates
- AWS → CloudFormation JSON/YAML
- Azure → Bicep / ARM Template JSON
- GCP → Deployment Manager YAML
- Terraform → HCL (`.tf` files)

---

## 8. Módulo AI — Geração de Stacks por IA

O módulo AI é o diferencial do `iacmp`. Em vez de escrever o código da stack manualmente, o desenvolvedor descreve em português (ou inglês) o que precisa, e a IA:

1. Interpreta o pedido com contexto do projeto atual
2. Gera o código TypeScript da stack usando os constructs do `@iacmp/core`
3. Valida o código gerado (`tsc --noEmit`)
4. Salva os arquivos no projeto
5. Oferece executar `iacmp synth` e `iacmp deploy` imediatamente

---

## 9. Modos de Interação com a IA

### Modo Comando Único
```bash
iacmp ai "cria uma Lambda com API Gateway e DynamoDB"
```

### Modo Chat Interativo (igual ao Claude Code)
```bash
iacmp ai --chat

> You: preciso de uma arquitetura serverless para um e-commerce
> AI:  Vou criar: API Gateway + Lambda + DynamoDB + S3 + CloudFront
>      Posso adicionar também: SQS para pedidos e SNS para notificações. Deseja?
> You: sim, adiciona SQS e SNS
> AI:  Stack gerada em ./stacks/ecommerce-stack.ts
>      Quer fazer o deploy agora? (y/n)
```

### Modo Revisão / Iteração
```bash
iacmp ai "adiciona auto-scaling na stack ecommerce-stack"
iacmp ai "migra essa stack de AWS para Terraform"
iacmp ai "explica o que essa stack faz"    # documentação automática
iacmp ai "otimiza a stack para reduzir custos"
```

---

## 10. Arquitetura do Módulo AI

```
packages/ai/
├── index.ts                    # Entry point do módulo
├── providers/
│   ├── base.ts                 # Interface AIProvider
│   ├── anthropic.ts            # Integração com Claude API
│   └── copilot.ts              # Integração com GitHub Copilot
├── prompts/
│   ├── system-prompt.ts        # System prompt base com contexto do iacmp
│   ├── stack-generator.ts      # Prompt para geração de stacks
│   ├── stack-migrator.ts       # Prompt para migração entre providers
│   └── stack-explainer.ts      # Prompt para documentação automática
├── parser/
│   ├── code-extractor.ts       # Extrai código do response da IA
│   └── validator.ts            # Valida o código gerado (TypeScript/Python)
├── chat/
│   ├── session.ts              # Gerencia histórico da conversa
│   └── renderer.ts             # Renderiza output no terminal (ink / chalk)
└── tools/
    ├── file-writer.ts          # Escreve arquivos gerados no projeto
    ├── diff-renderer.ts        # Exibe diff colorido antes/depois + prompt de aprovação
    ├── synth-runner.ts         # Roda iacmp synth automaticamente
    └── context-reader.ts       # Lê o projeto atual para dar contexto à IA
```

---

## 11. Interface AIProvider

```typescript
// packages/ai/providers/base.ts

export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AIProvider {
  name: string;
  chat(messages: AIMessage[]): Promise<AIResponse>;
  stream(messages: AIMessage[], onChunk: (chunk: string) => void): Promise<void>;
}
```

---

## 12. Implementação dos Providers AI

### Provider Anthropic (Claude)

```typescript
// packages/ai/providers/anthropic.ts

import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, AIMessage, AIResponse } from './base';

export class AnthropicProvider implements AIProvider {
  name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(messages: AIMessage[]): Promise<AIResponse> {
    const response = await this.client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: messages.filter(m => m.role !== 'system'),
    });

    return {
      content: response.content[0].type === 'text' ? response.content[0].text : '',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async stream(messages: AIMessage[], onChunk: (chunk: string) => void): Promise<void> {
    const stream = await this.client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: messages.filter(m => m.role !== 'system'),
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        onChunk(chunk.delta.text);
      }
    }
  }
}
```

### Provider GitHub Copilot

```typescript
// packages/ai/providers/copilot.ts

export class CopilotProvider implements AIProvider {
  name = 'copilot';
  private token: string;

  constructor(token: string) {
    this.token = token; // GitHub token com permissão Copilot
  }

  async chat(messages: AIMessage[]): Promise<AIResponse> {
    const response = await fetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Copilot-Integration-Id': 'iacmp-cli',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        max_tokens: 8192,
      }),
    });

    const data = await response.json();
    return {
      content: data.choices[0].message.content,
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
    };
  }

  async stream(messages: AIMessage[], onChunk: (chunk: string) => void): Promise<void> {
    const response = await fetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages, stream: true }),
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const json = line.replace('data: ', '');
        if (json === '[DONE]') return;
        const chunk = JSON.parse(json);
        const text = chunk.choices?.[0]?.delta?.content || '';
        if (text) onChunk(text);
      }
    }
  }
}
```

---

## 13. System Prompt

```typescript
// packages/ai/prompts/system-prompt.ts

export const SYSTEM_PROMPT = `
Você é um especialista em infraestrutura como código (IaC) integrado ao iacmp CLI.
Seu papel é gerar stacks de infraestrutura em TypeScript usando os constructs do @iacmp/core.

## Providers disponíveis
- AWS (via CDK)
- Azure (via ARM/Bicep)
- GCP (via Deployment Manager)
- Terraform (via CDKTF)

## Regras de geração de código
1. Sempre use os constructs abstratos do @iacmp/core quando possível
2. Para recursos sem equivalente abstrato, use o NativeResource do provider
3. Gere código TypeScript válido e com tipagem correta
4. Inclua comentários explicativos no código
5. Sempre exporte a stack como default

## Formato de resposta
Responda SEMPRE no seguinte formato JSON:
{
  "explanation": "Explicação do que será criado",
  "files": [
    {
      "path": "stacks/minha-stack.ts",
      "content": "// código TypeScript aqui"
    }
  ],
  "nextSteps": ["iacmp synth", "iacmp deploy --provider aws"],
  "warnings": ["aviso opcional se houver algo importante"]
}

## Contexto do projeto atual
{PROJECT_CONTEXT}
`;
```

---

## 14. Fluxo de Execução da IA

```
Usuário digita: iacmp ai "..."
        │
        ▼
┌──────────────────┐
│  context-reader  │  ← lê stacks existentes, iacmp.json, provider configurado
└────────┬─────────┘
         │
         ▼
┌─────────────────┐
│   session.ts    │  ← monta histórico de mensagens
└────────┬────────┘
         │
         ▼
┌──────────────────────────────┐
│  AIProvider (Claude/Copilot) │  ← streaming do response
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────┐
│  code-extractor  │  ← extrai JSON + código do response
└────────┬─────────┘
         │
         ▼
┌─────────────────┐
│  validator.ts   │  ← tsc --noEmit para validar TypeScript
└────────┬────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│  diff-renderer.ts                        │
│  Exibe antes/depois colorido no terminal │  ← APROVAÇÃO OBRIGATÓRIA
│  [y] aplicar  [n] cancelar  [e] editar   │
└────────┬─────────────────────────────────┘
         │ usuário aprova
         ▼
┌─────────────────┐
│  file-writer.ts │  ← salva arquivos no projeto
└────────┬────────┘
         │
         ▼
┌──────────────────────────────────────┐
│  Pergunta: fazer synth/deploy agora? │
└──────────────────────────────────────┘
```

---

## 15. Diff Colorido e Aprovação de Mudanças

Toda alteração em uma stack existente **exige aprovação explícita** do desenvolvedor. O `iacmp` exibe um diff colorido antes/depois no terminal — idêntico à experiência do Claude Code — antes de escrever qualquer arquivo.

### Exemplo Visual no Terminal

Quando o desenvolvedor pede uma mudança em uma stack existente:

```bash
iacmp ai "adiciona auto-scaling na stack ecommerce-stack"
```

O terminal exibe:

```diff
  stacks/ecommerce-stack.ts                          [modificado]
  ──────────────────────────────────────────────────────────────

    import { Stack, Compute, Storage } from '@iacmp/core';

    const stack = new Stack('ecommerce');

    const server = new Compute.Instance(stack, 'WebServer', {
-     instanceType: 'medium',
+     instanceType: 'medium',
+     autoScaling: {
+       minInstances: 2,
+       maxInstances: 10,
+       targetCpuUtilization: 70,
+     },
      image: 'ubuntu-22.04',
    });

+   const scalingPolicy = new Compute.ScalingPolicy(stack, 'Policy', {
+     target: server,
+     scaleInCooldown: 300,
+     scaleOutCooldown: 60,
+   });

  ──────────────────────────────────────────────────────────────
  2 arquivos modificados · +12 linhas  -1 linha

  ❯ Aplicar mudanças? [y]es  [n]o  [e]dit
```

### Legenda de Cores

| Cor         | Significado                        |
|-------------|------------------------------------|
| 🟢 Verde `+` | Linha adicionada                   |
| 🔴 Vermelho `-` | Linha removida                  |
| ⚪ Branco   | Linha sem alteração (contexto)     |
| 🟡 Amarelo  | Nome do arquivo modificado         |
| 🔵 Azul     | Arquivo novo criado                |
| 🟠 Laranja  | Aviso (breaking change detectado)  |

### Tipos de Operação

```
[modificado]  → arquivo existente com alterações
[novo]        → arquivo criado pela IA
[removido]    → arquivo que será deletado (pede confirmação extra)
[renomeado]   → arquivo movido/renomeado
```

### Opções de Resposta

```bash
[y] yes    → aplica todas as mudanças
[n] no     → cancela, nenhum arquivo é alterado
[e] edit   → abre o diff no editor ($EDITOR) para ajuste manual antes de aplicar
[p] partial → seleciona quais arquivos aceitar (quando há múltiplos)
```

### Casos que Sempre Exigem Confirmação Extra

- Remoção de recursos com estado (banco de dados, buckets com dados)
- Mudanças em IAM roles ou políticas de segurança
- Alterações que causam **replacement** (destruir e recriar) de recursos
- Qualquer operação com `iacmp destroy`

```bash
⚠️  ATENÇÃO: Esta mudança irá SUBSTITUIR o recurso RDS 'ecommerce-db'.
    Isso causará downtime e potencial perda de dados se não houver backup.

    Digite 'CONFIRMO' para prosseguir ou [n] para cancelar:
    ❯ _
```

### Implementação

```typescript
// packages/ai/tools/diff-renderer.ts

import chalk from 'chalk';
import * as Diff from 'diff';
import { select } from '@inquirer/prompts';

export interface FileDiff {
  path: string;
  oldContent: string | null;   // null = arquivo novo
  newContent: string | null;   // null = arquivo removido
}

export async function renderAndConfirm(diffs: FileDiff[]): Promise<boolean> {
  console.log('\n');

  for (const file of diffs) {
    const operation = getOperation(file);
    const label = formatLabel(file.path, operation);
    console.log(label);
    console.log(chalk.dim('─'.repeat(62)));

    if (file.oldContent && file.newContent) {
      const changes = Diff.diffLines(file.oldContent, file.newContent);

      for (const change of changes) {
        const lines = change.value.split('\n').filter(Boolean);
        for (const line of lines) {
          if (change.added)   console.log(chalk.green(`+ ${line}`));
          else if (change.removed) console.log(chalk.red(`- ${line}`));
          else console.log(chalk.gray(`  ${line}`));
        }
      }
    } else if (!file.oldContent) {
      // arquivo novo — exibe tudo em verde
      file.newContent!.split('\n').forEach(l => console.log(chalk.green(`+ ${l}`)));
    } else {
      // arquivo removido — exibe tudo em vermelho
      file.oldContent.split('\n').forEach(l => console.log(chalk.red(`- ${l}`)));
    }

    console.log(chalk.dim('─'.repeat(62)));
  }

  // Resumo
  const added   = diffs.filter(d => !d.oldContent).length;
  const modified = diffs.filter(d => d.oldContent && d.newContent).length;
  const removed  = diffs.filter(d => !d.newContent).length;
  console.log(chalk.dim(`\n  ${modified} modificado(s) · ${added} novo(s) · ${removed} removido(s)\n`));

  // Confirmação
  const answer = await select({
    message: 'Aplicar mudanças?',
    choices: [
      { name: 'yes — aplicar tudo',    value: 'yes' },
      { name: 'no  — cancelar',        value: 'no'  },
      { name: 'edit — abrir no editor', value: 'edit' },
    ],
  });

  if (answer === 'edit') {
    await openInEditor(diffs);
    return renderAndConfirm(diffs); // re-exibe após edição
  }

  return answer === 'yes';
}

function getOperation(file: FileDiff): string {
  if (!file.oldContent) return 'novo';
  if (!file.newContent) return 'removido';
  return 'modificado';
}

function formatLabel(path: string, op: string): string {
  const colors: Record<string, (s: string) => string> = {
    novo:      chalk.blue,
    removido:  chalk.red,
    modificado: chalk.yellow,
  };
  return `\n  ${chalk.bold(path)}  ${colors[op](`[${op}]`)}`;
}
```

### Adição no Fluxo do Módulo AI

O `diff-renderer` é parte do pipeline do `file-writer`:

```typescript
// packages/ai/tools/file-writer.ts

import { renderAndConfirm, FileDiff } from './diff-renderer';
import fs from 'fs/promises';

export async function writeGeneratedFiles(files: GeneratedFile[]): Promise<void> {
  const diffs: FileDiff[] = await Promise.all(
    files.map(async (file) => ({
      path: file.path,
      oldContent: await readExistingFile(file.path),  // null se não existir
      newContent: file.content,
    }))
  );

  const confirmed = await renderAndConfirm(diffs);

  if (!confirmed) {
    console.log(chalk.dim('\n  Operação cancelada. Nenhum arquivo foi alterado.\n'));
    return;
  }

  for (const file of files) {
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.content, 'utf-8');
    console.log(chalk.green(`  ✓ ${file.path}`));
  }
}
```

---

## 16. Configuração do Provider AI

```bash
# Configurar Anthropic
iacmp config set ai.provider anthropic
iacmp config set ai.apiKey sk-ant-...

# Configurar GitHub Copilot
iacmp config set ai.provider copilot
iacmp config set ai.token ghp_...

# Ver configuração atual
iacmp config get ai
```

Ou via variáveis de ambiente:

```bash
# Anthropic
export IACMP_AI_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# GitHub Copilot
export IACMP_AI_PROVIDER=copilot
export GITHUB_TOKEN=ghp_...
```

---

## 17. Exemplos de Uso com IA

### Exemplo 1 — Serverless API
```bash
iacmp ai "api serverless com autenticação JWT, CRUD de usuários e banco NoSQL"
```
Gera: `stacks/serverless-api-stack.ts` → API Gateway + Lambda + DynamoDB + Cognito

### Exemplo 2 — Migração de Provider
```bash
iacmp ai "migra a stack serverless-api de AWS para Terraform"
```
Gera: `stacks/serverless-api-terraform.ts` → equivalente em CDKTF

### Exemplo 3 — Otimização de Custo
```bash
iacmp ai "otimiza a stack ecommerce-stack para reduzir custos"
```
Responde: sugestões de instâncias menores, Reserved Instances, S3 lifecycle policies

### Exemplo 4 — Documentação Automática
```bash
iacmp ai "documenta a stack ecommerce-stack em português"
```
Gera: `docs/ecommerce-stack.md` com diagrama e descrição de cada recurso

### Exemplo 5 — Fluxo Completo
```bash
iacmp init meu-projeto --language typescript
iacmp bootstrap --provider aws --region us-east-1
iacmp ai --chat

> You: quero uma arquitetura completa para SaaS B2B multi-tenant
> AI:  Vou criar: VPC + ECS Fargate + RDS Multi-AZ + ElastiCache + CloudFront + WAF
>      Também recomendo: Cognito para auth e SQS para jobs assíncronos. Incluo?
> You: inclui tudo
> AI:  Stack gerada em ./stacks/saas-multitenant-stack.ts
>      Quer fazer o deploy agora? (y/n)
> You: y
iacmp deploy --provider aws --stack saas-multitenant-stack
```

---

## 18. Roadmap de Desenvolvimento

### Fase 1 — MVP do CLI Base (2–3 meses)
- [x] Setup do monorepo (Turborepo)
- [x] CLI básico com `init`, `synth`, `deploy`, `destroy`
- [x] Provider AWS funcional (via CDK por baixo)
- [x] 5 constructs core: Compute, Storage, Network, Database, Function
- [x] Suporte a TypeScript

### Fase 2 — Multi-cloud (2–3 meses)
- [x] Provider Azure
- [x] Provider GCP
- [x] Provider Terraform
- [x] `iacmp diff` e `iacmp doctor`
- [x] Suporte a Python

### Fase 3 — Módulo AI (2–3 meses)
- [ ] Interface `AIProvider` + Provider Anthropic (Claude)
- [ ] Provider GitHub Copilot
- [ ] System prompt + geração de stacks AWS
- [ ] Parser de código + validator TypeScript
- [ ] Modo chat interativo (`--chat`)
- [ ] Suporte a Azure e GCP na geração AI
- [ ] Migração entre providers via IA
- [ ] Documentação automática de stacks

### Fase 4 — DX & Ecossistema (2–3 meses)
- [x] Plugin system para providers customizados
- [x] `iacmp watch` (hot deploy)
- [x] Dashboard web de visualização de stacks
- [x] Registry de constructs da comunidade
- [x] CI/CD integrations (GitHub Actions, GitLab CI)

### Fase 5 — Produção
- [x] Testes de integração por provider
- [x] Documentação completa
- [x] Publicação no npm como `iacmp`
- [x] Exemplos de projetos reais

---

## 19. Desafios e Mitigações

| Desafio | Mitigação |
|---------|-----------|
| Diferenças de features entre providers | Expor features específicas via `provider options` |
| Mapeamento de regiões/zonas | Tabela de equivalência + configuração explícita |
| Autenticação diferente por provider | Módulo de auth unificado com adapters |
| Drift de estado (infra real vs código) | Integrar com state backends (S3, Azure Blob, GCS) |
| Providers com recursos sem equivalente | Escape hatch: `NativeResource` para recursos raw |
| Código gerado pela IA com erros | Validação com `tsc --noEmit` antes de salvar |
| Alucinações da IA em nomes de recursos | System prompt rigoroso + fallback para docs oficiais |
| Custo de tokens da IA | Cache de respostas + modo `--dry-run` |

---

## 20. Segurança

- API Keys **nunca** armazenadas em texto puro — usar sistema de keychain do SO (`keytar`)
- Código gerado pela IA passa por validação antes de ser escrito em disco
- Modo `--dry-run` para ver o que seria gerado sem escrever arquivos
- Log de todas as gerações em `~/.iacmp/history.json` para auditoria
- Credenciais de cloud nunca enviadas para a IA — apenas metadados do projeto

---

## 21. Dependências

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "aws-cdk-lib": "^2.150.0",
    "cdktf": "^0.20.0",
    "@azure/arm-resources": "^5.0.0",
    "@azure/identity": "^4.0.0",
    "@google-cloud/resource-manager": "^5.0.0",
    "oclif": "^4.0.0",
    "ink": "^5.0.0",
    "ink-spinner": "^5.0.0",
    "chalk": "^5.3.0",
    "ora": "^8.0.0",
    "diff": "^5.2.0",
    "@inquirer/prompts": "^5.0.0",
    "keytar": "^7.9.0",
    "typescript": "^5.5.0"
  }
}
```

---

## 22. Referências e Inspirações

- [AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
- [CDKTF — CDK for Terraform](https://developer.hashicorp.com/terraform/cdktf)
- [Pulumi](https://www.pulumi.com/)
- [oclif — CLI framework](https://oclif.io/)
- [Crossplane](https://www.crossplane.io/)
- [Anthropic Claude API](https://docs.anthropic.com/)
- [GitHub Copilot API](https://docs.github.com/en/copilot)

---

*iacmp — IaC Multi Plataforma | Junho 2026*
