# Contribuindo com o iacmp

---

## Pré-requisitos

- Node.js 20+
- npm 10+
- Git

---

## Setup do ambiente de desenvolvimento

```bash
git clone https://github.com/Claudio-Fontes/iacmp.git
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

Os constructs ficam em `packages/core/src/constructs/`. Cada construct segue o
padrão: um `*Props` por subtipo, classes dentro de um `namespace` por domínio,
`implements BaseConstruct`, validações no construtor e `stack.addConstruct(this)`.

Use `packages/core/src/constructs/cache.ts` como referência:

```typescript
// packages/core/src/constructs/cache.ts
import { Stack, BaseConstruct } from '../stack';

export interface CacheRedisProps {
  nodeType?: 'small' | 'medium' | 'large';
  numCacheNodes?: number;
  automaticFailoverEnabled?: boolean;
  atRestEncryptionEnabled?: boolean;
  transitEncryptionEnabled?: boolean;
  version?: string;
  subnetGroupName?: string;
  securityGroupIds?: string[];
}

export interface CacheMemcachedProps {
  nodeType?: 'small' | 'medium' | 'large';
  numCacheNodes?: number;
  subnetGroupName?: string;
}

export namespace Cache {
  export class Redis implements BaseConstruct {
    readonly type = 'Cache.Redis';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: CacheRedisProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class Memcached implements BaseConstruct {
    readonly type = 'Cache.Memcached';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: CacheMemcachedProps) {
      if ((props.numCacheNodes ?? 1) < 1)
        throw new Error(`Cache.Memcached "${id}": numCacheNodes deve ser >= 1`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
```

Pontos a observar:

- O `type` é uma string `Namespace.Subtipo` (ex.: `Cache.Redis`) e é o
  discriminador que cada provider usa para sintetizar o recurso.
- O construtor chama `stack.addConstruct(this)` no fim — é assim que o
  construct entra no array da Stack.
- Validações que falhariam no provider devem disparar no construtor com mensagem
  contendo o `id` do construct.

Exporte o namespace e seus props em `packages/core/src/index.ts`:

```typescript
export { Cache } from './constructs/cache';
export type { CacheRedisProps, CacheMemcachedProps } from './constructs/cache';
```

Para cada novo subtipo, adicione o `case '<Namespace.Subtipo>'` nos 4 synths
(`packages/providers/aws|azure|gcp|terraform/src/synth/*.ts`). Sem isso o
construct é silenciosamente ignorado nos providers não atualizados.

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
