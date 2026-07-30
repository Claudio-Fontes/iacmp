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

3. The agent writes the stacks, runs `synth_project`, reads any validation errors and fixes them until green. You review the generated TypeScript.

4. When (and only when) you are happy with the result, deploy it yourself:

```bash
iacmp deploy --dry-run    # shows the full plan without touching your cloud
iacmp deploy              # real deploy (asks for confirmation)
```

5. Done experimenting? Remove everything:

```bash
iacmp destroy             # removes all deployed resources (asks for confirmation)
```

## No MCP? Still works

`iacmp init` generates a `CLAUDE.md` in the project that guides any agent through the right flow (write stack → `iacmp synth` until green → ask before deploy). Even without MCP tools, agents that read the file follow the same path via the terminal.

## Tips

- Keep one stack per domain (`stacks/network/`, `stacks/database/`, `stacks/compute/`) — the agent follows the existing structure.
- After the agent generates the stacks, audit them — security, high availability and disaster recovery, in seconds:

```bash
iacmp audit-all
```

- Want to see the architecture the agent built? Generate a C4 diagram:

```bash
iacmp diagram
```
