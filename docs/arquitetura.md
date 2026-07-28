# Arquitetura Interna do iacmp

---

## Estrutura do Monorepo

```
iacmp/
├── packages/
│   ├── cli/                  # Entry point do CLI (oclif v4)
│   │   ├── bin/run.js        # Binário executável
│   │   └── src/
│   │       ├── commands/     # Um arquivo por comando (synth, deploy, init, …)
│   │       ├── synth/        # Orquestração do synth por provider (aws, azure, gcp, aws-tf, azure-tf)
│   │       ├── deploy/       # Executors por provider + fluxos (flows/) de deploy/destroy
│   │       ├── validators/   # Guards de synth-time (handler↔stack, VPC, SQL, env vars…)
│   │       ├── pro/          # Fronteira do iacmp Pro (contrato + loader dinâmico)
│   │       └── init/         # Templates e scaffold do `iacmp init`
│   ├── core/                 # Constructs agnósticos (Stack, Fn, Database, Network, …)
│   ├── providers/
│   │   ├── aws/              # Synth CloudFormation (+ emissor Terraform p/ --format tf)
│   │   ├── azure/            # Synth Bicep (+ synth Terraform azurerm p/ --format tf)
│   │   ├── gcp/              # Synth Terraform (tf.json) — formato nativo do provider
│   │   └── terraform/        # Pipeline CFN→tf.json usado pelo `aws --format tf`
│   ├── runtime/              # Facade agnóstica p/ handlers: table(), blob(), queue(), sql(), secret()
│   ├── plugin-sdk/           # SDK para providers customizados
│   ├── dashboard/            # Servidor HTTP + UI para visualização de stacks
│   └── registry/             # Catálogo de constructs e exemplos
└── docs/
```

### Dependências entre packages

```
cli ─┬─ @iacmp/core        (dependência publicada — stacks do usuário importam)
     ├─ @iacmp/runtime     (dependência publicada — handlers do usuário importam)
     ├─ providers aws/azure/gcp/terraform  (inlinados no bundle do CLI)
     ├─ plugin-sdk, dashboard, registry    (inlinados no bundle do CLI)
     └─ @iacmp/ai + @iacmp/knowledge       (iacmp Pro — carga DINÂMICA, ver abaixo)

Cada provider depende só de @iacmp/core — nunca de outro provider.
Travas executáveis (isolation.test.ts) falham o CI se um provider importar de outro.
```

### A fronteira do iacmp Pro

A geração via IA (`iacmp ai`, `from-diagram`) e o corpus de exemplos validados
(`@iacmp/ai`, `@iacmp/knowledge`) são proprietários e vivem fora deste repo.
O CLI aberto nunca os importa estaticamente:

- `packages/cli/src/pro/types.ts` — contrato estrutural (a superfície que o CLI consome);
- `packages/cli/src/pro/index.ts` — loader (`loadAi()`/`loadKnowledge()`): tenta
  `require` normal e `IACMP_PRO_PATH`; ausente → `null` e o comando degrada com
  mensagem clara. O restante do CLI não depende de nada disso.

---

## Fluxo de `iacmp synth`

```
1. CLI lê iacmp.json → provider, região, nome do projeto
2. Carrega TODAS as stacks de stacks/**/*.ts (tsx registrado on-the-fly)
   — visão do projeto inteiro é necessária p/ resolver ref() cross-stack
3. Guards de synth-time (packages/cli/src/validators):
   monólito de domínios, handler sem arquivo, SDK da cloud errada, SQL inválido,
   Lambda-em-VPC sem endpoint, env var não declarada, GSI ausente, etc.
   Erro aqui evita um deploy que só falharia em runtime.
4. Despacha para o módulo do provider (packages/cli/src/synth/<provider>.ts):
   - aws       → CloudFormation JSON            → synth-out/aws/<stack>.json
   - azure     → Bicep (uma stack = um módulo)  → synth-out/azure/<stack>.bicep
                 + _main.bicep (deployment único: ARM resolve ordem/refs)
   - gcp       → Terraform tf.json por stack    → synth-out/gcp/<stack>.tf.json
                 + _providers.tf.json (blocos terraform/provider/variable ÚNICOS
                 do diretório — todos os tf.json formam um root module só)
   - aws  --format tf → pipeline CFN→tf.json    → synth-out/aws-tf/
   - azure --format tf → synth azurerm          → synth-out/azure-tf/
5. Validação nativa pós-synth (best-effort, pula sem CLI/credenciais):
   aws cloudformation validate-template · az bicep build + deployment validate
```

### Como os constructs são mapeados

Cada construct de `@iacmp/core` tem um `type` (ex.: `Fn.Lambda`, `Database.SQL`).
O synth de cada provider vive em `src/synth/constructs/<domínio>.ts` (function,
database, network, messaging, …) e traduz o construct para o(s) recurso(s)
nativos — incluindo as amarrações que não são 1:1 (plano Consumption
compartilhado no Azure, private service access no Cloud SQL, OAC no CloudFront).
A tabela completa AWS ↔ Azure ↔ GCP está em [constructs.md](constructs.md).

### Referências cross-stack (`ref()`)

`ref('MinhaTabela', 'Name')` resolve para o mecanismo certo de cada formato:
Export/ImportValue no CloudFormation, referência simbólica de módulo no
`_main.bicep`, referência direta de recurso (`${google_...}` / `${azurerm_...}`)
no Terraform (diretório = state único).

---

## Fluxo de `iacmp deploy`

```
1. Confere synth-out do provider (ordena stacks por dependência)
2. Executor por provider (packages/cli/src/deploy/):
   - aws    → aws cloudformation package + deploy (por stack; região DR por marker)
   - azure  → az stack group create no _main.bicep (deployment stack única)
              + build/zip dos handlers (esbuild) + config-zip nas Function Apps
   - gcp    → pré-flight (APIs + roles da compute SA) + build/upload dos handlers
              + terraform init/apply no diretório inteiro
   - --format tf → terraform init/apply (aws-tf/azure-tf, state único)
3. Confirmações para ações destrutivas; --dry-run mostra os comandos sem executar
```

Os handlers são empacotados no deploy com a facade `@iacmp/runtime` resolvida
para o adaptador da cloud alvo (esbuild alias) — o mesmo `table()`/`blob()` do
código do usuário vira DynamoDB/Cosmos/Firestore conforme o provider.

---

## Servidor MCP embutido

O CLI embute um servidor MCP (`dist/mcp-server.js`, registrado por `iacmp setup`)
que expõe ferramentas para agentes (Claude Code/Desktop):

- **Sempre disponíveis** (mecânicas): `validate_stack`, `write_stack`,
  `synth_project`, `deploy_project`, `destroy_project`, `from_diagram`,
  `read_synth_output`.
- **Com o iacmp Pro**: `search_examples` e `list_examples` (busca no corpus de
  exemplos validados em deploy real). Sem o Pro, o servidor sobe normalmente e
  essas duas ferramentas não são listadas.

---

## Como o Plugin System funciona

O plugin system permite adicionar providers customizados sem alterar o core.

**Carregamento** (`@iacmp/plugin-sdk/loader.ts`):
1. Lê campo `plugins` do `iacmp.json`
2. Para cada plugin, executa `require(pluginName)`
3. Espera que o módulo exporte um objeto `{ providers: [...] }`
4. Registra cada provider pelo campo `name`

**Interface de um plugin:**
```javascript
const { definePlugin } = require('@iacmp/plugin-sdk');

module.exports = definePlugin({
  providers: [{
    name: 'meu-provider',
    synthesize(stack) {
      return { /* template nativo em qualquer formato */ };
    },
  }],
});
```

**Uso no synth:**
Se o provider não for um dos nativos (aws/azure/gcp), o `iacmp synth` busca em
plugins carregados via `loadPlugins()`.

---

## Como adicionar um novo provider nativo

1. Crie `packages/providers/<nome>/` com a estrutura padrão:
   ```
   src/
   ├── index.ts       # export { NomeProvider }
   ├── provider.ts    # class NomeProvider { synthesize(stack: Stack) }
   └── synth/
       └── constructs/  # um arquivo por domínio (function, database, network, …)
   package.json
   tsconfig.json
   ```

2. Implemente o synth por domínio seguindo o padrão dos providers existentes
   (assinatura `synth<Dominio>(construct, ctx): boolean`, dispatcher encadeado).
   Dependa SÓ de `@iacmp/core` — as travas de isolamento falham o CI se o novo
   provider importar de outro provider.

3. Adicione ao `packages/cli/package.json` (devDependency — é inlinado no bundle)
   e crie `packages/cli/src/synth/<nome>.ts` com a orquestração de saída.

4. Adicione goldens (`test/golden*`) e, se o formato for Terraform, valide com
   `terraform validate` no CI.
