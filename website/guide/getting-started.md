# Getting started in 5 minutes

From zero to a validated, deployable serverless API. All you need is **Node.js 20+**.

## 1. Install

```bash
npm install -g iacmp
```

Check it worked:

```bash
iacmp --version
```

::: tip Command not found?
The installer links `iacmp` into your PATH for immediate use. If your shell still can't find it, open a new terminal. Still nothing? Diagnose with:

```bash
npx iacmp doctor
```
:::

## 2. Create a project

```bash
iacmp init my-api --template serverless
cd my-api
```

This generates a complete, working project:

```
my-api/
  iacmp.json          # provider, region, language
  stacks/             # your infrastructure, one stack per domain
  src/handlers/       # TypeScript handlers (cloud-agnostic)
  CLAUDE.md           # guides AI agents through the right flow
```

Want to see the other templates (blank, hello, rds, webapp, network, serverless, fullstack)?

```bash
iacmp init --list
```

## 3. Look at what you got

A stack is plain TypeScript — no YAML, no HCL:

```typescript
import { Stack, Fn, Database, ref } from '@iacmp/core';

const stack = new Stack('ApiStack');

new Database.DynamoDB(stack, 'ItemsTable', { partitionKey: 'id' });

new Fn.Lambda(stack, 'ItemsFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/handlers/items',
  environment: { TABLE_NAME: ref('ItemsTable', 'Name') },
});

export default stack;
```

Handlers use the cloud-agnostic [`@iacmp/runtime`](https://www.npmjs.com/package/@iacmp/runtime) facade — the same code runs on Lambda, Azure Functions and Cloud Functions:

```typescript
import { table } from '@iacmp/runtime';

export async function handler() {
  const items = await table('ItemsTable').scan();
  return { statusCode: 200, body: JSON.stringify(items) };
}
```

## 4. Synthesize

```bash
iacmp synth
```

This compiles your stacks to the native format of the configured provider (CloudFormation by default) **and validates them** — both with iacmp's own semantic checks and with the cloud's validator when your CLI is configured:

```
✔ ApiStack → out/aws/api-stack.json
  CFN validate OK: api-stack
```

Try the other clouds from the same code:

```bash
iacmp synth --provider azure    # → Bicep
iacmp synth --provider gcp      # → Terraform (tf.json)
```

## 5. Deploy (optional, but the fun part)

You need the target cloud's CLI configured — for AWS:

```bash
aws configure        # access key, secret, region
iacmp doctor         # checks everything is in place
```

Then:

```bash
iacmp deploy --dry-run --provider aws   # shows exactly what would be created
iacmp deploy --provider aws             # deploys for real (asks for confirmation)
```

Without `--provider`, iacmp uses the one set in the project's `iacmp.json` (`aws`, `azure` or `gcp`).

When you're done experimenting:

```bash
iacmp destroy --provider aws            # removes everything (asks for confirmation)
```

## 6. Explore

```bash
iacmp diagram             # C4 architecture diagram from your stacks
iacmp audit-all           # security, high-availability and DR audits
iacmp diff                # what would change on the next deploy
```

## Language

The CLI speaks English (default) and Portuguese:

```bash
IACMP_LANG=pt iacmp synth      # one-off
export IACMP_LANG=pt           # set it once in your shell profile
```

## Next step

Let an AI agent do the writing: [use iacmp with Claude Code](/guide/claude-code).
