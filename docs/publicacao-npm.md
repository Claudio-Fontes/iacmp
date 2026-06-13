# Publicando o iacmp no npm

## Pré-requisitos

- Conta no npmjs.com
- `npm login` feito localmente

## Checklist antes de publicar

- [ ] Todos os testes passando: `npm test`
- [ ] Build limpo: `npm run build`
- [ ] Versão atualizada em `packages/cli/package.json`
- [ ] `docs/changelog.md` atualizado com as mudanças da versão

## Publicar

```bash
npm run build
cd packages/cli
npm publish --access public
```

## Testar após publicação

```bash
npm install -g iacmp
iacmp --version
iacmp doctor
```

## Publicar uma nova versão

1. Atualize `version` em `packages/cli/package.json` (e demais packages se necessário)
2. Atualize `docs/changelog.md`
3. Rode o build e os testes:
   ```bash
   npm run build
   npm test
   ```
4. Publique:
   ```bash
   cd packages/cli
   npm publish --access public
   ```

## Notas

- O campo `files` no `package.json` do CLI controla o que é incluído no pacote npm: `/bin`, `/dist`, `/oclif.manifest.json`
- Os packages internos (`@iacmp/core`, `@iacmp/provider-*` etc.) são bundlados como dependências — não é necessário publicá-los separadamente para o funcionamento do CLI
- Para publicar os packages internos (uso como biblioteca), siga o mesmo processo para cada um
