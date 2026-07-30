# Comece em 5 minutos

Do zero a uma API serverless validada e pronta pra deploy. Você só precisa de **Node.js 20+**.

## 1. Instale

```bash
npm install -g iacmp
```

Confira se funcionou:

```bash
iacmp --version
```

::: tip Comando não encontrado?
O instalador cria um atalho do `iacmp` no seu PATH para uso imediato. Se o shell ainda não encontrar, abra um novo terminal. Ainda nada? Diagnostique com:

```bash
npx iacmp doctor
```
:::

## 2. Crie um projeto

```bash
iacmp init minha-api --template serverless
cd minha-api
```

Isso gera um projeto completo e funcional:

```
minha-api/
  iacmp.json          # provider, região, linguagem
  stacks/             # sua infraestrutura, uma stack por domínio
  src/handlers/       # handlers TypeScript (agnósticos de nuvem)
  CLAUDE.md           # guia agentes de IA pelo fluxo certo
```

Quer ver os outros templates (blank, hello, rds, webapp, network, serverless, fullstack)?

```bash
iacmp init --list
```

## 3. Veja o que você ganhou

Uma stack é TypeScript puro — sem YAML, sem HCL:

```typescript
import { Stack, Fn, Database, ref } from '@iacmp/core';

const stack = new Stack('ApiStack');

new Database.DynamoDB(stack, 'ItemsTable', { partitionKey: 'id' });

new Fn.Lambda(stack, 'ItemsFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/handlers/items',
  environment: { TABLE_NAME: ref('ItemsTable', 'Name') },
});

export default stack;
```

Os handlers usam a fachada agnóstica [`@iacmp/runtime`](https://www.npmjs.com/package/@iacmp/runtime) — o mesmo código roda em Lambda, Azure Functions e Cloud Functions:

```typescript
import { table } from '@iacmp/runtime';

export async function handler() {
  const items = await table('ItemsTable').scan();
  return { statusCode: 200, body: JSON.stringify(items) };
}
```

## 4. Sintetize

```bash
iacmp synth
```

Isso compila suas stacks para o formato nativo do provider configurado (CloudFormation por padrão) **e valida** — tanto com as checagens semânticas do próprio iacmp quanto com o validador da nuvem, quando o CLI dela está configurado:

```
✔ ApiStack → out/aws/api-stack.json
  CFN validate OK: api-stack
```

Experimente as outras nuvens a partir do mesmo código:

```bash
iacmp synth --provider azure    # → Bicep
iacmp synth --provider gcp      # → Terraform (tf.json)
```

## 5. Faça o deploy (opcional, mas é a parte boa)

Você precisa do CLI da nuvem-alvo configurado — para AWS:

```bash
aws configure        # access key, secret, região
iacmp doctor         # confere se está tudo no lugar
```

Depois:

```bash
iacmp deploy --dry-run    # mostra exatamente o que seria criado
iacmp deploy              # deploy de verdade (pede confirmação)
```

Quando terminar de experimentar:

```bash
iacmp destroy             # remove tudo (pede confirmação)
```

## 6. Explore

```bash
iacmp diagram             # diagrama C4 da arquitetura a partir das stacks
iacmp audit-all           # auditorias de segurança, alta disponibilidade e DR
iacmp diff                # o que mudaria no próximo deploy
```

## Idioma

O CLI fala inglês (padrão) e português:

```bash
IACMP_LANG=pt iacmp synth      # pontual
export IACMP_LANG=pt           # de vez, no perfil do seu shell
```

## Próximo passo

Deixe um agente de IA escrever por você: [use o iacmp com Claude Code](/pt/guide/claude-code).
