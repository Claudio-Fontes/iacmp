# Roadmap Fase 2 — Terraform e GCP

> **Decisões do usuário (24/07):**
> 1. Validar o Terraform tendo o **GCP** como alvo de teste, não a AWS.
> 2. **Nada que já funciona muda.** O projeto passou por um refactor grande para criar
>    a abstração e deixar cada provider independente — isso é patrimônio, não débito.
> 3. **GCP e Terraform compartilham.** Terraform é o formato de saída do GCP.
> 4. **A Fase 1 vai até o `synth`.** Sem `deploy`, sem `destroy`. Deploy real é Fase 2.
>
> Base: auditoria do código em 24/07/2026.

---

## 0. A regra que manda em tudo

> **`providers/aws` e `providers/azure` não são tocados nesta fase.**

Não é cautela genérica — é a regra que o próprio
[plano-p4](plano-p4-migracao-grafo-gcp-azure.md) já registra (*"nada é apagado até a
versão nova estar provada equivalente ou melhor"*), e é o que protege o investimento
de 20 ciclos de deploy real.

O contrato de regressão já existe e é objetivo:

| Guarda | Onde | Tamanho |
|---|---|---|
| Goldens CFN | `providers/aws/test/golden/` | 9 cenários |
| Goldens Terraform | `providers/aws/test/golden-tf/` | 9 cenários |
| Goldens Bicep | `providers/azure/test/golden/` | 9 cenários |
| Testes AWS | `providers/aws/test/` | 2.554 linhas |
| Testes Azure | `providers/azure/test/` | 1.409 linhas |
| **Travas de isolamento** | `providers/{aws,azure,gcp,terraform}/test/isolation.test.ts` | 4 (imports `@iacmp/*` por pacote) |

**Critério:** qualquer trabalho desta fase mantém os 27 goldens **byte-idênticos**.
Golden que muda é bug do trabalho, não atualização do golden.

**A independência agora é executável, não só disciplina.** Cada provider tem uma
trava (`isolation.test.ts`) que varre os imports do próprio `src/` e **falha o CI**
se ele passar a depender de qualquer pacote `@iacmp/*` fora do permitido:

| Provider | Pode importar | Por quê |
|---|---|---|
| `aws` | só `@iacmp/core` | ilha — só a abstração o alcança |
| `azure` | só `@iacmp/core` | ilha — só a abstração o alcança |
| `gcp` | só `@iacmp/core` | impede o G1 de acoplar o GCP ao emissor Terraform que vive no `aws` (força a rota T1: cópia, não import) |
| `terraform` | `@iacmp/core` + `@iacmp/provider-aws` | exceção conhecida **congelada**: a dívida do T2 pode ser paga, nunca crescer |

Provado que a trava morde (import proibido injetado → teste falha apontando o
arquivo; removido → volta ao verde). Enquanto AWS e Azure só importarem `@iacmp/core`,
nenhum trabalho em GCP/Terraform tem **como** alcançá-los — não existe a aresta.

Isso invalida uma proposta da versão anterior deste documento: eu havia sugerido trocar
a assinatura de `emitTerraform(template)` para `emitTerraform(graph)` dentro de
`providers/aws`. **Isso mexeria no caminho AWS que funciona e está descartado.** A
versão correta é aditiva (§4, T1).

---

## 1. A arquitetura, como ela é

O refactor produziu uma separação que os dados confirmam. Import cruzado entre packages:

| Provider | Importa |
|---|---|
| `aws` | `@iacmp/core` |
| `azure` | `@iacmp/core` |
| `gcp` | `@iacmp/core` |
| `terraform` | `@iacmp/core` **+ `@iacmp/provider-aws`** ← única violação |

Os três providers de nuvem dependem **só da abstração**. Nenhum conhece o outro.

### 1.1 O padrão `constructs/` é o exemplo a seguir

A abstração vive em `@iacmp/core` (`BaseConstruct`, `Ref`, `isRef`, `ref` e os tipos
`'Monitoring.Alarm'`, `'Function.Lambda'`…). Cada provider traduz por conta própria,
num módulo por domínio, com a mesma forma de função:

```ts
export function synthesizeMonitoring(construct: BaseConstruct, ctx: SynthContext): void
```

| Provider | `src/synth/constructs/` | Módulos | Linhas | Deveria ter? |
|---|---|---|---|---|
| `aws` | ✅ | workflow, monitoring, storage, messaging, compute, database, function, network | 2.403 | sim |
| `azure` | ✅ | cache, compute, database, function, messaging, monitoring, network, policy, storage, shared | 2.307 | sim |
| `gcp` | ❌ **não existe** | — | — | **sim — é o trabalho da §4** |
| `terraform` | ❌ não existe | — | — | **não — e isso está certo** |

**É aqui que está a resposta para "o que falta no GCP".** Não falta um grafo
compartilhado — falta o GCP adotar o padrão que AWS e Azure já demonstram duas vezes.

**Os dois vazios não são o mesmo vazio.** A pasta `constructs/` existe para traduzir
`construct → recurso de uma nuvem`. O GCP faz essa tradução (`construct → google_*`) e
por isso deveria ter os módulos — hoje ele faz tudo num monolito de 764 linhas. O
Terraform **não traduz construct nenhum**: ele serializa recursos que outro provider já
resolveu. Format não tem `constructs/` porque não mapeia construct.

Ou seja: o `providers/terraform` estar vazio é sintoma de **estar na categoria errada**
(listado como provider irmão quando é camada de formato), não de estar incompleto. O
`providers/gcp` estar sem `constructs/` é incompletude de verdade. §1.2 trata do
primeiro; a §4 trata do segundo.

O `gcp/src/synth/` tem hoje três arquivos monolíticos:

| Arquivo | Linhas | Situação |
|---|---|---|
| `deployment-manager.ts` | 954 | ⛔ código morto — nenhum caminho de execução chega lá |
| `gcp-terraform.ts` | 764 | ⚠️ monolito no estilo anterior ao refactor |
| `common.ts` | 51 | — |

As 764 linhas do `gcp-terraform.ts` **não se jogam fora**: são o mapeamento
`construct → google_*` que alguém já pensou. Elas se **redistribuem** nos módulos por
domínio, ganhando `resolveRef` e a estrutura que AWS e Azure têm.

### 1.2 Terraform é formato, não provider

O `providers/terraform` tem 22 linhas e importa `@iacmp/provider-aws` — por isso a pasta
parece vazia: o emissor mora em `providers/aws/src/synth/emit/` (1.548 linhas).

Com "GCP e Terraform compartilham", a relação certa se inverte:

```
hoje:     providers/terraform  ──importa──►  providers/aws       (viola a independência)

alvo:     providers/aws  ─┐
                          ├──►  camada de formato .tf.json  (não conhece nuvem nenhuma)
          providers/gcp  ─┘
```

Terraform deixa de ser um provider irmão e vira **camada de formato** — exatamente o
eixo que o [estudo §2.5](estudo-arquitetura-multicloud.md) defende (*"Terraform não é
uma cloud, é um formato/engine"*).

**Nota honesta sobre o tamanho do compartilhado:** o que é genuinamente comum é a
montagem do documento `.tf.json` (blocos `terraform`/`required_providers`/`provider`/
`variable`/`resource`/`output`, sintaxe de interpolação de referência, variáveis de
input). São ~150–250 linhas. O mapeamento `construct → recurso` é e continua sendo de
cada provider. **A camada compartilhada economiza serialização, não semântica.**

### 1.3 O preço da independência (dito uma vez, sem insistir)

Com providers independentes, as ~30 correções que a bateria AWS descobriu em deploy real
— IGW automático, SubnetGroup do Redis, ordem de listener, log group do Fargate — **não
migram sozinhas para o GCP**. O GCP paga a própria bateria.

Esse é o custo consciente de uma arquitetura que, em troca, dá isolamento total: mexer
no GCP não pode quebrar AWS nem Azure, e cada provider evolui no seu ritmo. É uma troca
legítima e é a sua. Registro para que o prazo da §4 não seja lido como pessimismo — ele
é consequência direta desta escolha.

---

## 2. Fase 1 — até o `synth`

O teto desta fase é o **artefato gerado**. Nada sobe, nada é destruído, nenhum recurso
é criado, nenhum dólar é gasto.

### 2.1 Os três degraus que cabem na Fase 1

Existe mais chão entre "synth" e "deploy" do que parece, e é chão barato:

| Degrau | O que valida | Cria recurso? | Precisa de credencial? |
|---|---|---|---|
| `iacmp synth --provider gcp` | o `.tf.json` é gerado; forma do documento | não | não |
| `terraform init` + **`terraform validate`** | tipo de recurso existe no provider `google`; campo obrigatório presente; referência resolve; sintaxe HCL/JSON válida | não | **não** (só baixa o plugin) |
| **`terraform plan`** | o que a API do Google diria: projeto/região válidos, quota, API habilitada, conflito de nome, valor rejeitado pelo serviço | **não** | sim (leitura) |

O `terraform validate` é o degrau de maior retorno de todo este documento: pega a classe
inteira de "recurso `google_*` que não existe", "campo obrigatório faltando" e
"referência quebrada" **de graça, offline, sem conta**. É o equivalente GCP do `cfn-lint`
que o [estudo §3](estudo-arquitetura-multicloud.md) recomendou.

O `terraform plan` lê a API real sem escrever nada — respeita "sem deploy, sem destroy"
e ainda assim exercita o provider `google` de verdade. **Recomendo incluir**; se preferir
manter a Fase 1 100% offline, ele desce para a Fase 2 e a fase fecha no `validate`.

### 2.2 Passo 0 — spike com o que já está lá (2 a 4 dias)

```bash
iacmp init spike-gcp --template <cenário>
iacmp synth --provider gcp          # gera o .tf.json
cd .iacmp/out/gcp
terraform init -input=false
terraform validate                   # offline, sem conta
terraform plan                       # opcional; lê, não escreve
```

Responde com dado, não com estimativa: o `gcp-terraform.ts` produz `.tf.json` que o
Terraform aceita? Que **classe** de erro aparece? E dimensiona o trabalho da §4 com
evidência em vez de analogia com o Azure.

**Nada é modificado no Passo 0.** É observação pura.

### 2.2.1 Resultado do Passo 0 — executado em 24/07/2026

Rodado de verdade, com `terraform` 1.9.8 e o provider `hashicorp/google` v5.45.2.

| Cenário | `synth --provider gcp` | `terraform validate` |
|---|---|---|
| `s3-lambda-pipeline` | ✅ gera `.tf.json` | ✅ **Success! The configuration is valid.** |
| `sns-alarm` | ✅ gera `.tf.json` | ✅ **Success! The configuration is valid.** |

**A forma está madura.** Recursos `google_*` corretos (`cloudfunctions2_function`,
`storage_bucket`, `pubsub_topic`/`subscription`, `monitoring_alert_policy`) e as
**referências nativas do Terraform funcionam** (`"${google_pubsub_topic.x.id}"`, não
strings soltas). Nenhum erro de forma nos dois cenários.

**Mas o spike expôs 3 bugs de *semântica* que o `validate` não pega** — a confirmação
empírica da §2.3 (validate vê forma, não semântica de nuvem):

1. **Vocabulário AWS vazando:** o alarme emite `notification_channels: ["AlertsTopic.Arn"]`
   — `.Arn` é conceito AWS, virou string literal. No GCP tem de ser um
   `google_monitoring_notification_channel` (tipo Pub/Sub) apontando para o topic.
2. **Wiring de evento perdido:** a subscription "lambda" do SNS (topic → função) virou
   uma pull subscription **órfã**, sem `push_config` ligando ao Cloud Function. O gatilho
   se perdeu na tradução.
3. **Alarme não conecta ao topic real** (mesma causa do nº1).

**Consequência para a estimativa:** o G1 não conserta synth quebrado — a forma já sai
válida; vira **refactor** (redistribuir em `constructs/`). O Passo 0 saiu em horas, não
nos 2-4 dias estimados. **Fase 1 revisada para ~3-4,5 semanas.** Os 3 bugs acima são de
semântica, invisíveis ao `validate`, e entram como itens do G1/Fase 2 (§4).

### 2.2.2 Dívida de nomenclatura GCP (descoberta ao criar os goldens da Fatia 2)

Ao gerar goldens que exercitam compute/database/network (§4, G1b), o `terraform validate`
expôs um 4º bug de semântica, **sistêmico**: os recursos `google_compute_*`
(`google_compute_network`, `_subnetwork`, `_instance_template`, `_backend_bucket`,
`google_container_cluster`, `google_compute_security_policy`…) usam `construct.id` **cru**
como `name`, mas o GCP exige `^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$` (minúsculas). `AppVpc`,
`PublicSubnet1`, `ApiWaf` etc. são rejeitados. Não é global — `cloudfunctions2`, `storage`,
`pubsub` aceitam maiúscula (por isso s3-lambda/sns-alarm validam). Fix cirúrgico por tipo
de recurso (normalizar só onde a API restringe), a fazer **após o refactor da Fatia 2**;
ao corrigir, os goldens `compute-suite`/`network-suite` regeneram (output muda de propósito).
Os goldens atuais desses 2 cenários **congelam o output com a dívida** — servem para travar
o refactor byte-a-byte, não como atestado de validade.

### 2.3 O que a Fase 1 não pode dizer

Precisa estar escrito, porque é exatamente o erro que acabamos de corrigir no README.

Os 100+ testes verdes do projeto validam **forma**, e — nas palavras do próprio
[estudo §3](estudo-arquitetura-multicloud.md) — **nenhum dos ~30 bugs da bateria AWS era
de forma**. Eram recursos que a nuvem exige e o template omitia, timeout por SG/endpoint
faltando, ordem de dependência. `validate` e `plan` não pegam nada disso.

Portanto, ao fim da Fase 1 é honesto dizer *"o GCP sintetiza Terraform válido"*, e é
desonesto dizer *"o GCP é suportado"*. A segunda frase só depois da Fase 2.

### 2.4 Os dois cenários certos

Os **dois que já foram validados em deploy real através do emissor Terraform na AWS**:
`s3-lambda-pipeline` e `sns-alarm`. Mesmo cenário, formato de saída igual, nuvem
diferente — o que falhar aponta para o mapeamento GCP, não para o Terraform.

| Cenário | AWS | GCP | Free tier (para a Fase 2) |
|---|---|---|---|
| `s3-lambda-pipeline` | S3 → Lambda → DynamoDB | Cloud Storage → Cloud Functions gen2 → Firestore | ✅ Always Free nos três |
| `sns-alarm` | SNS + CloudWatch Alarm | Pub/Sub + Cloud Monitoring | ✅ 10 GB/mês de Pub/Sub |

**Fique longe de** Cloud SQL, Memorystore Redis, Bigtable e NAT Gateway — sem free tier
e caros. O Azure já mostrou o estrago: o cenário 08 está parado até hoje por limite de
subscription. Na Fase 1 isso não custa nada; a escolha é para não ter que trocar de
cenário na Fase 2.

**Handlers: não escreva nenhum na Fase 1.** Sem deploy, não há runtime — o adapter GCP
do `@iacmp/runtime` (§3) é problema da Fase 2, e adiá-lo é um ganho direto desta
decisão.

---

## 3. O gap que quase todo mundo esquece (Fase 2)

A infraestrutura é portável; **o código que roda dentro dela não é.** O `iacmp ai` gera
handlers com `@aws-sdk/*` — num Cloud Run isso builda, sobe e falha em runtime, porque
não existe DynamoDB no GCP.

O `@iacmp/runtime` tem `aws/` (119 linhas) e `azure/` (173), e não tem `gcp/`. Vai
precisar de Firestore para `table`, Cloud Storage para `blob` e Pub/Sub para fila. Sem
isso o GCP entrega o pior resultado possível para quem vende confiança: **o deploy passa
e a aplicação quebra.**

Fica registrado aqui e **não entra na Fase 1** — sem deploy, não há runtime.

---

## 4. Sequência

### Fase 1 — até o `synth` (revisada para ~3–4,5 semanas, §2.2.1)

| # | Etapa | Estimativa | Status |
|---|---|---|---|
| **0** | **Spike: 2 cenários, `synth` + `validate`, sem modificar nada** | 2–4 dias | ✅ **FEITO** 24/07 (§2.2.1) — 2 cenários validam; expôs 3 bugs de semântica (corrigidos, `e16946b`) |
| T1 | Extrair camada de formato `.tf.json` para um pacote neutro — por cópia | 4–6 dias | ⏸️ **ADIADO** — auditoria mostrou que o comum é só o envelope (~40 linhas); vai junto do T2 (Fase 2), não vale o pacote novo agora |
| G1 | `providers/gcp/src/synth/constructs/*.ts` — redistribuir o `gcp-terraform.ts` no padrão AWS/Azure | 2–3 sem | ✅ **FEITO** 24/07 (`4ae1189` fatia 1 + `cf32f23` fatia 2) — 764→68 linhas, 8 domínios modulares, `synthLegacy` eliminado. Mantido o mecanismo de refs por string do GCP (sem `resolveRef` novo) |
| G1b | **Goldens `.tf.json` do GCP** + `terraform validate` no CI | 3–5 dias | 🟡 **PARCIAL** — goldens FEITOS 24/07 (`4405fbd` + `44317b1`, 6 cenários); `terraform validate` no CI ainda pendente |
| — | **Fix dívida de nomes GCP** (§2.2.2) — normalizar `name` dos `google_compute_*` | 1–2 dias | ⏳ **PRÓXIMO** — faz compute-suite/network-suite validarem; regenera esses 2 goldens |
| **GO/NO-GO** | Repetir os cenários pelo caminho novo | 2–3 dias | ⏳ pendente |

**Saída da Fase 1:** *"o GCP sintetiza Terraform válido, com goldens e validate no CI."*
Não mais que isso (§2.3).

O G1b é o que dá permanência ao trabalho: sem golden, a Fase 2 não tem como saber se uma
correção de semântica quebrou a forma. AWS e Azure já têm 9 cada — o GCP passa a ter os
seus.

### Fase 2 — deploy real (4 a 6 meses)

| # | Etapa | Estimativa | Toca aws/azure? |
|---|---|---|---|
| G2 | Adapter `gcp/` no `@iacmp/runtime` | 1 semana | não |
| G3 | Handlers GCP na geração por IA (system prompt + corpus) | 1–2 semanas | não |
| G4 | Fixtures GCP no `@iacmp/knowledge` | 1–2 semanas | não |
| G5 | **Bateria e2e de 20 cenários no GCP** | **6–10 semanas** | não |
| G6 | Apagar `deployment-manager.ts` (954 linhas mortas) | horas | não |
| T2 | *(opcional)* migrar o `providers/terraform` para a camada neutra e remover o import de `provider-aws` | 3–5 dias | sim — **só com os 9 goldens-tf byte-idênticos** |

**Primeiro sinal em ~3 dias. Fase 1 fecha em ~5–6 semanas. GCP suportado ao fim da Fase 2.**

Sobre o T1 ser cópia e não mudança: duplicar ~200 linhas de serialização é mais barato
que arriscar os 9 goldens-tf da AWS. Se o caminho GCP se provar, o T2 unifica depois,
com os goldens como juiz. Se não se provar, a AWS nunca correu risco.

O T2 é o único item que encosta em `providers/aws`, é opcional, e vem por último.

---

## 5. O critério de go/no-go

Escreva antes de começar, porque o viés natural é tratar todo bug como "só mais um" e
descobrir o problema no mês quatro.

Depois do G1, os mesmos 2 cenários rodam pelo caminho novo. **Atenção ao que a Fase 1
consegue medir:** ela vê erro de *forma* (`validate`) e, com `plan`, erro de *aceitação
pela API*. Não vê semântica de nuvem. Então o go/no-go aqui é sobre **estrutura**, e o
segundo portão — o de semântica — só existe na Fase 2, com o ritmo de bugs por ciclo.

Com providers independentes, **bugs de semântica GCP são esperados** — o que se mede é o
**ritmo**:

- **Poucos bugs por cenário, e cada correção fica num módulo de domínio** → o padrão
  `constructs/` está segurando. Extrapolar para 20 cenários é aritmética. **Segue.**
- **Muitos bugs, ou correções que espalham por vários módulos, ou que pedem mudança em
  `@iacmp/core`** → a abstração não cobre o GCP tão bem quanto cobre AWS/Azure, e o G5
  vai estourar. **Para e reavalia antes de queimar a conta.**

Mudança em `@iacmp/core` é o sinal mais grave: `core` é compartilhado pelos três
providers, então mexer nele é justamente o que a regra da §0 protege.

---

## 6. Riscos

| Risco | Peso | Mitigação |
|---|---|---|
| Trabalho no GCP vazar para AWS/Azure | **Alto** | §0: 27 goldens byte-idênticos; T1 por cópia; T2 opcional e por último |
| **Fase 1 verde ser lida como "GCP pronto"** | **Alto** | §2.3 explícito no doc e na comunicação. `validate` verde ≠ deploy verde — foi o erro que o README acabou de corrigir |
| Bateria GCP estourar o prazo (Fase 2) | **Alto** | Segundo portão de go/no-go, por ritmo de bugs por ciclo |
| Free tier travar cenário (precedente do Azure 08) | Médio | Cenários escolhidos já pensando na Fase 2; na Fase 1 não custa nada |
| G1 exigir mudança em `@iacmp/core` | Médio | Sinal de parada (§5). Se for inevitável, é aditivo e com os 27 goldens como guarda |
| Custo em dólar da bateria | Médio | Zero na Fase 1. Medir no primeiro ciclo da Fase 2 e extrapolar |
| 4–6 meses de GCP adiarem a plataforma paga | **Alto** | As duas frentes são independentes (§7). A Fase 1 custa 5–6 semanas e não bloqueia nada |
| `describeStatus` do GCP retorna sempre `{deployed:false}` | Baixo | `ls`/`diff` cegos para GCP; corrigir junto com o G2 (só importa com deploy) |

---

## 7. Nota para o `licenciamento.md`

Correção que esta auditoria trouxe. Aquele documento (§2) diz que o corte
cliente/servidor da plataforma acontece no **grafo**. Vale para AWS e Terraform, mas
**não** para Azure e GCP: `emitBicep(stack)` e `emitGCPTerraform(stack)` recebem o
`Stack` direto.

A costura correta é o **`Stack` serializado** — a árvore de constructs em JSON, que é a
entrada comum aos quatro caminhos e a fronteira natural da abstração `@iacmp/core`.

Isso é melhor notícia do que parece, e casa com a regra da §0: o corte da plataforma
**não modifica nenhum provider** — envolve os quatro por fora, na fronteira que o
refactor já criou. As duas frentes correm independentes, e a plataforma não espera o GCP.
