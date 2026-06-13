# Contribuindo com o iacmp

---

## Pré-requisitos

- Node.js 20+
- npm 10+
- Git

---

## Setup do ambiente de desenvolvimento

```bash
git clone https://github.com/seu-usuario/iacmp.git
cd iacmp
npm install
npm run build
```

Verificar que está tudo ok:

```bash
node packages/cli/bin/run.js doctor
node packages/cli/bin/run.js --help
```

---

## Estrutura do monorepo

```
iacmp/
├── packages/
│   ├── cli/           # CLI (oclif) — comandos que o usuário executa
│   ├── core/          # Constructs abstratos e classe Stack
│   └── providers/
│       └── aws/       # Síntese para CloudFormation
├── docs/              # Documentação
└── examples/          # Projetos de exemplo
```

Cada package é independente e tem seu próprio `package.json` e `tsconfig.json`. O Turborepo gerencia a ordem de build (core → providers → cli).

---

## Scripts disponíveis

Na raiz do monorepo:

```bash
npm run build       # Compila todos os packages em ordem
npm run dev         # Modo watch em todos os packages
npm run typecheck   # Verificação de tipos sem compilar
npm run clean       # Remove todos os dist/
```

Dentro de um package específico:

```bash
cd packages/cli
npm run build       # Compila só este package
npm run dev         # Watch só este package
npm run manifest    # Regenera o oclif.manifest.json (necessário após adicionar comando)
```

---

## Adicionando um novo comando CLI

1. Crie o arquivo em `packages/cli/src/commands/nome-do-comando.ts`:

```typescript
import { Command, Flags } from '@oclif/core';

export default class NomeDoComando extends Command {
  static description = 'Descrição curta do comando';

  static flags = {
    provider: Flags.string({ char: 'p', description: 'Provider alvo', default: 'aws' }),
  };

  static examples = ['$ iacmp nome-do-comando --provider aws'];

  async run(): Promise<void> {
    const { flags } = await this.parse(NomeDoComando);
    // implementação
  }
}
```

2. Compile e regenere o manifest:

```bash
cd packages/cli
npm run build
npm run manifest
```

3. Teste:

```bash
node packages/cli/bin/run.js nome-do-comando --help
```

---

## Adicionando um novo construct

Os constructs ficam em `packages/core/src/constructs/`.

Cada construct segue a mesma estrutura:

```typescript
// packages/core/src/constructs/cache.ts
import { Stack, BaseConstruct } from '../stack';

export interface CacheOptions {
  engine: 'redis' | 'memcached';
  instanceType?: string;
}

export class CacheCluster extends BaseConstruct {
  readonly engine: string;
  readonly instanceType: string;

  constructor(stack: Stack, id: string, options: CacheOptions) {
    super(stack, id, 'Cache.Cluster');
    this.engine = options.engine;
    this.instanceType = options.instanceType ?? 'cache.t3.micro';
  }
}

export const Cache = { Cluster: CacheCluster };
```

Depois exporte do `packages/core/src/index.ts`:

```typescript
export { Cache } from './constructs/cache';
```

Para cada novo construct, adicione também o mapeamento no provider correspondente (ex: `packages/providers/aws/src/synth/cloudformation.ts`).

---

## Adicionando suporte a um novo provider

1. Crie o package em `packages/providers/nome/`
2. Implemente a interface `Provider`:

```typescript
export interface Provider {
  name: string;
  synthesize(stack: Stack): unknown;
}
```

3. Adicione o package ao workspace em `package.json` na raiz (já coberto pelo glob `packages/providers/*`)
4. Registre o provider no comando `synth` do CLI

---

## Convenções de código

- TypeScript em todos os packages — sem `any` explícito
- Sem comentários óbvios — apenas quando o motivo não é claro pelo código
- Sem tratamento de erro para cenários que não podem acontecer
- Sem abstrações para uso único

---

## Commits

Formato: `tipo: descrição curta em português`

| Tipo | Quando usar |
|---|---|
| `feat` | Nova funcionalidade |
| `fix` | Correção de bug |
| `refactor` | Refatoração sem mudança de comportamento |
| `infra` | Mudanças em build, CI, configuração |
| `docs` | Documentação |

Exemplos:
```
feat: adiciona construct Cache.Cluster
fix: corrige resolução de provider no comando synth
docs: adiciona guia de contribuição
```
