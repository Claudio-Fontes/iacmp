# FAQ — Perguntas Frequentes

---

**Preciso compilar o TypeScript antes de rodar `iacmp synth`?**

Não, desde que `ts-node` esteja disponível no projeto. O `iacmp init` adiciona
`ts-node` como devDependency e o `iacmp synth` o registra automaticamente para
executar `.ts` direto (procurando inclusive em diretórios pai, útil em monorepos
e nos `examples/`). Se nenhum `ts-node` for encontrado, o synth emite um aviso e
ignora as stacks `.ts`; nesse caso compile com `tsc` ou rode `npm i -D ts-node`
no projeto. As stacks `.js` (já compiladas) são sempre suportadas, sem ts-node.

---

**Posso usar o iacmp sem `ANTHROPIC_API_KEY`?**

Sim. A variável `ANTHROPIC_API_KEY` só é necessária para o comando `iacmp ai`. Todos os outros comandos (`synth`, `init`, `deploy`, `ls`, `doctor`, `watch`, `dashboard`, `registry`) funcionam normalmente sem ela. Alternativamente, você pode usar `GITHUB_TOKEN` com acesso ao GitHub Copilot.

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

Veja o exemplo completo em `examples/plugin-exemplo/`.

---

**O iacmp faz deploy real na AWS?**

No MVP atual, o `iacmp deploy` é simulado — imprime os passos que seriam executados mas não faz chamadas reais à AWS. O `iacmp synth` gera CloudFormation templates válidos que podem ser aplicados manualmente com `aws cloudformation deploy`. Deploy automatizado é planejado para uma versão futura.

---

**Onde ficam os templates gerados?**

Em `synth-out/<provider>/` na raiz do projeto. Cada stack gera um arquivo com o
nome da stack e a extensão correspondente ao provider:
- AWS: `synth-out/aws/minha-stack.json` (CloudFormation)
- Azure: `synth-out/azure/minha-stack.json` (ARM Template)
- GCP: `synth-out/gcp/minha-stack.json` (Deployment Manager)
- Terraform: `synth-out/terraform/minha-stack.tf` (HCL)

A subpasta por provider evita que o output de um provider sobrescreva o de
outro quando você sintetiza a mesma stack para múltiplos providers.

---

**Como faço para mudar o provider de um projeto?**

Edite o campo `provider` no `iacmp.json`:
```json
{ "provider": "azure" }
```

Ou use a flag `--provider` por comando:
```bash
iacmp synth --provider terraform
iacmp deploy --provider gcp
```

A flag sobrescreve o valor do `iacmp.json` para aquela execução.

---

**Posso ter múltiplas stacks no mesmo projeto?**

Sim. Crie um arquivo `.ts` por stack dentro de `stacks/`. O `iacmp synth` processa todos automaticamente e gera um template por stack em `synth-out/`. O `iacmp ls` lista todas as stacks do projeto.

```
stacks/
├── api-stack.ts
├── database-stack.ts
└── network-stack.ts
```

---

**A IA pode gerar stacks para qualquer provider?**

Sim. Passe a flag `--provider` para o comando `iacmp ai`:
```bash
iacmp ai "cria uma VPC com subnets" --provider terraform
iacmp ai "cria um banco postgres" --provider azure
```

Sem a flag, o provider é lido do `iacmp.json`.

---

**Como atualizo o iacmp?**

```bash
npm update -g iacmp
iacmp --version
```

---

**O `iacmp watch` funciona com qualquer provider?**

Sim. Ao detectar mudanças em `stacks/`, o watch roda `iacmp synth` com o provider configurado no `iacmp.json`. Use `--provider` para sobrescrever:
```bash
iacmp watch --provider azure
```
