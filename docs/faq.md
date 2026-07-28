# FAQ — Perguntas Frequentes

---

**Preciso compilar o TypeScript antes de rodar `iacmp synth`?**

Não, desde que `tsx` esteja disponível no projeto. O `iacmp init` o adiciona
como devDependency e o `iacmp synth` o registra automaticamente para executar
`.ts` direto (procurando inclusive em diretórios pai, útil em monorepos). Se
nenhum `tsx` for encontrado, o synth avisa e ignora as stacks `.ts`; nesse caso
rode `npm i -D tsx` no projeto. Stacks `.js` (já compiladas) são sempre
suportadas.

---

**Posso usar o iacmp sem API key de IA?**

Sim — o CLI inteiro (`init`, `synth`, `deploy`, `destroy`, `diff`, `diagram`,
`audit-all`, `doctor`, `dashboard`, `registry`, `watch`) funciona sem nenhuma
chave. API keys (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) só entram na geração via
IA (`iacmp ai`, `from-diagram`), que faz parte do **iacmp Pro**.

---

**O que é o iacmp Pro?**

A geração via IA com um corpus de exemplos em que cada padrão foi validado em
deploy real nas três nuvens. O CLI aberto funciona 100% sem ele — os comandos
Pro (`iacmp ai`, `from-diagram` e a busca de exemplos no MCP) apenas indicam a
ausência com uma mensagem clara.

---

**O iacmp funciona com o Claude Code?**

Sim, de fábrica. `iacmp setup` registra o servidor MCP embutido no Claude Code
e no Claude Desktop — o agente ganha as ferramentas `write_stack`,
`synth_project`, `deploy_project`, `destroy_project`, `validate_stack` e
`read_synth_output` (todas locais, sem IA). Com o iacmp Pro, o MCP soma
`search_examples`/`list_examples` (busca no corpus validado). Sem MCP, o
CLAUDE.md gerado pelo `iacmp init` orienta o agente a usar o CLI direto.

---

**O iacmp faz deploy real?**

Sim. O `iacmp deploy` chama a ferramenta nativa do provider por trás —
`aws cloudformation package`+`deploy` (AWS), `az stack group create` (Azure),
`terraform apply` (GCP e `--format tf`). O empacotamento do código das funções
(`Fn.Lambda`) é feito no deploy para as três nuvens: esbuild do handler com a
facade `@iacmp/runtime` resolvida para o adaptador da cloud alvo. Pré-requisito:
a CLI nativa instalada e autenticada (`iacmp doctor` checa; `--fix` instala) e
synth feito antes. Use `--dry-run` para ver os comandos exatos sem executar.

---

**Onde ficam os templates gerados?**

Em `synth-out/<provider>/` na raiz do projeto:
- AWS: `synth-out/aws/<stack>.json` (CloudFormation)
- Azure: `synth-out/azure/<stack>.bicep` + `_main.bicep` (deployment único)
- GCP: `synth-out/gcp/<stack>.tf.json` + `_providers.tf.json` (Terraform)
- `--format tf`: `synth-out/aws-tf/` e `synth-out/azure-tf/`

A subpasta por provider evita que um output sobrescreva o outro.

---

**Como faço para mudar o provider de um projeto?**

Edite o campo `provider` no `iacmp.json`:
```json
{ "provider": "azure" }
```

Ou use a flag `--provider` por comando:
```bash
iacmp synth --provider gcp
iacmp deploy --provider azure
```

A flag sobrescreve o valor do `iacmp.json` para aquela execução. Para gerar
Terraform de AWS/Azure, use `--format tf` (Terraform é um formato de saída, não
um provider isolado).

---

**Posso ter múltiplas stacks no mesmo projeto?**

Sim — e é a convenção: uma stack por domínio (rede, dados, compute…), ligadas
por `ref()` cross-stack. O `iacmp synth` processa todas e resolve as
referências; o `deploy` ordena por dependência.

```
stacks/
├── network/api-stack.ts
├── compute/fn-stack.ts
└── database/db-stack.ts
```

---

**Como crio um provider customizado?**

Use o `@iacmp/plugin-sdk`:

```javascript
const { definePlugin } = require('@iacmp/plugin-sdk');

module.exports = definePlugin({
  providers: [{
    name: 'meu-provider',
    synthesize(stack) {
      return { /* template nativo */ };
    },
  }],
});
```

Publique no npm e adicione ao `iacmp.json`:
```json
{ "plugins": ["meu-pacote-plugin"] }
```

---

**Como atualizo o iacmp?**

```bash
npm update -g iacmp
iacmp --version
```

---

**O `iacmp watch` funciona com qualquer provider?**

Sim. Ao detectar mudanças em `stacks/`, o watch roda `iacmp synth` com o
provider do `iacmp.json`. Use `--provider` para sobrescrever:
```bash
iacmp watch --provider azure
```
