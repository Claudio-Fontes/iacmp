# Publicando o iacmp no npm

## Modelo de distribuição

O `iacmp` é distribuído como **cinco pacotes públicos**:

| Pacote | Repo | Papel |
|---|---|---|
| `@iacmp/core` | monorepo | SDK público que os stacks do usuário importam (`import { Stack } from '@iacmp/core'`) |
| `@iacmp/runtime` | monorepo | facade neutro (`table`/`blob`) que os handlers do usuário importam; o adaptador por cloud é resolvido no deploy |
| `@iacmp/knowledge` | monorepo | corpus (126 exemplos) + retrieval (FTS5/BM25) + seed (`ensureSeeded`) — a fonte única da knowledge base |
| `iacmp` (CLI) | monorepo | binário `npm i -g iacmp`; **bundla** `@iacmp/ai`, `@iacmp/provider-*`, `@iacmp/dashboard`, `@iacmp/registry`, `@iacmp/plugin-sdk` **e `@iacmp/knowledge`** (via tsup); depende de `@iacmp/core`, `@iacmp/runtime` e `better-sqlite3` |
| `@iacmp/mcp` | `~/Projetos/iacmp-mcp` | servidor MCP para LLMs; instalação opcional `npm i -g @iacmp/mcp`; depende de `@iacmp/knowledge` |

Por que `@iacmp/core` e `@iacmp/runtime` **não** são bundlados: o `iacmp init` os referencia (`"@iacmp/core": "^x.y.z"`) e os stacks/handlers `.ts` do usuário importam deles — então precisam existir on-disk como módulos resolvíveis (o runtime inclusive via `require.resolve` no deploy, para achar o adaptador de cada cloud).

Por que `@iacmp/knowledge` é **os dois**: ele é INLINADO no bundle da CLI (o corpus viaja embutido — é o que faz a knowledge base chegar a quem só instala a CLI, sem rodar o MCP), **e** publicado como pacote, porque o `@iacmp/mcp` (repo separado) o consome como dependência externa. `better-sqlite3` é binário nativo, não inlina — por isso entra nas deps declaradas da CLI.

O `@iacmp/mcp` está em repositório separado (`~/Projetos/iacmp-mcp`), tem versionamento próprio (começa em `0.1.0`) e depende de `@iacmp/knowledge` (não de `@iacmp/core`).

> **Ordem importa:** publique `@iacmp/core`, `@iacmp/runtime` e `@iacmp/knowledge` **antes** de `iacmp`; e todos antes de `@iacmp/mcp` (que precisa do `@iacmp/knowledge` publicado para instalar limpo).

## Pré-requisitos

- Conta no npmjs.com com acesso ao escopo `@iacmp`
- `npm login` feito localmente

## Checklist antes de publicar

- [ ] Todos os testes passando: `npm test`
- [ ] Build limpo: `npm run build`
- [ ] Versões sincronizadas entre `@iacmp/core` e `iacmp`
- [ ] `docs/changelog.md` atualizado

## Publicar

```bash
npm run build

# 1) SDK público (stacks importam)
cd packages/core
npm publish            # publishConfig.access:public já está no package.json

# 2) Facade de runtime (handlers importam)
cd ../runtime
npm publish --access public

# 3) Knowledge base (corpus + retrieval + seed) — precisa vir antes da CLI e do MCP
cd ../knowledge
npm publish --access public

# 4) CLI (o prepack roda tsup + oclif manifest; inlina @iacmp/knowledge)
cd ../cli
npm publish --access public

# 5) Por último o MCP (repo separado) — resolve @iacmp/knowledge publicado
cd ~/Projetos/iacmp-mcp
npm run build
npm publish --access public
```

## Status atual (verificado 2026-07-23)

| Pacote | Versão publicada |
|---|---|
| `@iacmp/core` | 2.2.2 |
| `iacmp` | 2.2.2 (desatualizada — sem os fixes recentes) |
| `@iacmp/mcp` | 0.1.0 (desatualizada) |
| `@iacmp/runtime` | **não publicado** (E404) — bloqueia a próxima release da CLI |
| `@iacmp/knowledge` | **não publicado** (E404) — bloqueia instalação limpa do `@iacmp/mcp` |

> A CLI já funciona localmente (dev-sync/symlink resolve tudo) e, uma vez publicada, resolve `@iacmp/knowledge` pelo bundle. O que ainda quebra sem publicar é `npm i -g @iacmp/mcp` (depende do `@iacmp/knowledge` no registro).

## Testar após a publicação

```bash
npm install -g iacmp
iacmp --version
iacmp doctor
iacmp init demo && cd demo && iacmp synth

# MCP (opcional)
npm install -g @iacmp/mcp
iacmp-mcp --version
```

## Publicar uma nova versão

1. Bump de `version` nos pacotes tocados: `packages/core`, `packages/runtime`, `packages/knowledge`, `packages/cli` (mantenha os ranges `@iacmp/*` do CLI compatíveis)
2. Se houver mudanças no MCP, bump de `version` em `~/Projetos/iacmp-mcp/package.json` também (e o range `@iacmp/knowledge` que ele consome)
3. Atualize `docs/changelog.md`
4. `npm run build && npm test`
5. Republique na ordem: core → runtime → knowledge → CLI → MCP

## Notas

- O `files` do CLI controla o que vai no pacote: `/bin/run.js`, `/dist`, `/oclif.manifest.json`. O `dist/` já contém todos os packages internos inlinados.
- `oclif.manifest.json` é gerado pelo `prepack` (`oclif manifest`) — não é versionado.
- Para publicar os outros packages internos como bibliotecas independentes (opcional), siga o mesmo processo para cada um.
