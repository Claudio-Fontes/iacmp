# Arquitetura Interna do iacmp

---

## Estrutura do Monorepo

```
iacmp/
├── packages/
│   ├── cli/                  # Entry point do CLI (oclif v4)
│   │   ├── bin/run.js        # Binário executável
│   │   └── src/commands/     # Um arquivo por comando (synth, init, ai, etc.)
│   ├── core/                 # Abstrações agnósticas de recursos
│   │   └── src/
│   │       ├── stack.ts      # Classe Stack + interface BaseConstruct
│   │       └── constructs/   # Compute, Storage, Network, Database, Fn
│   ├── ai/                   # Módulo de geração de stacks via IA
│   │   └── src/
│   │       ├── providers/    # AnthropicProvider, CopilotProvider
│   │       ├── prompts/      # System prompt e templates
│   │       ├── parser/       # Extração de código e validação TypeScript
│   │       ├── chat/         # Sessão de chat e renderização no terminal
│   │       └── tools/        # file-writer, diff-renderer, synth-runner, context-reader
│   ├── providers/
│   │   ├── aws/              # CloudFormation JSON
│   │   ├── azure/            # ARM Template JSON
│   │   ├── gcp/              # GCP Deployment Manager JSON
│   │   └── terraform/        # HCL (.tf)
│   ├── plugin-sdk/           # SDK para providers customizados
│   ├── dashboard/            # Servidor HTTP + UI para visualização de stacks
│   └── registry/             # Cliente do registry de constructs
├── examples/
│   ├── webapp/
│   ├── database/
│   └── network/
└── docs/
```

### Dependências entre packages

```
cli ──────────────────────────────────────────────────┐
  ├── @iacmp/core                                      │
  ├── @iacmp/ai ──── @iacmp/core                       │
  ├── @iacmp/provider-aws ──── @iacmp/core             │
  ├── @iacmp/provider-azure ── @iacmp/core             │
  ├── @iacmp/provider-gcp ──── @iacmp/core             │
  ├── @iacmp/provider-terraform ── @iacmp/core         │
  ├── @iacmp/plugin-sdk ──── @iacmp/core               │
  ├── @iacmp/dashboard                                  │
  └── @iacmp/registry                                   │
                                                        │
  Os providers recebem Stack (de @iacmp/core) e        │
  retornam templates nativos (JSON, HCL)               │
```

---

## Fluxo de `iacmp synth`

```
1. CLI lê iacmp.json → determina provider e região
2. CLI escaneia stacks/ buscando arquivos .ts
3. Para cada arquivo:
   a. Importa via require() (já compilado) ou ts-node (dev mode)
   b. Obtém a instância de Stack exportada como default
4. Instancia o provider correspondente:
   - aws        → AWSProvider      (@iacmp/provider-aws)
   - azure      → AzureProvider    (@iacmp/provider-azure)
   - gcp        → GCPProvider      (@iacmp/provider-gcp)
   - terraform  → TerraformProvider (@iacmp/provider-terraform)
   - custom     → loadPlugins() busca em plugins do iacmp.json
5. provider.synthesize(stack) → template nativo
6. Serializa para JSON (AWS/Azure/GCP) ou string (Terraform HCL)
7. Escreve em synth-out/<stack-name>.<extensão>
8. Imprime resumo: N constructs → arquivo gerado
```

### Como os constructs são mapeados

Cada construct em `@iacmp/core` é identificado pelo campo `type` (string). O provider faz um `switch` sobre esse tipo e retorna o recurso nativo equivalente.

Exemplo AWS:
```
Compute.Instance { instanceType: 'small' }
  → AWS::EC2::Instance { InstanceType: 't3.small' }

Storage.Bucket { versioning: true }
  → AWS::S3::Bucket { VersioningConfiguration: { Status: 'Enabled' } }
```

---

## Fluxo de `iacmp ai`

```
1. CLI recebe o prompt do usuário (ou entra em modo --chat)
2. context-reader lê:
   - iacmp.json (provider, região, nome do projeto)
   - stacks/*.ts existentes (para contexto de modificação)
3. ChatSession monta o array de mensagens:
   [ { role: 'user', content: system-prompt + contexto + prompt } ]
4. AIProvider.stream() envia para Claude ou Copilot em streaming
   - Cada chunk é renderizado no terminal em tempo real
5. code-extractor extrai o JSON do response:
   { explanation, files: [{ path, content }], nextSteps, warnings }
6. validator.ts valida o TypeScript gerado (tsc --noEmit em /tmp)
   - Se inválido: retry automático com erro como contexto (1x)
7. diff-renderer exibe antes/depois colorido no terminal
8. Aguarda aprovação do usuário: [y] aplicar / [n] cancelar
9. file-writer escreve os arquivos aprovados em disco
10. Pergunta: "Quer rodar iacmp synth agora?"
```

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
Se o provider não for um dos quatro nativos (aws/azure/gcp/terraform), o `iacmp synth` busca em plugins carregados via `loadPlugins()`.

---

## Como adicionar um novo provider nativo

1. Crie `packages/providers/<nome>/` com a estrutura padrão:
   ```
   src/
   ├── index.ts       # export { NomeProvider }
   ├── provider.ts    # class NomeProvider { synthesize(stack: Stack) }
   └── synth/
       └── <formato>.ts  # lógica de síntese
   package.json
   tsconfig.json
   ```

2. Implemente `synthesize(stack: Stack)` iterando sobre `stack.constructs` e fazendo switch em `construct.type`.

3. Adicione ao `packages/cli/package.json` como dependência.

4. No comando `synth` do CLI, adicione o case para o novo provider.

5. Adicione ao `turbo.json` se necessário (já herdado pela estrutura de workspace).
