export const COMPUTE_AZURE = `
## Regras Azure — Compute (Container Apps / Fn.Lambda no Azure)

### PROIBIDO em handlers Azure (causa "Region is missing" em runtime):
- \`import { DynamoDBClient } from '@aws-sdk/client-dynamodb'\`
- \`import { DynamoDBDocumentClient, ... } from '@aws-sdk/lib-dynamodb'\`
- \`import ... from 'aws-sdk'\`
- QUALQUER \`@aws-sdk/*\`

### Padrão de export do handler Azure (OBRIGATÓRIO):

O deploy iacmp para Azure Container Apps usa um adapter que chama \`await handler(event, {})\` e espera retorno \`{ statusCode, headers, body }\`.

**Handler direto (recomendado — sem Express):**
\`\`\`typescript
export async function handler(event: any) {
  const method = event.httpMethod;
  const id = (event.pathParameters?.id) ?? (event.path || '').split('/').filter(Boolean).pop();
  const body = event.body ? (typeof event.body === 'string' ? JSON.parse(event.body) : event.body) : {};
  if (method === 'GET' && !id) {
    // ...
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  }
  // ... outros casos ...
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
}
\`\`\`

**Se preferir Express — obrigatório serverless-http:**
\`\`\`typescript
import serverlessHttp from 'serverless-http';
// ... app = express() + rotas ...
export const handler = serverlessHttp(app);
// Adicionar 'serverless-http' no npm install dos nextSteps
\`\`\`

NUNCA: \`export const handler = app\` (Express app não é função Lambda e não retorna { statusCode, body }).

**env var NUNCA recebe \`process.env.X\` no código da STACK** — o valor é resolvido em synth-time; use string literal ou \`ref('Recurso','Attr')\`. \`process.env\` só existe DENTRO do handler (runtime), não na stack.
`;
