# Plano P1: referências tipadas (interface-first)

> Item P1 do [estudo-arquitetura-multicloud.md](estudo-arquitetura-multicloud.md). Substitui as referências stringly-typed (`'AppDB.SecretArn'`, `'Alb.TargetGroupArn'`, `alarmActions: ['AlertsTopic']`) por **objetos `Ref` tipados via interfaces**, com resolução centralizada e validação de atributo em synth-time.

**Diretriz de design: abusar de interfaces.** Toda relação hoje implícita em convenção de string vira uma interface TypeScript: o shape do `Ref`, os atributos válidos por tipo de construct, os campos de props que aceitam referência. O compilador passa a pegar o que hoje só o deploy real pega.

---

## 1. O problema que este plano mata

Os dois últimos code reviews acharam **7 bugs na camada de resolução de strings**:

- `'MyVault.Arn'` → ImportValue de export inexistente (`-Arn` vs `-SecretArn`)
- `resolveLambdaArnRef` aceitando qualquer construct em 4 call sites (S3, SNS, EventBridge, authorizers)
- `'MyVault.QueueArn'` resolvendo silenciosamente para SecretArn
- `.arn` de objeto JS → `null` no template (ciclo 13)

Causa comum: **cada resolver reimplementa parsing + validação por regex e sufixo**, sem uma fonte de verdade de "quais atributos o tipo X expõe". São 23 call sites de resolvers espalhados pelos módulos `constructs/*.ts` do synth.

---

## 2. Design

### 2.1 `core/src/refs.ts` — as interfaces centrais

```ts
/** Referência tipada a um atributo de outro construct. */
export interface Ref<A extends string = string> {
  readonly kind: 'iacmp:ref';
  readonly constructId: string;
  readonly attribute: A;
}

export function ref<A extends string>(constructId: string, attribute: A): Ref<A>;
export function isRef(value: unknown): value is Ref;

/**
 * FONTE ÚNICA DE VERDADE: atributos referenciáveis por tipo de construct.
 * O synth valida todo Ref (e toda string parseada) contra esta tabela.
 */
export interface ConstructAttributeMap {
  'Secret.Vault':          'SecretArn';
  'Database.SQL':          'Endpoint' | 'Port' | 'SecretArn' | 'Password' | 'Username';
  'Database.DynamoDB':     'Arn' | 'Name';
  'Database.DocumentDB':   'Endpoint' | 'Port' | 'Password';
  'Cache.Redis':           'Endpoint' | 'Port';
  'Messaging.Queue':       'Arn' | 'Url';
  'Messaging.Topic':       'Arn';
  'Messaging.Stream':      'Arn' | 'Name';
  'Function.Lambda':       'Arn' | 'Name';
  'Network.LoadBalancer':  'TargetGroupArn' | 'DnsName';
  'Network.WAF':           'Arn';
  'Storage.Bucket':        'Arn' | 'Name';
  // ... completar com todos os tipos que exportam Outputs hoje
}

export const CONSTRUCT_ATTRIBUTES: { [K in keyof ConstructAttributeMap]: ReadonlyArray<ConstructAttributeMap[K]> };
```

A interface `ConstructAttributeMap` e a constante `CONSTRUCT_ATTRIBUTES` são declaradas juntas — o TypeScript garante que a constante cobre exatamente a interface (via `satisfies`).

### 2.2 Getters tipados nos constructs (interfaces `XxxRefs`)

Cada classe de construct implementa uma interface de refs:

```ts
// core/src/constructs/secret.ts
export interface VaultRefs {
  readonly secretArn: Ref<'SecretArn'>;
}

export class Vault implements BaseConstruct, VaultRefs {
  get secretArn(): Ref<'SecretArn'> { return ref(this.id, 'SecretArn'); }
  // ...
}
```

```ts
// core/src/constructs/database.ts
export interface SQLRefs {
  readonly endpoint: Ref<'Endpoint'>;
  readonly port: Ref<'Port'>;
  readonly secretArn: Ref<'SecretArn'>;
  readonly password: Ref<'Password'>;
}
```

Uso na app do usuário (mesma stack):

```ts
const db = new Database.SQL(stack, 'AppDB', { engine: 'postgres' });
new Fn.Lambda(stack, 'ApiFn', {
  environment: { DB_HOST: db.endpoint, DB_PASSWORD: db.password },
});
```

**Cross-stack continua por string ou `ref()` explícito** — stacks vivem em arquivos separados e só exportam a `Stack`, então não há instância para chamar o getter: `environment: { DB_HOST: ref('AppDB', 'Endpoint') }` (preferido) ou `'AppDB.Endpoint'` (compat).

### 2.3 Props aceitam `string | Ref` (interfaces atualizadas)

Todos os campos de props que hoje carregam referência mudam de `string` para `string | Ref`:

```ts
// function.ts
environment?: Record<string, string | Ref>;
// policy.ts
resources?: Array<string | Ref>;
// monitoring.ts
alarmActions?: Array<string | Ref>;
okActions?: Array<string | Ref>;
// compute.ts
targetGroupArn?: string | Ref<'TargetGroupArn'>;
// workflow.ts
resource?: string | Ref<'Arn'>;       // Task step
// storage.ts
eventNotifications?: Array<{ lambdaId: string | Ref<'Arn'>; ... }>;
// messaging.ts (topic subscriptions, eventSources etc.)
```

Onde o campo exige um atributo específico, o generic trava: `targetGroupArn?: string | Ref<'TargetGroupArn'>` — passar `db.secretArn` vira **erro de compilação**.

### 2.4 Resolução centralizada no synth

Em `providers/aws/src/synth/resolvers.ts`:

```ts
/** Converte string legada ('AppDB.SecretArn', 'AlertsTopic', 'arn:...') em Ref | literal. */
export function parseStringRef(value: string, ctx: SynthContext): Ref | { literal: string };

/**
 * ÚNICO ponto de resolução. Valida:
 *  1. constructId existe no registry (erro claro se não);
 *  2. attribute é válido para o TIPO do construct (via CONSTRUCT_ATTRIBUTES);
 *  3. same-stack → GetAtt/Ref correto; cross-stack → ImportValue com o export REAL.
 */
export function resolveRef(r: Ref, ctx: SynthContext): unknown;
```

Os resolvers atuais (`resolveEnvVarValue`, `resolvePolicyResource`, `resolveAlarmAction`, `resolveQueueArn`, `resolveTargetGroupArn`, `resolveLambdaArnRef`) viram **wrappers finos**: `string → parseStringRef → resolveRef`; `Ref → resolveRef` direto. A tabela de exports (`-Arn`, `-SecretArn`, `-Endpoint`...) sai dos regex espalhados e vira um mapa `tipo × atributo → export suffix` ao lado de `CONSTRUCT_ATTRIBUTES`.

**Efeito:** os guards ad-hoc adicionados ontem (`requireLambda`, checks de S3/SNS/EventBridge) são substituídos por UM mecanismo — `resolveRef` com atributo esperado: `resolveRef(r, ctx, { expectType: 'Function.Lambda' })`.

### 2.5 O que o SynthContext precisa

Hoje `ctx.registry` mapeia `constructId → stackName`. Passa a mapear `constructId → { stackName, type }` — necessário para a validação de atributo por tipo. (Elimina também os Sets paralelos `secretVaults`, `lambdaConstructs`, `s3Buckets` — o tipo já está no registry.)

---

## 3. Passos de execução

Regra: testes (109) + goldens verdes após **cada** passo. Goldens são a prova de que a resolução nova produz template idêntico.

| # | Passo | Entrega |
|---|---|---|
| 1 | `core/src/refs.ts` | `Ref`, `ref()`, `isRef()`, `ConstructAttributeMap`, `CONSTRUCT_ATTRIBUTES` |
| 2 | Registry com tipo | `ctx.registry: Map<string, { stackName, type }>`; remover Sets paralelos (`secretVaults`, `lambdaConstructs`...) usando o tipo do registry |
| 3 | `parseStringRef` + `resolveRef` | Centralizar resolução; resolvers antigos viram wrappers; guards ad-hoc de ontem removidos em favor de `expectType` |
| 4 | Getters + interfaces `XxxRefs` | Todos os constructs com Outputs ganham getters; interfaces exportadas do core |
| 5 | Props `string \| Ref` | Atualizar interfaces de props; synth aceita ambos em todos os 23 call sites |
| 6 | Testes novos | Ref same-stack, Ref cross-stack via `ref()`, atributo inválido → erro claro, tipo errado com `expectType` → erro claro |
| 7 | Prompt | Preferir getters same-stack e `ref()` cross-stack; **remover** a "REGRA — referências são STRINGS" e regras conexas |
| 8 | Golden update | Se algum golden mudar, investigar — o objetivo é template IDÊNTICO; mudança = bug no refactor |

Passos 1–3 são o coração (mecanismo). 4–5 são a ergonomia. 7 é a colheita (prompt menor = geração melhor).

## 4. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| `validateNoNullValues`/diagram encontrando objetos `Ref` em props | `isRef()` guard nesses walkers antes do passo 5 |
| Projetos de usuário com `@iacmp/core` antigo (strings) | Strings continuam funcionando — nada deprecado nesta fase |
| Tabela `CONSTRUCT_ATTRIBUTES` incompleta → erro falso em synth | Passo 1 deriva a tabela dos Outputs REAIS que o synth exporta hoje (grep nos `outputs[...]` de `cloudformation.ts`) |
| IA gerando mistura de getter + string | OK por design — os dois caminhos convergem em `resolveRef` |
| Regressão silenciosa de template | Goldens + 109 testes a cada passo |

## 5. Fora de escopo (fica para P2/P3)

- Tipar `BaseConstruct.props` com generics (hoje `Record<string, unknown>`) — mexe em todos os módulos do synth; fazer junto com o registry único (P2)
- Deprecar strings — só depois do prompt migrado e de um ciclo de bateria com a forma nova
- Grafo intermediário (P3) — `resolveRef` centralizado é pré-requisito dele
