# iacmp — Internal Architecture

---

## Monorepo Structure

```
iacmp/
├── packages/
│   ├── cli/                  # CLI entry point (oclif v4)
│   │   ├── bin/run.js        # Executable binary
│   │   └── src/
│   │       ├── commands/     # One file per command (synth, deploy, init, …)
│   │       ├── synth/        # Synth orchestration per provider (aws, azure, gcp, aws-tf, azure-tf)
│   │       ├── deploy/       # Per-provider executors + deploy/destroy flows (flows/)
│   │       ├── validators/   # Synth-time guards (handler↔stack, VPC, SQL, env vars…)
│   │       ├── pro/          # iacmp Pro boundary (contract + dynamic loader)
│   │       └── init/         # Templates and scaffolding for `iacmp init`
│   ├── core/                 # Cloud-agnostic constructs (Stack, Fn, Database, Network, …)
│   ├── providers/
│   │   ├── aws/              # CloudFormation synth (+ Terraform emitter for --format tf)
│   │   ├── azure/            # Bicep synth (+ azurerm Terraform synth for --format tf)
│   │   ├── gcp/              # Terraform synth (tf.json) — the provider's native format
│   │   └── terraform/        # CFN→tf.json pipeline used by `aws --format tf`
│   ├── runtime/              # Cloud-agnostic facade for handlers: table(), blob(), queue(), sql(), secret()
│   ├── plugin-sdk/           # SDK for custom providers
│   ├── dashboard/            # HTTP server + UI for stack visualization
│   └── registry/             # Catalog of constructs and examples
└── docs/
```

### Dependencies between packages

```
cli ─┬─ @iacmp/core        (published dependency — user stacks import it)
     ├─ @iacmp/runtime     (published dependency — user handlers import it)
     ├─ providers aws/azure/gcp/terraform  (inlined into the CLI bundle)
     ├─ plugin-sdk, dashboard, registry    (inlined into the CLI bundle)
     └─ @iacmp/ai + @iacmp/knowledge       (iacmp Pro — DYNAMIC loading, see below)

Each provider depends only on @iacmp/core — never on another provider.
Executable guards (isolation.test.ts) fail CI if a provider imports from another.
```

### The iacmp Pro boundary

AI-powered generation (`iacmp ai`, `from-diagram`) and the corpus of validated
examples (`@iacmp/ai`, `@iacmp/knowledge`) are proprietary and live outside this
repo. The open CLI never imports them statically:

- `packages/cli/src/pro/types.ts` — structural contract (the surface the CLI consumes);
- `packages/cli/src/pro/index.ts` — loader (`loadAi()`/`loadKnowledge()`): tries a
  regular `require` and `IACMP_PRO_PATH`; if absent → `null` and the command
  degrades gracefully with a clear message. The rest of the CLI depends on none of this.

---

## `iacmp synth` flow

```
1. CLI reads iacmp.json → provider, region, project name
2. Loads ALL stacks from stacks/**/*.ts (tsx registered on-the-fly)
   — a whole-project view is required to resolve cross-stack ref()
3. Synth-time guards (packages/cli/src/validators):
   domain monolith, handler without a file, wrong-cloud SDK, invalid SQL,
   Lambda-in-VPC without an endpoint, undeclared env var, missing GSI, etc.
   Failing here prevents a deploy that would only fail at runtime.
4. Dispatches to the provider module (packages/cli/src/synth/<provider>.ts):
   - aws       → CloudFormation JSON            → synth-out/aws/<stack>.json
   - azure     → Bicep (one stack = one module) → synth-out/azure/<stack>.bicep
                 + _main.bicep (single deployment: ARM resolves ordering/refs)
   - gcp       → Terraform tf.json per stack    → synth-out/gcp/<stack>.tf.json
                 + _providers.tf.json (the directory's SINGLE terraform/provider/
                 variable blocks — all tf.json files form one root module)
   - aws  --format tf → CFN→tf.json pipeline    → synth-out/aws-tf/
   - azure --format tf → azurerm synth          → synth-out/azure-tf/
5. Native post-synth validation (best-effort, skipped without CLI/credentials):
   aws cloudformation validate-template · az bicep build + deployment validate
```

### How constructs are mapped

Every `@iacmp/core` construct has a `type` (e.g. `Fn.Lambda`, `Database.SQL`).
Each provider's synth lives in `src/synth/constructs/<domain>.ts` (function,
database, network, messaging, …) and translates the construct into the native
resource(s) — including the wiring that isn't 1:1 (shared Consumption plan on
Azure, private service access on Cloud SQL, OAC on CloudFront).
The full AWS ↔ Azure ↔ GCP table is in [constructs.md](constructs.md).

### Cross-stack references (`ref()`)

`ref('MinhaTabela', 'Name')` resolves to the right mechanism for each format:
Export/ImportValue in CloudFormation, symbolic module reference in
`_main.bicep`, direct resource reference (`${google_...}` / `${azurerm_...}`)
in Terraform (directory = single state).

---

## `iacmp deploy` flow

```
1. Checks the provider's synth-out (orders stacks by dependency)
2. Per-provider executor (packages/cli/src/deploy/):
   - aws    → aws cloudformation package + deploy (per stack; DR region via marker)
   - azure  → az stack group create on _main.bicep (single deployment stack)
              + handler build/zip (esbuild) + config-zip on Function Apps
   - gcp    → pre-flight (APIs + compute SA roles) + handler build/upload
              + terraform init/apply on the whole directory
   - --format tf → terraform init/apply (aws-tf/azure-tf, single state)
3. Confirmations for destructive actions; --dry-run shows the commands without running them
```

Handlers are packaged at deploy time with the `@iacmp/runtime` facade resolved
to the target cloud's adapter (esbuild alias) — the same `table()`/`blob()` in
user code becomes DynamoDB/Cosmos/Firestore depending on the provider.

---

## Embedded MCP server

The CLI embeds an MCP server (`dist/mcp-server.js`, registered by `iacmp setup`)
that exposes tools to agents (Claude Code/Desktop):

- **Always available** (mechanical): `validate_stack`, `write_stack`,
  `synth_project`, `deploy_project`, `destroy_project`, `from_diagram`,
  `read_synth_output`.
- **With iacmp Pro**: `search_examples` and `list_examples` (search over the
  corpus of examples validated in real deploys). Without Pro, the server starts
  normally and these two tools are simply not listed.

---

## How the Plugin System works

The plugin system lets you add custom providers without touching the core.

**Loading** (`@iacmp/plugin-sdk/loader.ts`):
1. Reads the `plugins` field from `iacmp.json`
2. For each plugin, runs `require(pluginName)`
3. Expects the module to export a `{ providers: [...] }` object
4. Registers each provider by its `name` field

**Plugin interface:**
```javascript
const { definePlugin } = require('@iacmp/plugin-sdk');

module.exports = definePlugin({
  providers: [{
    name: 'meu-provider',
    synthesize(stack) {
      return { /* native template in any format */ };
    },
  }],
});
```

**Usage during synth:**
If the provider is not one of the native ones (aws/azure/gcp), `iacmp synth`
looks it up among plugins loaded via `loadPlugins()`.

---

## How to add a new native provider

1. Create `packages/providers/<nome>/` with the standard structure:
   ```
   src/
   ├── index.ts       # export { NomeProvider }
   ├── provider.ts    # class NomeProvider { synthesize(stack: Stack) }
   └── synth/
       └── constructs/  # one file per domain (function, database, network, …)
   package.json
   tsconfig.json
   ```

2. Implement the synth per domain following the pattern of the existing providers
   (`synth<Dominio>(construct, ctx): boolean` signature, chained dispatcher).
   Depend ONLY on `@iacmp/core` — the isolation guards fail CI if the new
   provider imports from another provider.

3. Add it to `packages/cli/package.json` (devDependency — it is inlined into the
   bundle) and create `packages/cli/src/synth/<nome>.ts` with the output orchestration.

4. Add goldens (`test/golden*`) and, if the format is Terraform, validate with
   `terraform validate` in CI.
