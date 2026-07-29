// CLAUDE.md gerado no projeto do usuário — orienta agentes de IA a usar o iacmp.

export function claudeMd(projectName: string): string {
  return `# iacmp — ${projectName}

> **REGRA ABSOLUTA:** Este projeto usa **exclusivamente o iacmp CLI** com constructs TypeScript do \`@iacmp/core\`.
> NUNCA pergunte "qual formato de IaC?", "Terraform ou CloudFormation?", "qual framework?".
> A resposta é sempre: **iacmp + TypeScript**. Vá direto à geração.
>
> **REGRA ABSOLUTA — Fn.Lambda:** \`code\` SEMPRE aponta para \`dist/handlers/<nome>\` (nunca \`src/\`).
> O Lambda executa JS compilado. \`src/\` tem TypeScript — não funciona na AWS nem na Azure.

## O que é iacmp

O iacmp CLI gera CloudFormation, Bicep ou Terraform a partir de stacks TypeScript usando \`@iacmp/core\`.
O único trabalho aqui é escrever arquivos \`stacks/**/*.ts\` e validar com \`iacmp synth\`.

## Fluxo de trabalho (OBRIGATÓRIO)

### Com ferramentas MCP do servidor \`iacmp\` disponíveis (modo preferido)

1. \`search_examples <palavras-chave>\` — busca exemplos validados
2. \`write_stack\` — escreve cada arquivo de stack no projeto
3. \`synth_project\` — valida; **nunca entregue sem synth verde**
4. Se falhar: corrija com \`write_stack\` e repita o synth até passar
5. Só depois mostre o resultado ao usuário

### Sem ferramentas MCP (fallback)

1. Escreva os arquivos diretamente com o tool \`Write\` em \`stacks/**/*.ts\`
2. Execute: \`iacmp synth\` via Bash para validar
3. Se falhar: leia o erro, corrija os arquivos e repita o synth
4. Só depois mostre o resultado ao usuário

O synth não é opcional em nenhum dos dois caminhos.

## Organização de stacks (OBRIGATÓRIO)

Cada camada em sua própria subpasta dentro de \`stacks/\`:

| Pasta | Constructs |
|---|---|
| \`stacks/compute/\` | \`Compute.*\`, \`Fn.Lambda\` |
| \`stacks/database/\` | \`Database.*\`, \`Cache.*\` |
| \`stacks/storage/\` | \`Storage.*\` |
| \`stacks/network/\` | \`Network.*\`, \`Fn.ApiGateway\` |
| \`stacks/messaging/\` | \`Messaging.*\`, \`Events.*\` |
| \`stacks/policy/\` | \`Policy.IAM\` |
| \`stacks/security/\` | \`Secret.*\`, \`Certificate.*\` |
| \`stacks/monitoring/\` | \`Monitoring.*\`, \`Logging.*\` |
| \`stacks/workflow/\` | \`Workflow.*\` |

## Regras de código

- Import único: \`import { Stack, ... } from '@iacmp/core';\`
- Inclua \`ref\` se usar \`ref()\`: \`import { Stack, Fn, ref } from '@iacmp/core';\`
- Sempre exporte a stack como default: \`export default stack;\`
- Nomes derivados do domínio do usuário — nunca copie nomes de exemplo
- Não invente propriedades que não existem no catálogo do @iacmp/core
- \`Database.DynamoDB\`: \`partitionKey\` e \`sortKey\` são **strings** (nome do atributo), nunca objetos
  - CORRETO: \`partitionKey: 'id'\`
  - ERRADO: \`partitionKey: { name: 'id', type: 'S' }\`  ← não existe essa forma

## Fn.ApiGateway — rotas (OBRIGATÓRIO)

Rotas **sempre** usam \`lambdaId\` (string com o id do construct) — **NUNCA** \`function: referência\`:

\`\`\`typescript
// CORRETO
new Fn.ApiGateway(stack, 'ProdutosApi', {
  name: 'produtos-api',
  type: 'HTTP',
  routes: [
    { method: 'POST',   path: '/produtos',     lambdaId: 'ProdutosFn' },
    { method: 'GET',    path: '/produtos',     lambdaId: 'ProdutosFn' },
    { method: 'GET',    path: '/produtos/{id}',lambdaId: 'ProdutosFn' },
    { method: 'PUT',    path: '/produtos/{id}',lambdaId: 'ProdutosFn' },
    { method: 'DELETE', path: '/produtos/{id}',lambdaId: 'ProdutosFn' },
  ],
});

// ERRADO — "function" não existe na interface
routes: [{ method: 'GET', path: '/x', function: minhaFn }]  // ← NUNCA faça isso
\`\`\`

## Referências cross-stack

**Padrão preferido — export tipado:**
\`\`\`typescript
// stacks/database/usuarios-table-stack.ts
export const table = new Database.DynamoDB(stack, 'UsuariosTable', { ... });

// stacks/compute/usuarios-lambda-stack.ts
import { table } from '../database/usuarios-table-stack';
environment: { TABLE_NAME: table.name }
resources: [table.arn]
\`\`\`

**Alternativa com ref() — quando não há import entre stacks:**
\`\`\`typescript
environment: { TABLE_NAME: ref('UsuariosTable', 'Name') }
resources:   [ref('UsuariosTable', 'Arn')]
\`\`\`

- \`ref()\` é um objeto interno — NUNCA chame \`.toString()\` nele
- \`environment\` com recurso: SEMPRE \`ref()\` ou \`table.name\` — nunca string literal

## Handlers Lambda (OBRIGATÓRIO quando houver Fn.Lambda)

Toda stack com \`Fn.Lambda\` exige:
1. Handler em \`src/handlers/<nome>/index.ts\` — código completo, nunca TODOs
2. Propriedade \`code: 'dist/handlers/<nome>'\` na stack (é o DESTINO do bundle que o deploy gera; o fonte fica em src/)

**Estrutura obrigatória:**
\`\`\`
src/handlers/<nome-da-lambda>/index.ts   ← escreva aqui
dist/handlers/<nome-da-lambda>/index.js  ← o DEPLOY gera via esbuild (não edite, não crie)
\`\`\`

**Na stack TypeScript:**
\`\`\`typescript
new Fn.Lambda(stack, 'MinhaFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/handlers/minha-fn',   // ← SEMPRE dist/, nunca src/
  ...
});
\`\`\`

**Para CRUD com DynamoDB** — gere sempre as 5 operações no mesmo arquivo:
\`\`\`typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME!;

export async function handler(event: any) {
  // HTTP API v2 usa requestContext.http.method; REST API v1 usa httpMethod
  const httpMethod = event.httpMethod ?? event.requestContext?.http?.method;
  const id = event.pathParameters?.id;
  const body = event.body ? JSON.parse(event.body) : {};

  switch (httpMethod) {
    case 'GET':    /* GetItem se id, Scan se não */ break;
    case 'POST':   /* PutItem com crypto.randomUUID() */ break;
    case 'PUT':    /* UpdateItem */ break;
    case 'DELETE': /* DeleteItem */ break;
    default: return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
}
\`\`\`

- ID gerado pelo backend: \`crypto.randomUUID()\` — nunca leia \`body.id\`
- Sempre use \`DynamoDBDocumentClient\` de \`@aws-sdk/lib-dynamodb\`
- Retorne sempre \`{ statusCode, body: JSON.stringify(...) }\`

## Empacotamento no deploy (NÃO rode build manual)

O \`iacmp deploy\` empacota os handlers sozinho, nas três nuvens: ele deriva o
fonte do \`code\` (\`dist/…\` → \`src/…\`) e roda esbuild direto no \`.ts\` — bundle
self-contained, sem passo manual. **NUNCA adicione \`npm run build\`/\`tsc\` ao
fluxo por causa das Lambdas.**

- Dependências npm que o handler importa (ex: \`pg\`, \`ioredis\`) são INLINADAS
  no bundle — basta \`npm install <dep>\` no projeto antes do deploy.
- Na AWS, \`@aws-sdk/*\` fica de fora do bundle de propósito (o runtime da
  Lambda já provê o SDK v3) — não precisa instalar.
- Código compartilhado em \`src/lib/\` entra no bundle de quem o importa.

\`\`\`bash
npm install pg         # só se o handler usar deps de terceiros
iacmp deploy --provider aws
\`\`\`

## Policy stack (OBRIGATÓRIO em todo projeto com Fn.Lambda)

Todo projeto com \`Fn.Lambda\` **deve** ter \`stacks/policy/<nome>-policy-stack.ts\` com \`Policy.IAM\`:

\`\`\`typescript
import { Stack, Policy } from '@iacmp/core';
import { produtosTable } from '../database/produtos-table-stack';

const stack = new Stack('ProdutosPolicyStack');

new Policy.IAM(stack, 'ProdutosPolicy', {
  attachTo: 'ProdutosFn',       // ← id do construct da Lambda (string)
  attachType: 'lambda',          // ← sempre 'lambda' para Fn.Lambda
  statements: [
    {
      effect: 'Allow',
      actions: [
        'dynamodb:GetItem', 'dynamodb:PutItem',
        'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Scan',
      ],
      resources: [produtosTable.arn],
    },
  ],
});

export default stack;
\`\`\`

- **NUNCA** use \`principal\` — não existe na interface. Use \`attachTo\` + \`attachType\`
- Para sub-resources (ex: objetos dentro de S3): use **string com o id do construct** — NUNCA concatene ref
  - CORRETO: \`resources: ['MeuBucket/*']\` — o synth resolve para \`<arn>/*\`
  - ERRADO: \`resources: [\\\`\${bucket.arn}/*\\\`]\` — concatenação de ref quebra no synth

Sem policy stack a Lambda não tem permissão para acessar outros serviços — **sempre crie**.

## Messaging.Queue — props corretas

\`\`\`typescript
import { Stack, Messaging } from '@iacmp/core';

const stack = new Stack('FilaStack');

const dlq = new Messaging.Queue(stack, 'MinhaDLQ', {
  messageRetentionSeconds: 345600,  // ← não é retentionPeriod
});

const queue = new Messaging.Queue(stack, 'MinhaFila', {
  visibilityTimeoutSeconds: 120,    // ← não é visibilityTimeout; deve ser >= timeout da Lambda
  messageRetentionSeconds: 345600,
  dlqArn: dlq.arn,                  // ← não é deadLetterQueue.queueId
  maxReceiveCount: 3,
});
\`\`\`

- URL da fila: \`queue.queueUrl\` (não \`queue.url\`)
- SQS/fila é **dual-cloud**: não há shim automático, mas é permitido — o handler ramifica por \`isAzure\` (\`@aws-sdk/client-sqs\` no path AWS, \`@azure/service-bus\` no Azure)

## Restrições

- NUNCA pergunte sobre formato de IaC, framework ou ferramenta — é sempre iacmp
- NUNCA use \`code: 'src/...\` em Fn.Lambda — **sempre** \`code: 'dist/handlers/<nome>'\`
- NUNCA use \`function: referência\` em rotas — **sempre** \`lambdaId: 'ConstructId'\`
- NUNCA use \`principal\` em Policy.IAM — **sempre** \`attachTo\` + \`attachType\`
- NUNCA concatene ref com string em \`resources\` — use string com id do construct (ex: \`'MeuBucket/*'\`)
- NUNCA modifique \`package.json\`, \`tsconfig.json\`, \`.env\` ou \`iacmp.json\`
- NUNCA use aws-cdk-lib, constructs ou qualquer pacote fora do @iacmp/core
- NUNCA deixe código incompleto (sem \`// TODO\` ou placeholders)
- Deploy e destroy: só quando o usuário pedir explicitamente
`;
}
