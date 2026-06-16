# Status do projeto

Este arquivo virou um snapshot historico da Fase 1. O estado atual do produto
(17 comandos, 4 providers, geracao via IA, RAG, auditorias e diagramas) vive
no [README.md](README.md) e no [docs/changelog.md](docs/changelog.md).

Para o que existe hoje e o que esta planejado, veja:

- [README.md](README.md) — visao geral, comandos, constructs, providers.
- [docs/changelog.md](docs/changelog.md) — historico de releases.
- [docs/manual-de-uso.md](docs/manual-de-uso.md) — manual completo.
- [docs/arquitetura.md](docs/arquitetura.md) — arquitetura interna.

## Snapshot historico — Fase 1

- Monorepo com Turborepo (npm workspaces).
- `@iacmp/core` com Stack + 5 constructs agnosticos
  (Compute, Storage, Network, Database, Function).
- `@iacmp/provider-aws` sintetizando CloudFormation.
- CLI `iacmp` com 6 comandos via oclif v4:
  init, synth, deploy, destroy, ls, doctor.

Como rodar localmente:

```bash
npm install
npm run build
node packages/cli/bin/run.js --help
```
