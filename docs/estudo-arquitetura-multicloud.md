# Estudo: complexidade, abstração e o caminho realista para multi-cloud

> Complementa o [estudo-abstracao.md](estudo-abstracao.md) (que trata de onde mora o conhecimento de domínio). Este estudo trata da **arquitetura em si**: por que o projeto está complexo demais, por que a bateria AWS custou tanto, e o que muda para GCP/Terraform serem viáveis.

---

## 1. Diagnóstico em números

| Fato | Evidência |
|---|---|
| 4 synthesizers artesanais, ~32 cases cada | `providers/aws` (2828→ modularizado), `azure/arm.ts` (1138), `terraform/hcl.ts` (1014), `gcp/deployment-manager.ts` (992) |
| ~30 correções de deploy real feitas SÓ no AWS | 20 ciclos da bateria (ver `project-prompt-battery` na memória): IGW automático, SubnetGroup do Redis, listener ordering, log group do Fargate, Lambda::Permission do SNS, stage do REST, WebSocket RouteKey... |
| GCP/Azure/Terraform receberam **zero** dessas correções | Os 3 synths nunca passaram por deploy real — carregam as mesmas classes de bug que a bateria achou no AWS, ×3 |
| GCP mira um produto **descontinuado** | Deployment Manager foi deprecado pela Google (EOL anunciado; a recomendação oficial é Infrastructure Manager, que é **baseado em Terraform**) |
| 4 registries paralelos por tipo de construct | synth switch + `diagram/builder.ts` TYPE_META + `core/validate.ts` layer map + `system-prompt.ts` — adicionar `Messaging.Stream` exigiu tocar os 4 |
| Prompt de 1081 linhas com ~40 "REGRAS" | Workarounds em prosa para o que o código não garante |
| Referências stringly-typed | `'AppDB.SecretArn'`, `'Alb.TargetGroupArn'`, `'AlertsTopic.arn'` — os 2 últimos code reviews acharam **7 bugs** exatamente nessa camada de resolução |

### A conta que não fecha

Cada bug que só aparece em deploy real custa um ciclo: gerar → deploy → observar timeout/erro CFN → diagnosticar → corrigir synth → regerar → redeploy. A bateria levou ~20 ciclos para deixar **um** provider confiável. Com a arquitetura atual, GCP e Azure exigem repetir esse processo inteiro — sem reaproveitar nada, porque as correções vivem dentro do `case` de cada synth.

**Multi-cloud com 4 emissores artesanais = pagar a bateria 4 vezes.**

---

## 2. As cinco causas estruturais da complexidade

### 2.1 Core anêmico: constructs são sacos de props

`packages/core/src/constructs/*.ts` soma ~1000 linhas, mas quase tudo é interface + `this.props = props as unknown as Record<string, unknown>`. O construct não sabe nada:

- `Database.SQL` com `engine: 'postgres'` não sabe que a porta é 5432;
- `Cache.Redis` não sabe que `transitEncryptionEnabled` default exige TLS no cliente;
- Nenhum construct expõe referências (`db.secretArn` é `undefined` em runtime — daí a "REGRA — referências são STRINGS" no prompt).

Consequência: todo conhecimento escorre para o synth (código AWS-specific) ou para o prompt (prosa que a IA esquece). O estudo-abstracao.md detalha isso; aqui o ponto é que o core anêmico é **também** o que impede o reuso entre providers — não há semântica compartilhável, só strings.

### 2.2 Referências stringly-typed

O grafo de dependências entre constructs é codificado em convenções de string (`'<id>.SecretArn'`, `'<id>.TargetGroupArn'`, export names `<stack>-<id>-Arn`). Cada synth reimplementa parsing + resolução com regex e sufixos, e cada caso especial vira um resolver novo (`resolvePolicyResource`, `resolveEnvVarValue`, `resolveAlarmAction`, `resolveTargetGroupArn`...). Bugs recorrentes:

- vault referenciado como `.Arn` → ImportValue de export inexistente (corrigido no ciclo 09 e de novo agora);
- `resolveLambdaArnRef` sem guard de tipo → 4 call sites aceitando qualquer construct (corrigido ontem);
- `.arn` de objeto JS → `null` no template (ciclo 13).

O padrão maduro (CDK/Pulumi) é **token/reference object**: `db.secretArn` retorna um objeto opaco que o synth resolve. O grafo fica explícito, o type-check pega erro de tipo em synth-time, e a resolução vive num lugar só.

### 2.3 Quatro registries paralelos

Para cada tipo de construct existem 4 fontes de verdade desconectadas: o case no synth, a entrada no diagrama, a camada no validate, a doc no prompt. Não há garantia de consistência — o TypeScript não avisa quando falta uma. Um registry único por tipo (objeto com `synthAws`, `diagramMeta`, `layer`, `promptDoc`) tornaria a omissão um erro de compilação e permitiria **gerar** o system-prompt a partir do código.

### 2.4 Providers multiplicam em vez de compartilhar

A hierarquia atual é `construct → [synth AWS | synth Azure | synth GCP | synth TF]`, quatro traduções diretas e independentes. Toda semântica descoberta na bateria ("Fargate precisa de log group", "ECS exige TG associado a listener", "subnet pública precisa de IGW+rota") foi codificada **dentro do case AWS** — inacessível aos outros.

O que falta é um nível intermediário: `construct → modelo de recursos resolvido → emissor de formato`. As regras semânticas (dependências, defaults, wiring de rede) vivem no modelo; o emissor só serializa. Aí um fix beneficia todos os alvos.

### 2.5 Terraform está no eixo errado

Terraform não é uma cloud — é um **formato/engine**. Tratá-lo como quinto provider irmão significa que `terraform/hcl.ts` precisa reimplementar a semântica AWS (e futuramente GCP e Azure) de novo. O eixo correto:

```
           alvo (cloud)          formato de saída
construct ─ aws ───────────────┬─ CloudFormation
                               └─ Terraform (provider aws)
          ─ gcp ───────────────── Terraform (provider google)   ← único caminho sensato
          ─ azure ─────────────── Terraform (provider azurerm)
```

Bônus: como o Deployment Manager morreu, **Terraform é o único caminho de synth para GCP que faz sentido** — e o Infrastructure Manager da própria Google roda Terraform por baixo.

---

## 3. O que a bateria provou (e o teste unitário não pega)

Os 100 testes verdes validam a **forma** do template. Nenhum dos ~30 bugs da bateria era de forma — eram de **semântica da cloud**: recurso que a AWS exige e o template omite, propriedade que o serviço rejeita, timeout de rede por SG/endpoint faltando. Camadas de validação que faltam entre "testes unitários" e "deploy real":

1. **cfn-lint / validate-template** no CI — pega propriedade inválida sem deployar (teria pego o `OverrideAction` do WAF e o `PayloadFormatVersion` do WebSocket);
2. **Golden templates** — projetos de referência com template esperado commitado; diff em cada PR (pega regressão de wiring);
3. **Regras semânticas em synth-time** — já começou (guard do DynamoDB-como-SQL, VpcEndpoint da Lambda em VPC); é o P0 do estudo-abstracao.md e deve ser tabela extensível de regras, não métodos ad-hoc no comando synth.

---

## 4. Recomendações priorizadas

### P0 — Decisão de escopo (não é código, é a decisão mais importante)

Assumir formalmente: **AWS é o alvo de referência; Azure e GCP ficam congelados** (marcar como experimental no README, não receber features novas). Não apagar — só parar de pagar o custo de mantê-los em sincronia enquanto a fundação não muda. Sem essa decisão, cada feature nova (Kinesis, WAF, WebSocket...) cria débito ×4.

### P1 — Referências tipadas (tokens) no core

Constructs passam a expor getters de referência (`db.secretArn`, `lb.targetGroupArn`, `topic.arn`) que retornam `Ref` objects (`{ kind: 'ref', constructId, attribute }`). O synth resolve `Ref` num único lugar. Strings continuam aceitas por compat (deprecadas). **Mata a classe de bug mais recorrente do projeto** e simplifica o prompt (some a "REGRA — referências são STRINGS").

### P2 — Registry único por tipo de construct

Um `ConstructTypeRegistry` onde cada tipo registra: síntese, metadata de diagrama, camada de validação e fragmento de doc do prompt. `validate.ts`, `diagram/builder.ts` e o gerador do system-prompt **derivam** do registry. Adicionar um tipo novo = um arquivo; esquecer algo = erro de compilação.

### P3 — Modelo intermediário de recursos (a fundação do multi-cloud)

O synth AWS deixa de emitir CloudFormation direto e passa a produzir um **grafo de recursos resolvido** (recursos + dependências + referências já resolvidas). Emissores serializam o grafo: `→ CloudFormation` (hoje) e `→ Terraform HCL (provider aws)` (substitui o hcl.ts artesanal). Todas as regras semânticas da bateria passam a viver na construção do grafo — escritas uma vez.

A modularização já feita (`constructs/*.ts`) é o primeiro passo disso: cada `synthXxx` pode migrar para produzir nós do grafo em vez de tuplas CFN, incrementalmente.

### P4 — GCP via Terraform, quando chegar a hora

Com P3 pronto, GCP = novo conjunto de mapeamentos `construct → recursos google` emitidos pelo emissor Terraform existente. Nunca via Deployment Manager (morto). Apagar `gcp/deployment-manager.ts` quando isso acontecer.

### P5 — Camadas de teste semântico

`cfn-lint` no CI + golden templates dos projetos de referência da bateria + tabela de regras semânticas extensível. Custo baixo, pega regressões que hoje só o deploy real pega.

---

## 5. Sequência sugerida

| Ordem | Item | Esforço | Risco | Ganho |
|---|---|---|---|---|
| 1 | P0 — congelar Azure/GCP, README honesto | horas | zero | para a sangria de débito ×4 |
| 2 | P5 — cfn-lint + golden templates | 1-2 dias | baixo | rede de segurança antes de refactors |
| 3 | P1 — tokens/referências tipadas | 3-5 dias | médio | mata a maior classe de bugs |
| 4 | P2 — registry único | 2-3 dias | baixo | consistência + prompt gerado |
| 5 | P3 — grafo intermediário + emissor TF | 1-2 semanas | alto | Terraform de verdade; fundação p/ GCP |
| 6 | P4 — GCP via Terraform | depois de P3 | médio | multi-cloud real |

## 6. Conclusão honesta

O projeto não está complexo porque o problema é difícil — está complexo porque **a mesma semântica é escrita 4 vezes em 4 dialetos** e o conhecimento duramente conquistado na bateria fica preso no dialeto AWS. A rota "abstrair mais os constructs" sozinha não resolve; a alavanca é **mudar o eixo**: um modelo de recursos único, formatos de saída plugáveis, e Terraform como formato (não como cloud). Feito isso, GCP custa um mapeamento — não uma segunda bateria de 20 ciclos.
