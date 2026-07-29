# Using iacmp with Claude Code

iacmp embeds an MCP server. One command registers it in Claude Code and Claude Desktop:

```bash
iacmp setup
```

That's it. Restart Claude Code and the agent gains structured tools to operate iacmp — all local, no API keys, no embedded AI:

| Tool | What the agent does with it |
|---|---|
| `write_stack` | Writes/updates stack files with validated construct code |
| `synth_project` | Runs synth and reads back errors to self-correct |
| `deploy_project` / `destroy_project` | Real deploy/destroy with confirmations |
| `validate_stack` | Semantic validation of a stack before synth |
| `read_synth_output` | Inspects the generated CloudFormation/Bicep/Terraform |

## The flow in practice

1. Create and enter a project:

```bash
iacmp init my-api --template blank
cd my-api
```

2. Open Claude Code **in the project folder** and describe what you need:

> Create an API for managing customers: API Gateway, a Lambda for CRUD and a DynamoDB table. Then synth and show me the result.

3. The agent writes the stacks, runs `synth_project`, reads any validation errors and fixes them until green. You review the generated TypeScript — and only you decide when to `deploy`.

## No MCP? Still works

`iacmp init` generates a `CLAUDE.md` in the project that guides any agent through the right flow (write stack → `iacmp synth` until green → ask before deploy). Even without MCP tools, agents that read the file follow the same path via the terminal.

## Tips

- Keep one stack per domain (`stacks/network/`, `stacks/database/`, `stacks/compute/`) — the agent follows the existing structure.
- Ask for `iacmp audit-all` after generation: security, HA and DR audits in seconds.
- `iacmp diagram` gives you a C4 diagram to check the architecture the agent built.
