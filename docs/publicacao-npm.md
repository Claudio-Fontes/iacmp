# Publicando o iacmp no npm

## Modelo de distribuição

O `iacmp` é distribuído como **dois pacotes públicos**:

| Pacote | Papel | Conteúdo |
|---|---|---|
| `@iacmp/core` | SDK público que os stacks do usuário importam (`import { Stack } from '@iacmp/core'`) | publicado normalmente |
| `iacmp` (CLI) | binário `npm i -g iacmp` | **bundla** `@iacmp/ai`, `@iacmp/provider-*`, `@iacmp/dashboard`, `@iacmp/registry` e `@iacmp/plugin-sdk` (via tsup); depende de `@iacmp/core` |

Por que `@iacmp/core` **não** é bundlado: o `iacmp init` referencia o pacote (`"@iacmp/core": "^x.y.z"`) e os stacks `.ts` do usuário importam dele — então core precisa existir on-disk como módulo resolvível. Os demais packages são internos do CLI e são inlinados no bundle.

> **Ordem importa:** publique `@iacmp/core` **antes** do `iacmp`. O CLI declara `@iacmp/core` como dependência de registry; se core não estiver publicado, `npm i -g iacmp` falha.

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
```

## Status atual (verificado)

- `npm view iacmp` e `npm view @iacmp/core` retornam 404 — nenhum dos dois nomes foi publicado ainda; ambos estão livres no registry.
- `npm pack --dry-run` em `packages/core` e `packages/cli` confirma que os tarballs já saem corretos (LICENSE, dist/, registry.json, oclif.manifest.json presentes; nenhum caminho absoluto vazado).
- Sintoma real de não estar publicado: projetos gerados por `iacmp init` (ex: `nv-vs-iac4`) falham no `npm install` com `404 Not Found - @iacmp/core` e, em consequência, comandos como `iacmp diagram`/`iacmp synth` falham com `Cannot find package '@iacmp/core'` por falta de `node_modules`. Contorno local sem publicar: `npm link` em `packages/core` e depois `npm link @iacmp/core` no projeto do usuário — resolve só na máquina onde o monorepo existe, não substitui o publish real.

## Testar após a publicação

```bash
npm install -g iacmp
iacmp --version
iacmp doctor
iacmp init demo && cd demo && iacmp synth
```

## Publicar uma nova versão

1. Bump de `version` em `packages/core/package.json` e `packages/cli/package.json` (mantenha o range `@iacmp/core` do CLI compatível)
2. Atualize `docs/changelog.md`
3. `npm run build && npm test`
4. Republique core e depois o CLI (mesma ordem acima)

## Notas

- O `files` do CLI controla o que vai no pacote: `/bin/run.js`, `/dist`, `/oclif.manifest.json`. O `dist/` já contém todos os packages internos inlinados.
- `oclif.manifest.json` é gerado pelo `prepack` (`oclif manifest`) — não é versionado.
- Para publicar os outros packages internos como bibliotecas independentes (opcional), siga o mesmo processo para cada um.
