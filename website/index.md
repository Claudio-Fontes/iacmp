---
layout: home

hero:
  name: iacmp
  text: One codebase. Three clouds.
  tagline: Describe the infrastructure you need — get TypeScript constructs that synthesize to CloudFormation, Bicep and Terraform, with real deploy, diff, audits and diagrams in a single CLI.
  image:
    src: /logo.svg
    alt: iacmp
  actions:
    - theme: brand
      text: Get started in 5 minutes
      link: /guide/getting-started
    - theme: alt
      text: Use with Claude Code
      link: /guide/claude-code
    - theme: alt
      text: GitHub
      link: https://github.com/Claudio-Fontes/iacmp

features:
  - icon: ☁️
    title: One construct, three clouds
    details: Database.SQL becomes RDS on AWS, PostgreSQL Flexible Server on Azure and Cloud SQL on GCP — with the correct network, password and SSL wiring on each.
  - icon: ✅
    title: Validated by real deploys
    details: Every provider went through 20 end-to-end scenarios (deploy → runtime test → destroy) on real AWS, Azure and GCP accounts — not just synth.
  - icon: 🛡️
    title: Synth-time guards
    details: A dozen validations catch, in seconds, mistakes that would cost you a deploy — missing env vars, Lambda in a VPC without endpoints, SQL without SSL, undeclared GSIs.
  - icon: 🤖
    title: Claude Code out of the box
    details: iacmp setup registers an embedded MCP server — your agent writes stacks, synthesizes and deploys through structured tools, all local.
---

## 30 seconds of iacmp

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

```bash
iacmp synth --provider aws      # → CloudFormation
iacmp synth --provider azure    # → Bicep
iacmp synth --provider gcp      # → Terraform (tf.json)
iacmp deploy                    # deploys for real, to your account
```
