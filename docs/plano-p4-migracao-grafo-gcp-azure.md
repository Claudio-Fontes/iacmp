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
3. **Azure**: decisão em aberto — Bicep é formato texto, não encaixa no `emitTerraform`; precisará de `emitBicep(graph)` próprio. Avaliar se vale a pena vs manter o emissor direto (Azure segue sem validação real; decidir só quando houver demanda).
4. **Validação**: goldens `.tf.json` GCP + `terraform validate` no CI (padrão da fase B do P3); fase D GCP exige conta Google (pendência: usuário ainda não confirmou ter conta GCP para deploy real).

## Critério de troca (por provider)

A versão via grafo só substitui a artesanal quando: (a) goldens equivalentes gerados dos dois caminhos; (b) `terraform validate`/`az bicep build` verdes; (c) ao menos 1 cenário com deploy real validado. Até lá, os dois caminhos coexistem — **o artesanal não é apagado**.

## Não fazer

- Não iniciar sem plano de execução detalhado aprovado (este documento é o registro da dívida, não o plano de execução)
- Não apagar `gcp-terraform.ts`/`bicep.ts`/`deployment-manager.ts` durante a migração
