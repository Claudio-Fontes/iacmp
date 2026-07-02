# Plano P3: grafo intermediário de recursos + emissores (CFN e Terraform)

> Item P3 do [estudo-arquitetura-multicloud.md](estudo-arquitetura-multicloud.md) — a fundação multi-cloud. Muda o eixo de `construct → template CFN` para `construct → grafo de recursos AWS → emissor de formato`. Todo o conhecimento semântico da bateria (wiring, defaults, dependências) passa a viver na construção do grafo — escrito uma vez, emitido em N formatos.

**Pré-requisitos prontos:** P1 (`resolveRef` central — único produtor de referências) e P2 (`CONSTRUCT_TYPES` — registry único). O refactor do synth em `constructs/*.ts` já isolou a produção de recursos por domínio.

---

## 1. A ideia em uma frase

O synth AWS de hoje **já produz quase o grafo**: `Array<[logicalId, { Type, Properties, DependsOn }]>`. O que o prende ao CloudFormation são as **referências embutidas como intrínsecas CFN** (`Fn::GetAtt`, `Ref`, `Fn::ImportValue`, `Fn::Sub`) espalhadas dentro de `Properties`. O P3 troca essas intrínsecas por **marcadores tipados** (`ResourceRef`) e move a conversão marcador→sintaxe para **emissores** por formato.

```
constructs/*.ts ──► ResourceGraph (nós AWS + ResourceRef) ──► emitCloudFormation() ──► JSON CFN (byte-idêntico aos goldens)
                                                          └──► emitTerraform() ─────► HCL (provider aws)
```

Como CFN e Terraform (provider aws) descrevem **os mesmos recursos AWS**, um grafo de recursos AWS serve aos dois. (GCP no P4 = novo conjunto de mapeamentos construct→recursos google, mesmo emissor Terraform.)

## 2. Interfaces centrais (`providers/aws/src/synth/graph.ts`)

```ts
/** Marcador de referência dentro de Properties — substitui Fn::GetAtt/Ref/ImportValue no grafo. */
export interface ResourceRef {
  readonly kind: 'iacmp:resource-ref';
  readonly targetLogicalId: string;          // nó alvo no grafo (same-stack)
  readonly attribute: string;                 // 'Arn', 'Id' (=Ref do CFN), 'PrimaryEndPoint.Address'...
}

/** Referência a export de OUTRA stack (cross-stack). */
export interface ImportRef {
  readonly kind: 'iacmp:import-ref';
  readonly exportName: string;                // '<stack>-<constructId>-<suffix>'
}

/** Template string com refs embutidas — substitui Fn::Sub. */
export interface SubRef {
  readonly kind: 'iacmp:sub-ref';
  readonly template: string;                  // com ${placeholders}
  readonly vars: Record<string, ResourceRef | ImportRef | string>;
}

export type GraphValue = ResourceRef | ImportRef | SubRef;

export interface ResourceNode {
  readonly logicalId: string;
  readonly awsType: string;                   // 'AWS::Lambda::Function'
  readonly properties: Record<string, unknown>;  // pode conter GraphValue em qualquer nível
  readonly dependsOn: string[];
  /** Pseudo-params usados (AWS::Region, AWS::AccountId) resolvem por formato no emissor. */
}

export interface StackGraph {
  readonly stackName: string;
  readonly nodes: ResourceNode[];
  readonly exports: Array<{ name: string; value: GraphValue }>;  // Outputs/Export de hoje
}
```

`isGraphValue()` type guards análogos ao `isRef()` do P1.

## 3. Emissores

### `emit/cloudformation.ts`
Percorre `properties` recursivamente convertendo: `ResourceRef{attr:'Id'}` → `{ Ref }`; demais → `{ Fn::GetAtt }`; `ImportRef` → `{ Fn::ImportValue }`; `SubRef` → `{ Fn::Sub }`; pseudo-params → `${AWS::Region}` etc. **Critério de aceite: goldens byte-idênticos.**

### `emit/terraform.ts`
1. **Tabela de mapeamento** `AWS::* → { tfType, mapProps }` (ex: `AWS::Lambda::Function → aws_lambda_function`, `Code` dir → `filename`+`source_code_hash` ou s3; propriedades PascalCase→snake_case com exceções por recurso). Escopo inicial: **os tipos de recurso presentes nos 9 goldens** (~35 tipos AWS::*) — a tabela cresce com a demanda.
2. Referências: `ResourceRef` → `aws_lambda_function.<id>.arn` (tabela atributo CFN→atributo TF por tipo); `ImportRef` → `data.terraform_remote_state` ou variável (decisão: **variável de input** `var.<exportName>` — mais simples e não impõe backend); `SubRef` → interpolação HCL.
3. Reusar do `hcl.ts` atual o que presta: `hclString` (escape), `block`/`attr` (formatação). O resto do `hcl.ts` (os 32 cases artesanais) será **apagado na fase C**.

## 4. Fases

### Fase A — grafo + emissor CFN (sem mudança de saída)
1. `graph.ts` (interfaces acima) + `emit/cloudformation.ts`
2. `resolveRef` (resolvers.ts) passa a retornar `GraphValue` em vez de intrínseca CFN; um shim `toCfn()` mantém os call sites funcionando enquanto migram
3. Migrar `constructs/*.ts` módulo a módulo (mesma ordem do refactor: monitoring → workflow → messaging → storage → database → compute → network → function): cada `synthXxx` produz `ResourceNode[]` com `GraphValue`; `synthesize()` monta o `StackGraph` e chama `emitCloudFormation`
4. Juiz: 149 testes + goldens **byte-idênticos** após cada módulo
5. Casos difíceis mapeados de antemão: `Fn::Sub` da DefinitionString do Step Functions (vira `SubRef`), dynamic-ref `{{resolve:secretsmanager:...}}` (fica string literal — é sintaxe de Properties, não referência), `synthesizeVPCChildren`

### Fase B — emissor Terraform
1. Tabela de mapeamento para os tipos dos goldens
2. `emitTerraform(graph)` → arquivos `.tf.json` (**decisão: JSON syntax do Terraform, não HCL texto** — elimina toda a classe de bug de escape/formatação do hcl.ts; Terraform lê `.tf.json` nativamente)
3. Goldens Terraform: mesmos 9 cenários, `test/golden-tf/*.tf.json`
4. `terraform validate` local nos goldens (requer binário; se indisponível, adiar p/ CI) + job no CI (hashicorp/setup-terraform)

### Fase C — troca do provider terraform
1. Provider `terraform` do CLI passa a: rodar o synth AWS → grafo → `emitTerraform`
2. Apagar `providers/terraform/src/synth/hcl.ts` (1014 linhas) e testes correspondentes; portar testes que validem comportamento (não formato)
3. README: terraform sai de "experimental" para "beta (mesma semântica do provider aws)"

### Fase D — validação real (fora do P3, registrar)
`terraform plan`/`apply` de 1-2 goldens na conta AWS e2e — mini-bateria do emissor TF. Só depois disso terraform vira "estável".

## 5. Decisões que precisam de aprovação

| # | Decisão | Recomendação |
|---|---|---|
| 1 | Formato de saída TF | `.tf.json` (JSON syntax) em vez de HCL texto — menos bugs de escape, diff limpo |
| 2 | Cross-stack no TF | `var.<exportName>` (variáveis de input) em vez de `terraform_remote_state` — não impõe backend |
| 3 | Destino do hcl.ts | Apagar na fase C (não manter fallback) |
| 4 | Escopo da tabela de mapeamento | Só os tipos dos 9 goldens; erro claro "tipo X ainda não suportado no emissor Terraform" para o resto |
| 5 | Onde vive o grafo | `providers/aws/src/synth/graph.ts` por ora; sobe para um pacote `@iacmp/model` quando o P4 (GCP) precisar |

## 6. Riscos

| Risco | Mitigação |
|---|---|
| Fase A quebrar CFN silenciosamente | goldens byte-idênticos por módulo migrado; migração incremental com shim |
| Mapeamento TF com semântica diferente do CFN (defaults divergentes) | fase D (plan/apply real) antes de declarar estável; começar pelos tipos exercitados em deploy real |
| `terraform validate` indisponível no sandbox local | validar no CI; goldens `.tf.json` revisáveis a olho |
| Fase A + B grandes demais para uma sessão | cada fase/módulo = 1 commit; retomável (padrão que já usamos no P1/P2) |
