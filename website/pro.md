# iacmp Pro <Badge type="tip" text="coming soon" />

The open CLI is complete and free — synth, deploy, destroy, diff, audits, diagrams on three clouds, forever. **iacmp Pro** is the paid layer being launched on top of it, built around one asset: a corpus of infrastructure patterns where **every entry was validated by a real deploy** — deployed, exercised at runtime, then destroyed — on real AWS, Azure and GCP accounts.

## What Pro unlocks

### 1. AI generation that deploys on the first try

```bash
iacmp ai "an order API: API Gateway, a CRUD Lambda and a DynamoDB table, plus a queue worker"
```

The generator retrieves from the deploy-validated corpus before writing a single line — so the stacks it produces carry the wiring that only real clouds teach: the SSL flag RDS requires, the visibility timeout SQS enforces, the index Cosmos demands for sorting, the IAM roles a brand-new GCP project is missing. Today the corpus holds **58 deploy-validated patterns** (and 97 labeled drafts), and it grows with every validation cycle.

### 2. Premium MCP: your agent consults validated patterns

Pro adds `search_examples` and `list_examples` to the embedded MCP server — before writing infrastructure, your coding agent looks up the pattern that is proven to deploy, with the hard-won rules attached to each example.

Tested end to end with **Claude Code** and **Claude Desktop**. Other MCP clients should work (it's an open protocol) but haven't been validated yet — we only claim what we've tested.

### 3. Shared learning (submit_example)

When your agent discovers a pattern the corpus doesn't cover, it can **propose** it. We validate the proposal with a real deploy — the same battery process used to build the corpus — and every subscriber inherits it. The corpus stays curated: proposals are reviewed and deploy-tested, never written directly.

## What stays free

Everything the CLI does today: `init`, `synth`, `deploy`, `destroy`, `diff`, `diagram`, `audit-all`, `doctor`, the cloud-agnostic runtime and the mechanical MCP tools (`write_stack`, `synth_project`, `deploy_project`…). The open CLI never depends on Pro — that's the deal, permanently.

## When and how much

Pricing and launch date will be announced here. To be notified:

- **Watch or star the repository**: https://github.com/Claudio-Fontes/iacmp
- Or reach out on [LinkedIn](https://www.linkedin.com/in/claudio-me1o) — early interest genuinely shapes what ships first.
