---
layout: home

hero:
  name: iacmp
  text: Um código. Três nuvens.
  tagline: Descreva a infraestrutura que você precisa — receba constructs TypeScript que viram CloudFormation, Bicep e Terraform, com deploy real, diff, auditorias e diagramas num único CLI.
  image:
    src: /logo.svg
    alt: iacmp
  actions:
    - theme: brand
      text: Comece em 5 minutos
      link: /pt/guide/getting-started
    - theme: alt
      text: Use com Claude Code
      link: /pt/guide/claude-code
    - theme: alt
      text: GitHub
      link: https://github.com/Claudio-Fontes/iacmp

features:
  - icon: ☁️
    title: Um construct, três nuvens
    details: Database.SQL vira RDS na AWS, PostgreSQL Flexible Server na Azure e Cloud SQL no GCP — com rede, senha e SSL corretos em cada uma.
  - icon: ✅
    title: Validado por deploys reais
    details: Cada provider passou por 20 cenários end-to-end (deploy → teste em runtime → destroy) em contas reais de AWS, Azure e GCP — não só synth.
  - icon: 🛡️
    title: Guardas no synth
    details: Mais de uma dúzia de validações pegam, em segundos, erros que custariam um deploy — env var faltando, Lambda em VPC sem endpoint, SQL sem SSL, GSI não declarado.
  - icon: 🤖
    title: Claude Code de fábrica
    details: iacmp setup registra um servidor MCP embutido — seu agente escreve stacks, sintetiza e faz deploy por ferramentas estruturadas, tudo local.
---

## 30 segundos de iacmp

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

```bash
iacmp synth --provider aws      # → CloudFormation
iacmp synth --provider azure    # → Bicep
iacmp synth --provider gcp      # → Terraform (tf.json)
iacmp deploy                    # deploy de verdade, na sua conta
```
