# Contributing to iacmp

---

## Prerequisites

- Node.js 20+
- npm 10+
- Git

---

## Development environment setup

```bash
git clone https://github.com/Claudio-Fontes/iacmp.git
cd iacmp
npm install
npm run build
```

Check that everything is working:

```bash
node packages/cli/bin/run.js doctor
node packages/cli/bin/run.js --help
```

Quick summary of the contribution flow:

1. `npm install`
2. `npm run build`
3. `npm test`
4. Open a PR describing the change (in pt-BR).

---

## Monorepo structure

```
iacmp/
├── packages/
│   ├── cli/           # CLI (oclif) — commands the user runs
│   ├── core/          # Abstract constructs and the Stack class
│   ├── runtime/       # Cloud-agnostic facade for handlers (table, blob, queue…)
│   ├── plugin-sdk/    # SDK for custom providers
│   ├── dashboard/     # Stack visualization UI
│   ├── registry/      # Catalog of constructs/examples
│   └── providers/
│       ├── aws/       # CloudFormation synthesis
│       ├── azure/     # Bicep synthesis (+ azurerm Terraform for --format tf)
│       ├── gcp/       # Terraform synthesis (tf.json)
│       └── terraform/ # CFN→tf.json pipeline (aws --format tf)
├── docs/              # Documentation
└── examples/          # Example projects
```

Each package is independent and has its own `package.json` and `tsconfig.json`. Turborepo manages the build order (core → providers → cli).

---

## Available scripts

At the monorepo root:

```bash
npm run build       # Builds all packages in order
npm run dev         # Watch mode across all packages
npm run typecheck   # Type checking without compiling
npm run clean       # Removes every dist/
```

Inside a specific package:

```bash
cd packages/cli
npm run build       # Builds only this package
npm run dev         # Watch only this package
npm run manifest    # Regenerates oclif.manifest.json (required after adding a command)
```

---

## Adding a new CLI command

1. Create the file at `packages/cli/src/commands/nome-do-comando.ts`:

```typescript
import { Command, Flags } from '@oclif/core';

export default class NomeDoComando extends Command {
  static description = 'Short command description';

  static flags = {
    provider: Flags.string({ char: 'p', description: 'Provider alvo', default: 'aws' }),
  };

  static examples = ['$ iacmp nome-do-comando --provider aws'];

  async run(): Promise<void> {
    const { flags } = await this.parse(NomeDoComando);
    // implementation
  }
}
```

2. Build and regenerate the manifest:

```bash
cd packages/cli
npm run build
npm run manifest
```

3. Test it:

```bash
node packages/cli/bin/run.js nome-do-comando --help
```

---

## Adding a new construct

Constructs live in `packages/core/src/constructs/`. Every construct follows the
same pattern: one `*Props` per subtype, classes inside a per-domain `namespace`,
`implements BaseConstruct`, validations in the constructor, and `stack.addConstruct(this)`.

Use `packages/core/src/constructs/cache.ts` as a reference:

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

Things to note:

- The `type` is a `Namespace.Subtipo` string (e.g. `Cache.Redis`) and is the
  discriminator each provider uses to synthesize the resource.
- The constructor calls `stack.addConstruct(this)` at the end — that is how the
  construct gets into the Stack's array.
- Validations that would otherwise fail in the provider must throw in the
  constructor with a message containing the construct's `id`.

Export the namespace and its props in `packages/core/src/index.ts`:

```typescript
export { Cache } from './constructs/cache';
export type { CacheRedisProps, CacheMemcachedProps } from './constructs/cache';
```

For every new subtype, add the `case '<Namespace.Subtipo>'` to all 4 synths
(`packages/providers/aws|azure|gcp|terraform/src/synth/*.ts`). Without it, the
construct is silently ignored by the providers that were not updated.

---

## Adding support for a new provider

1. Create the package in `packages/providers/nome/`
2. Implement the `Provider` interface:

```typescript
export interface Provider {
  name: string;
  synthesize(stack: Stack): unknown;
}
```

3. Add the package to the workspace in the root `package.json` (already covered by the `packages/providers/*` glob)
4. Register the provider in the CLI's `synth` command

---

## Code conventions

- TypeScript in every package — no explicit `any`
- No obvious comments — only when the reason is not clear from the code
- No error handling for scenarios that cannot happen
- No single-use abstractions

---

## Commits

Format: `tipo: descrição curta` — commit messages are written in Portuguese.

| Tipo | When to use |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Refactoring with no behavior change |
| `infra` | Build, CI, configuration changes |
| `docs` | Documentation |

Examples:
```
feat: adiciona construct Cache.Cluster
fix: corrige resolução de provider no comando synth
docs: adiciona guia de contribuição
```
