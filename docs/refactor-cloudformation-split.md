# Refactor: quebrar cloudformation.ts em módulos por domínio

**Motivação:** o arquivo `packages/providers/aws/src/synth/cloudformation.ts` chegou a 2828 linhas, misturando tipos, resolvers, síntese de 35 constructs distintos e orquestração. Difícil de navegar e de manter.

---

## Estrutura alvo

```
packages/providers/aws/src/synth/
  types.ts          — CloudFormationResource, CloudFormationTemplate, SynthContext
  resolvers.ts      — todos os resolve*() + requireLambda + resolveLambdaRole
  validation.ts     — validateResourceReferences, validateNoNullValues, collectReferencedLogicalIds
  constructs/
    compute.ts      — Compute.Instance, AutoScaling, Container, Kubernetes        (~200 linhas)
    network.ts      — Network.VPC, Subnet, VpcEndpoint, SecurityGroup, WAF,
                      LoadBalancer, CDN, DNS + synthesizeVPCChildren              (~420 linhas)
    storage.ts      — Storage.Bucket, FileSystem, Archive                         (~160 linhas)
    database.ts     — Database.SQL, DocumentDB, DynamoDB + Cache.Redis,
                      Memcached + Secret.Vault + Certificate.TLS                  (~350 linhas)
    function.ts     — Function.Lambda, ApiGateway + Policy.IAM                   (~440 linhas)
    messaging.ts    — Messaging.Stream, Queue, Topic + Events.EventBridge         (~230 linhas)
    workflow.ts     — Workflow.StepFunctions                                      (~100 linhas)
    monitoring.ts   — Monitoring.Alarm, Dashboard + Logging.Stream + Custom.Resource (~90 linhas)
  cloudformation.ts — synthesize() + dispatcher synthesizeConstruct               (~150 linhas)
```

## Árvore de dependências (sem ciclos)

```
types.ts  ←  resolvers.ts  ←  constructs/*.ts  ←  cloudformation.ts
              validation.ts ←  cloudformation.ts
```

---

## Passos

Executar em ordem. Rodar `npm run test --workspace=packages/providers/aws` após cada passo — 100 testes devem ficar verdes o tempo todo. **Nunca mudar lógica: mover código é o único objetivo.**

### Passo 1 — `types.ts`
Mover: `CloudFormationResource`, `CloudFormationTemplate`, `SynthContext`, `INSTANCE_TYPE_MAP`.
`cloudformation.ts` importa de `./types`.
Risco: zero — só tipos.

### Passo 2 — `resolvers.ts`
Mover: `resolveLambdaArnRef`, `requireLambda`, `buildInvocationUri`, `resolveLambdaRole`, `defaultServiceRole`, `resolveVpcId`, `resolveSubnetId`, `resolveSecurityGroupId`, `normalizeRate`, `resolveQueueArn`, `resolvePolicyResource`, `resolveEnvVarValue`, `resolveAlarmAction`, `alarmActionsBlock`, `resolveTargetGroupArn`.
Todos exportados; `cloudformation.ts` importa de `./resolvers`.
Risco: baixo — sem mudança de lógica.

### Passo 3 — `validation.ts`
Mover: `CFN_PSEUDO_PARAMETERS`, `collectReferencedLogicalIds`, `validateResourceReferences`, `validateNoNullValues`.
Risco: zero.

### Passo 4 — `constructs/monitoring.ts`
Cases: `Monitoring.Alarm`, `Monitoring.Dashboard`, `Logging.Stream`, `Custom.Resource`.
Aquece o padrão de extração com o menor arquivo.
**Rodar testes.**

### Passo 5 — `constructs/workflow.ts`
Case: `Workflow.StepFunctions`.
**Rodar testes.**

### Passo 6 — `constructs/messaging.ts`
Cases: `Messaging.Stream`, `Messaging.Queue`, `Messaging.Topic`, `Events.EventBridge`.
**Rodar testes.**

### Passo 7 — `constructs/storage.ts`
Cases: `Storage.Bucket`, `Storage.FileSystem`, `Storage.Archive`.
**Rodar testes.**

### Passo 8 — `constructs/database.ts`
Cases: `Database.SQL`, `Database.DocumentDB`, `Database.DynamoDB`, `Cache.Redis`, `Cache.Memcached`, `Secret.Vault`, `Certificate.TLS`.
**Rodar testes.**

### Passo 9 — `constructs/compute.ts`
Cases: `Compute.Instance`, `Compute.AutoScaling`, `Compute.Container`, `Compute.Kubernetes`.
**Rodar testes.**

### Passo 10 — `constructs/network.ts`
Cases: todos `Network.*` + `synthesizeVPCChildren` (usada internamente).
Maior risco — mais interdependências (IGW, route tables, subnets públicas).
**Rodar testes.**

### Passo 11 — `constructs/function.ts`
Cases: `Function.Lambda`, `Function.ApiGateway`, `Policy.IAM`.
Maior arquivo, mais resolver-calls.
**Rodar testes.**

### Passo 12 — slim down `cloudformation.ts`
Fica só: imports + `synthesizeConstruct` (dispatcher ~40 linhas) + `synthesize()`.
Resultado esperado: ~150 linhas.
**Rodar testes → 100/100.**
**Commit único:** `refactor: quebrar cloudformation.ts em módulos por domínio`

---

## Padrão de cada constructs/*.ts

```ts
// constructs/monitoring.ts
import { BaseConstruct } from '@iacmp/core';
import type { CloudFormationResource, SynthContext } from '../types';
import { resolveAlarmAction, alarmActionsBlock } from '../resolvers';

export function synthMonitoring(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> | null {
  const props = construct.props as Record<string, unknown>;
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  switch (construct.type) {
    case 'Monitoring.Alarm': { /* ... */ return []; }
    case 'Monitoring.Dashboard': { /* ... */ return []; }
    case 'Logging.Stream': { /* ... */ return []; }
    case 'Custom.Resource': { /* ... */ return []; }
    default: return null;
  }
}
```

`synthesizeConstruct` em `cloudformation.ts` vira um dispatcher:

```ts
function synthesizeConstruct(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> {
  return (
    synthCompute(construct, ctx) ??
    synthNetwork(construct, ctx) ??
    synthStorage(construct, ctx) ??
    synthDatabase(construct, ctx) ??
    synthFunction(construct, ctx) ??
    synthMessaging(construct, ctx) ??
    synthWorkflow(construct, ctx) ??
    synthMonitoring(construct, ctx) ??
    (console.warn(`[aws] construct desconhecido: ${construct.type}`), [])
  );
}
```

---

## Regras durante a execução

- Nunca mudar lógica — mover código é o único objetivo de cada passo
- Um commit por passo depois dos testes verdes
- Se um passo travar, parar e investigar antes de continuar
- Não mexer nos testes — eles validam o refactor automaticamente
