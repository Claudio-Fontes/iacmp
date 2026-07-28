<p align="center"><img src="https://raw.githubusercontent.com/Claudio-Fontes/iacmp/main/docs/assets/logo.svg" width="90" alt="iacmp"></p>

# iacmp

**One TypeScript codebase → CloudFormation (AWS), Bicep (Azure) and Terraform (GCP).**
Synth, deploy, destroy, diff, audits and C4 diagrams in a single CLI — every provider
validated by a battery of 20 end-to-end scenarios with real deploys.

> 🇧🇷 Ferramenta com documentação completa em português — veja o repositório.

```bash
npm install -g iacmp

iacmp init my-project --template serverless
cd my-project
iacmp synth          # native templates + validations
iacmp deploy         # real deploy (with confirmations)
iacmp setup          # register the MCP tools in Claude Code / Desktop
```

- **Docs & source:** https://github.com/Claudio-Fontes/iacmp
- **Requirements:** Node.js 20+ · the target cloud CLI (`aws`/`az`/`gcloud`) · `terraform` for the tf paths
- **License:** Apache-2.0

AI generation (`iacmp ai`) with a deploy-validated example corpus is part of **iacmp Pro**;
the open CLI is fully functional without it.
