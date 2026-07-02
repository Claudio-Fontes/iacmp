# Plano P2: registry único por tipo de construct

> Item P2 do [estudo-arquitetura-multicloud.md](estudo-arquitetura-multicloud.md). Hoje cada tipo de construct existe em 4 registries desconectados: o case do synth, o `TYPE_META`/`PROVIDER_TECH_OVERRIDE` do diagrama (`cli/src/diagram/builder.ts`), o `ANCHOR_LAYER` do validate (`core/src/validate.ts:334`) e a doc do system-prompt. Adicionar `Messaging.Stream` exigiu tocar os 4 — e nada avisa quando falta um.

**Objetivo: uma fonte de verdade em `@iacmp/core`; os demais derivam. Esquecer = erro de compilação.**

## Design (interface-first)

### `core/src/construct-types.ts`

```ts
/** União fechada de todos os tipos de construct. */
export type ConstructType = 'Compute.Instance' | 'Compute.AutoScaling' | /* ...35 tipos... */ 'Custom.Resource';

export type AnchorLayer = 'network' | 'database' | 'compute' | 'storage' | 'security' | 'cache' | 'messaging';

export interface DiagramMeta {
  emoji: string;
  technology: string;                                   // genérico
  techByProvider?: Partial<Record<'aws' | 'azure' | 'gcp', string>>;  // override
}

export interface ConstructTypeInfo {
  /** Camada âncora p/ validateSemantics (null = não é âncora). */
  layer: AnchorLayer | null;
  diagram: DiagramMeta;
  /** Atributos referenciáveis (absorve CONSTRUCT_ATTRIBUTES de refs.ts). */
  attributes: ReadonlyArray<string>;
}

export const CONSTRUCT_TYPES: Record<ConstructType, ConstructTypeInfo> = { ... } satisfies ...;
```

`Record<ConstructType, ConstructTypeInfo>` garante: tipo novo na união sem entrada no registry = **erro de compilação**.

### Derivações

1. **`core/src/validate.ts`** — `ANCHOR_LAYER` derivado de `CONSTRUCT_TYPES` (entries com `layer !== null`). Manter o alias legado `'Fn.Lambda'` que existe hoje.
2. **`cli/src/diagram/builder.ts`** — `TYPE_META` e `PROVIDER_TECH_OVERRIDE` derivados de `CONSTRUCT_TYPES[t].diagram`.
3. **`core/src/refs.ts`** — `CONSTRUCT_ATTRIBUTES` passa a ser derivado de `CONSTRUCT_TYPES[t].attributes` (export mantido para compat; `ConstructAttributeMap` continua como interface de tipos).
4. **`providers/aws`** — completude do synth garantida por TESTE de cobertura: para cada `ConstructType`, `synthesize()` de uma stack com aquele construct não cai no warn "construct desconhecido" (exceto lista explícita de não-suportados, se houver). Não dá para inverter a dependência (core não pode importar synth AWS), então a garantia aqui é test-time, não compile-time.

### Fora de escopo
- Gerar o system-prompt a partir do registry — a doc do prompt é prosa rica (regras, exemplos, handlers); derivá-la é projeto próprio. O registry ganha o campo estrutural agora; a geração fica para depois do P3.
- Mudar qualquer comportamento: diagrama, validate e synth devem produzir **saída idêntica** (testes + goldens são o juiz).

## Passos
1. `construct-types.ts` com a união + registry completo (derivar conteúdo dos 3 registries atuais; em conflito, o comportamento atual vence)
2. Derivar `ANCHOR_LAYER` (validate), `TYPE_META`/`PROVIDER_TECH_OVERRIDE` (diagram), `CONSTRUCT_ATTRIBUTES` (refs)
3. Teste de cobertura do synth AWS por tipo
4. Suites completas verdes (core, cli, providers/aws 115, ai 324) + goldens byte-idênticos
