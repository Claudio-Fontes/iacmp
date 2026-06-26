# Estudo de Abstração do Core — iacmp

> Análise da arquitetura atual e sugestões de melhoria, motivada pelo padrão recorrente de **erros que só aparecem no deploy** e pela proliferação de **regras fixas** espalhadas entre o system prompt da IA e os synthesizers.

## 1. Diagnóstico: onde mora o conhecimento hoje

O conhecimento sobre "como uma intenção vira infraestrutura correta" está distribuído em três lugares que **se duplicam e se desencontram**:

| Camada | Arquivo | O que contém | Problema |
|--------|---------|--------------|----------|
| Construct | `packages/core/src/constructs/*.ts` (925 linhas) | Apenas `props: Record<string, unknown>` + validação mínima | **Anêmico** — não conhece defaults, portas, requisitos de AZ, nada |
| Synth | `packages/providers/aws/src/synth/cloudformation.ts` (1989 linhas) | `switch` gigante com 31 cases | Lógica de implementação inteira num arquivo só, × 4 providers |
| Prompt | `packages/ai/src/prompts/system-prompt.ts` (990 linhas) | ~40 "REGRA ABSOLUTA" | **Workarounds em prosa** para o que o código deveria garantir |

### O sintoma

Um `Database.SQL` com `engine: 'postgres'` **sabe** que a porta é 5432. Mas hoje:

- o **construct** não expõe isso;
- o **synth** não valida se o Security Group associado abre 5432;
- então a regra vira texto no **prompt** (`system-prompt.ts:154`), a IA esquece, e o erro aparece só quando o Lambda dá `ETIMEDOUT` no deploy real.

O mesmo padrão se repete em: AZs obrigatórias do RDS (`:152`), `maxAzs` vs subnets explícitas (`:148`), `certificateArn` placeholder (`:257`), `new Client()` fora do handler (`:784`), `backupRetentionDays` do free tier (`:156`). **Cada bug de deploy virou uma regra de prompt** em vez de uma garantia de código.

## 2. Princípio norteador

> **Conhecimento de domínio pertence ao código (construct + synth), não ao prompt.**
> O prompt deve descrever *intenção* ("uma API CRUD com Postgres"), não *implementação* ("abra a porta 5432, use 2 AZs, não hardcode o endpoint").

Toda regra que pode ser **derivada** ou **validada** deve sair do prompt e virar:
- um **default inteligente** no construct, ou
- uma **validação no synth** (erro em synth-time, não deploy-time).

## 3. Sugestões priorizadas

### 🔴 P0 — Camada de validação semântica (synth-time linter)

**O maior ganho.** Hoje o synth gera o template e confia. Falta um passo que pegue, **antes do deploy**, os erros que hoje só aparecem na AWS:

- Security Group sem a porta do engine do banco que ele protege
- Subnets de RDS sem cobertura de ≥2 AZs distintas
- `maxAzs > 0` coexistindo com `Network.Subnet` explícitas (conflito de CIDR)
- CIDR de subnet fora do CIDR da VPC
- Referência cruzada (`vpcId`, `subnetIds`) apontando para construct inexistente
- `certificateArn` com placeholder

Isso transforma ~15 regras de prompt em validações determinísticas. O loop `runSynthCapture` (`ai.ts:243`) já existe e já reenvia erros de synth pra IA — **basta o synth ter o que reclamar**. Hoje ele só falha em erro estrutural de CloudFormation, não em erro semântico.

**Implementação:** um módulo `validateSemantics(stacks): Diagnostic[]` rodando depois de montar o registry e antes de emitir o template. Reaproveita o `registry`/`SynthContext` que já existe.

### 🔴 P0 — Defaults derivados do construct, não do prompt nem do .ts

O usuário não deveria precisar escrever `backupRetentionDays: 0` nem `availabilityZone: 'us-east-1a'`. O construct, combinado com o **perfil de ambiente** (ver P1), deveria derivar:

- porta do SG ← `engine` do banco
- AZs das subnets ← lista de AZs da região do perfil, distribuídas automaticamente
- `backupRetentionDays`/`storageEncrypted`/`instanceType` ← `accountTier`
- nome do secret ← convenção determinística já conhecida pelo synth

Hoje `Database.SQL` (`database.ts:65`) só valida o engine. Poderia expor `defaultPort()`, `requiresMultiAz()`, etc., que tanto o synth quanto a validação consomem — **uma fonte de verdade**.

### 🟠 P1 — Perfil de ambiente como objeto de contexto

Já começamos com `accountTier` no `iacmp.json`. Generalizar para um `EnvironmentProfile`:

```jsonc
{
  "accountTier": "free" | "standard",
  "region": "us-east-1",
  "availabilityZones": ["us-east-1a", "us-east-1b"],  // deriva AZ automática
  "naming": { ... }
}
```

Tanto o synth quanto o `readProjectContext` (`context-reader.ts`) leem esse perfil. Acaba com `us-east-1a` hardcoded no prompt (`:152`) e no stack `.ts`. Responde diretamente a pergunta *"se amanhã eu apontar para uma conta não-free, mexo no código?"* → **não, muda só o perfil.**

### 🟠 P1 — Referências tipadas em vez de strings mágicas

Hoje: `vpcId: 'AppVpc'` (string) → resolvido por regex no synth (`resolveVpcId`, `cloudformation.ts:146`). Frágil: erro de digitação só aparece no deploy, e o synth não sabe *o que* a string referencia.

Proposta: construct retorna um handle (`const vpc = new Network.VPC(...)`) e referências usam `vpc.id` / `vpc.ref('VpcId')`. Ganhos:
- erro de referência quebra na **compilação TypeScript**, não no deploy
- o synth sabe a *semântica* da referência (é uma VPC, é um SG de banco postgres) → habilita os defaults derivados do P0

### 🟡 P2 — Camada de *blueprints* (intenção de alto nível)

O "padrão CRUD de 5 stacks" hoje é **prosa no prompt** (`system-prompt.ts:718-800`, ~80 linhas). Isso é um blueprint disfarçado de instrução. Deveria ser um construct/factory de alto nível:

```ts
new Blueprint.CrudApi(app, 'Items', { engine: 'postgres', entity: 'items' });
```

que expande para VPC + subnets + RDS + 5 Lambdas + API Gateway **com tudo já consistente** (portas, AZs, refs). A IA escolhe o blueprint pela intenção; os detalhes são código testável, não texto que a IA pode errar.

### 🟡 P2 — Quebrar o `switch` gigante em synthesizers por construct

`cloudformation.ts` tem 1989 linhas; os 4 providers somam ~5100 linhas de `switch`. Difícil de manter e testar isoladamente. Padrão alvo: um registry `Map<constructType, Synthesizer>` com um módulo por tipo, cada um implementando `synth(construct, ctx, profile)`. Refactor grande — fazer **depois** que P0/P1 estabilizarem o contrato.

## 4. Impacto esperado sobre o prompt

Das ~40 "REGRA ABSOLUTA" atuais, estimo que **~25 desaparecem** ao migrar para código:

| Regra de prompt | Vira |
|-----------------|------|
| porta do SG por engine (`:154`) | default derivado (P0) |
| AZ obrigatória do RDS (`:152`) | default + validação (P0/P1) |
| `maxAzs` vs subnets (`:148`) | validação synth (P0) |
| `certificateArn` placeholder (`:257`) | validação synth (P0) |
| defaults free tier (`:156`) | perfil de ambiente (P1) |
| não hardcodar endpoint/secret (`:776`) | já resolvido (refs dinâmicas) |
| refs entre stacks (`:919`) | referências tipadas (P1) |

O prompt fica focado em **intenção e formato de resposta**, que é onde a IA agrega valor — e para de ser um manual de armadilhas de CloudFormation que a IA tem que decorar.

## 5. Ordem sugerida

1. **P0 validação semântica** — maior ROI, usa infra que já existe, corta erros de deploy imediatamente
2. **P1 perfil de ambiente** — destrava os defaults derivados e responde a questão free vs standard
3. **P0 defaults no construct** — depende do perfil
4. **P1 referências tipadas** — melhora DX e habilita validação mais rica
5. **P2 blueprints** e **P2 refactor do synth** — quando o contrato estiver estável

---

*Documento gerado a pedido para orientar o refactor. Nenhuma mudança de código foi feita — é só o estudo.*
