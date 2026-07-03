# Plano P4: migrar GCP e Azure para o grafo de recursos

> Registro de dívida técnica planejada. Os emissores atuais de GCP (`gcp-terraform.ts` — `google_*` em `.tf.json`) e Azure (`bicep.ts` — Bicep nativo) **funcionam e ficam** — foram mantidos por decisão do usuário (2026-07-02). Este plano descreve a migração deles para a arquitetura de grafo do P3, a ser executada quando GCP/Azure receberem investimento real (validação por deploy). **Regra: nada é apagado até a versão via grafo estar provada equivalente ou melhor.**

## Por que migrar (quando chegar a hora)

Os emissores atuais são traduções diretas `construct → texto/JSON` (mesmo padrão do antigo `hcl.ts` da AWS). Custos que só aparecem com uso real:
- Não passam pelo `resolveRef`/refs tipadas do P1 — referências entre constructs são ad-hoc
- Não herdam validações nem correções feitas no nível do grafo
- Cada correção de semântica (o equivalente aos ~30 bugs da bateria AWS) precisa ser feita dentro deles, sem reuso

## Estado alvo

```
constructs ──► StackGraph (recursos google_*/Microsoft.*) ──► emissores compartilhados
```

1. **`@iacmp/model`**: mover `graph.ts` (ResourceRef/ImportRef/SubRef/StackGraph) de `providers/aws` para um pacote neutro — pré-requisito para grafos não-AWS
2. **GCP**: `buildGcpGraph(stack)` — mapeamentos `construct → recursos google_*` produzindo `StackGraph`; o `emitTerraform` (já existente, generalizado para tipos não-AWS) serializa. As decisões semânticas do `gcp-terraform.ts` atual são a especificação de partida.
3. **Azure**: decisão em aberto — Bicep é formato texto, não encaixa no `emitTerraform`; precisará de `emitBicep(graph)` próprio. Avaliar se vale a pena vs manter o emissor direto (Azure segue sem validação real; decidir só quando houver demanda). **Gap conhecido**: `bicep.ts` tem `resolveValue`/`resolveRef` (resolução de `Ref` tipadas do P1) escritos mas NÃO ligados ao fluxo de síntese — refs tipadas em props (ex: `environment: { X: db.endpoint }`) não são resolvidas pelo emissor Azure hoje.
4. **Validação**: goldens `.tf.json` GCP + `terraform validate` no CI (padrão da fase B do P3); fase D GCP exige conta Google (pendência: usuário ainda não confirmou ter conta GCP para deploy real).

## Critério de troca (por provider)

A versão via grafo só substitui a artesanal quando: (a) goldens equivalentes gerados dos dois caminhos; (b) `terraform validate`/`az bicep build` verdes; (c) ao menos 1 cenário com deploy real validado. Até lá, os dois caminhos coexistem — **o artesanal não é apagado**.

## Gap registrado: deploy Azure sem Docker local (aberto, adiado)

O deploy Azure de `Function.Lambda` (validado funcional em 2026-07-03) requer Docker Desktop: `docker build --platform linux/amd64` + push pro ACR de bootstrap (`iacmpacr<subscriptionId[:12]>`), com imagem/credenciais injetadas via params Bicep. `az acr build` (build remoto, dispensaria Docker) está bloqueado em subscription free tier (`TasksOperationsNotAllowed`); zip/`WEBSITE_RUN_FROM_PACKAGE` não é suportado em Container Apps.

Alternativa sem Docker avaliada e **adiada por fragilidade**: blob em Storage Account de bootstrap + SAS URL + startup command do container baixando e executando o código (`node -e "...https.get(CODE_URL)..."`). Problemas: restart do container depende da SAS válida (SAS de 1 ano ou blob público), cold start, executar código baixado no boot. Se um dia for implementado: `bicep.ts` troca `imageParamName` por `codeUrlParamName` (image fixa `node:20-alpine` + `command`/`args`); `deploy/azure.ts` troca ACR/Docker por Storage Account + upload + SAS.

## Gap registrado: handlers são AWS-specific (o maior gap multi-cloud restante)

Descoberto no ciclo iacmp32 (2026-07-03): a INFRA é portável (constructs → Bicep/TF), mas o CÓDIGO dos handlers não — o `iacmp ai` gera handlers com `@aws-sdk/*` (DynamoDB DocumentClient etc.); num Container App Azure eles buildam e sobem, mas em runtime falham (não existe DynamoDB; o datastore é Cosmos Table API). Deployar o mesmo projeto em outra cloud exige handlers daquela cloud.

Opções (decidir quando o multi-cloud de runtime virar prioridade):
1. **Geração por provider**: `iacmp ai` gera handlers para o provider do `iacmp.json` (system-prompt precisa de guidance Azure/GCP: `@azure/data-tables`, etc.). Simples, mas o projeto fica preso ao provider da geração.
2. **Facade de runtime** (`@iacmp/runtime`): API única de datastore/queue/etc. com adapters por cloud; os handlers programam contra a facade. Mais profundo, verdadeiro multi-cloud de runtime — combina com o P4/grafo.

## Não fazer

- Não iniciar sem plano de execução detalhado aprovado (este documento é o registro da dívida, não o plano de execução)
- Não apagar `gcp-terraform.ts`/`bicep.ts`/`deployment-manager.ts` durante a migração
