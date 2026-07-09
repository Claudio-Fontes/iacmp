# Publicando o iacmp no npm

## Modelo de distribuição

O `iacmp` é distribuído como **três pacotes públicos**:

| Pacote | Repo | Papel |
|---|---|---|
| `@iacmp/core` | monorepo | SDK público que os stacks do usuário importam (`import { Stack } from '@iacmp/core'`) |
| `iacmp` (CLI) | monorepo | binário `npm i -g iacmp`; **bundla** `@iacmp/ai`, `@iacmp/provider-*`, `@iacmp/dashboard`, `@iacmp/registry` e `@iacmp/plugin-sdk` (via tsup); depende de `@iacmp/core` |
| `@iacmp/mcp` | `~/Projetos/iacmp-mcp` | servidor MCP para LLMs; instalação opcional `npm i -g @iacmp/mcp` |

Por que `@iacmp/core` **não** é bundlado: o `iacmp init` referencia o pacote (`"@iacmp/core": "^x.y.z"`) e os stacks `.ts` do usuário importam dele — então core precisa existir on-disk como módulo resolvível. Os demais packages internos ao CLI são inlinados no bundle.

O `@iacmp/mcp` está em repositório separado (`~/Projetos/iacmp-mcp`), tem versionamento próprio (começa em `0.1.0`) e **não** depende de `@iacmp/core`.

> **Ordem importa:** publique `@iacmp/core` antes de `iacmp`, e ambos antes de `@iacmp/mcp` (mesmo sem dependência técnica, o MCP é o último por ser opcional e independente).

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

# 1) Primeiro o SDK público
cd packages/core
npm publish            # publishConfig.access:public já está no package.json

# 2) Depois o CLI (o prepack roda tsup + oclif manifest)
cd ../cli
npm publish --access public

# 3) Por último o MCP (repo separado)
cd ~/Projetos/iacmp-mcp
npm run build
npm publish --access public
```

## Status atual (verificado 2026-07-09)

| Pacote | Versão publicada |
|---|---|
| `@iacmp/core` | 2.2.2 |
| `iacmp` | 2.2.2 |
| `@iacmp/mcp` | 0.1.0 |

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

1. Bump de `version` em `packages/core/package.json` e `packages/cli/package.json` (mantenha o range `@iacmp/core` do CLI compatível)
2. Se houver mudanças no MCP, bump de `version` em `~/Projetos/iacmp-mcp/package.json` também
3. Atualize `docs/changelog.md`
4. `npm run build && npm test`
5. Republique na ordem: core → CLI → MCP

## Notas

- O `files` do CLI controla o que vai no pacote: `/bin/run.js`, `/dist`, `/oclif.manifest.json`. O `dist/` já contém todos os packages internos inlinados.
- `oclif.manifest.json` é gerado pelo `prepack` (`oclif manifest`) — não é versionado.
- Para publicar os outros packages internos como bibliotecas independentes (opcional), siga o mesmo processo para cada um.
