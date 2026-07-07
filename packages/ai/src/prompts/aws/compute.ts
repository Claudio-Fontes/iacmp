export const COMPUTE_AWS = `
## Regras AWS — Compute (Lambda, API Gateway, ECS)

**Sempre gere também o arquivo de handler junto com cada \`Fn.Lambda\`** (não só a stack de infra):
- Caminho do arquivo: derive de \`handler: '<arquivo>.<export>'\` → gere \`src/<arquivo>.ts\` (ex: \`handler: 'saveMessage.handler'\` → arquivo \`src/saveMessage.ts\` exportando \`async function handler(...)\`). Isso compila para \`dist/<arquivo>.js\`, batendo com \`code: 'dist/'\`. NUNCA coloque o handler na raiz do projeto nem dentro de \`stacks/\` — só dentro de \`src/\`.
- **REGRA DE CONSISTÊNCIA OBRIGATÓRIA**: o nome antes do ponto em \`handler\` DEVE ser idêntico ao nome do arquivo \`src/\`. Se você cria \`src/seed.ts\`, o handler DEVE ser \`handler: 'seed.handler'\`. Se o handler é \`handler: 'seedMessages.handler'\`, o arquivo DEVE ser \`src/seedMessages.ts\`. Nunca deixe esses dois nomes divergirem — a Lambda vai falhar com \`Cannot find module\` no deploy real.
- **Priorize lógica real**: se o pedido do usuário descreve o que a função faz (ex: "salva a mensagem no DynamoDB", "chama a API da Anthropic e retorna a resposta"), implemente essa lógica de verdade.
  - Para serviços com API HTTP simples (ex: Anthropic, OpenAI, qualquer REST externo), use \`fetch\` nativo (disponível sem instalar nada no runtime \`nodejs18\`/\`nodejs20\`) em vez de instalar o SDK oficial do serviço — evita dependência extra que o iacmp não gerencia.
  - Para serviços da própria cloud que exigem assinatura de requisição (ex: DynamoDB, S3), use o SDK correspondente (\`@aws-sdk/client-dynamodb\`, etc.) — não dá pra assinar SigV4 só com \`fetch\`.
  - **Use SEMPRE o AWS SDK v3 (\`@aws-sdk/*\`), NUNCA o v2 (\`aws-sdk\`).** O runtime \`nodejs20\` provê o v3 embutido (imports \`@aws-sdk/*\` são externalizados no bundle); o pacote \`aws-sdk\` (v2) NÃO vem no runtime e ainda incha o bundle. Para S3 use \`@aws-sdk/client-s3\` com comandos: \`import { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'\`. NUNCA \`import { S3 } from 'aws-sdk'\` nem \`.promise()\` (padrão v2). Para ler o corpo de um objeto no v3: \`const r = await s3.send(new GetObjectCommand({...})); const body = await r.Body.transformToString();\`.
  - **Presigned URL do S3 (upload/download direto do browser) — SÓ a forma v3.** \`getSignedUrl\` recebe um COMMAND object (instanciado com \`new\`), NUNCA um objeto literal com os params diretos — o TypeScript ACEITA o objeto literal sem erro, mas falha em RUNTIME com "EndpointError: A region must be set". Import: \`import { getSignedUrl } from '@aws-sdk/s3-request-presigner';\` (avise no nextSteps que precisa desse pacote). Padrão EXATO:
\`\`\`typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
const s3 = new S3Client({ region: process.env.AWS_REGION });
const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key }), { expiresIn: 300 });
\`\`\`
    NUNCA \`getSignedUrl(s3, { Bucket, Key, ExpiresIn })\` — compila mas falha em runtime (EndpointError: region not set).
  - **Handler HTTP + strict null:** \`event.pathParameters\`, \`event.queryStringParameters\` e \`event.body\` podem ser null — SEMPRE use optional chaining + default: \`const id = event.pathParameters?.id ?? '';\` (sem isso o tsc do deploy falha com TS18047).
  - **DynamoDB — use SEMPRE o DocumentClient** (\`@aws-sdk/lib-dynamodb\`: \`DynamoDBDocumentClient\`, \`PutCommand\`, \`GetCommand\`, \`ScanCommand\`, \`DeleteCommand\`, \`QueryCommand\`), que aceita JSON simples (\`{ id: '1', name: 'x' }\`). Os imports EXATOS (o \`DynamoDBClient\` vem de OUTRO pacote — nunca de \`lib-dynamodb\`):
\`\`\`typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
\`\`\`
    NUNCA importe \`DynamoDBClient\`/\`GetItemCommand\` de \`@aws-sdk/lib-dynamodb\` (não existem lá → erro TS2305 e o build do deploy quebra), e NUNCA use o client low-level (\`PutItemCommand\` de \`@aws-sdk/client-dynamodb\`) com \`Item\` no formato tipado \`{ id: { S: '1' } }\` — misturar os dois formatos causa \`SerializationException: Unexpected value type\` em runtime. **MESMO QUE o usuário peça explicitamente \`@aws-sdk/client-dynamodb\` no prompt**, use sempre o DocumentClient — o resultado funcional é o mesmo e evita erros de serialização em runtime.
  - **DynamoDB CRUD:** use \`crypto.randomUUID()\` no create quando \`id\` ausente; update dinâmico via \`Object.entries(body)\` com \`ExpressionAttributeNames\`; DocumentClient sempre; \`headers: { 'Access-Control-Allow-Origin': '*' }\` em todas as respostas.
  - **ioredis — import nomeado.** Use SEMPRE \`import { Redis } from 'ioredis';\` e \`new Redis({ host, port })\`. NUNCA \`import Redis from 'ioredis'\` (default) nem \`import * as Redis from 'ioredis'\` — com os tipos do ioredis v5 isso dá \`TS2351: This expression is not constructable\` e o build do deploy quebra.
  - Avise em \`nextSteps\` quando alguma dependência precisar ser instalada via \`npm install\` e, se aplicável, quais variáveis de ambiente (ex: \`ANTHROPIC_API_KEY\`) precisam ser configuradas na Lambda após o deploy.
- **Nome físico dos recursos = construct ID**: o \`TableName\` de \`Database.DynamoDB(stack, 'ItemsTable', ...)\` na AWS será \`ItemsTable\` (igual ao construct ID). O mesmo vale para outros recursos com nome explícito no synth (SQS, SNS, etc.). Portanto, ao passar o nome do recurso como variável de ambiente da Lambda, use o mesmo string do construct ID como string literal — ex: \`environment: { TABLE_NAME: 'ItemsTable' }\`. NUNCA use \`{ Ref: ... } as any\`, \`Ref\` (capital R), \`Fn.ref()\`, \`Fn.GetAtt()\` nem qualquer variante inventada — nenhum desses existe no @iacmp/core e causam erros de TypeScript.

## Autenticação / login de usuários (OAuth2, Cognito, Auth0, SSO etc.)

O @iacmp/core não tem construct tipado para provedor de identidade (sem Cognito User Pool, sem Auth0, sem servidor OAuth próprio). O recurso tipado relacionado a auth é o \`authType\` do \`Fn.ApiGateway\`, que VALIDA tokens já emitidos por um provedor externo. Isso não significa beco sem saída: um User Pool Cognito real, por exemplo, pode ser criado de fato via \`Custom.Resource\` (\`AWS::Cognito::UserPool\` no CloudFormation / \`aws_cognito_user_pool\` no Terraform) — use esse caminho quando o usuário quiser o recurso provisionado, não apenas referenciado.

Quando o usuário pedir para "criar autenticação", "OAuth2", "login" ou similar:
1. NUNCA invente Lambdas customizadas para emitir/renovar/revogar tokens (ex: "OAuthTokenFn", "OAuthRefreshFn") simulando um servidor de identidade do zero — isso não é o papel do @iacmp/core e é uma escolha arquitetural grave que o usuário não pediu
2. NUNCA gere código nessa área sem primeiro perguntar qual provedor de identidade o usuário quer usar (Cognito, Auth0, Okta, Azure AD, etc.) — responda só com a pergunta, \`files\` vazio, até o usuário decidir
3. Se o usuário já decidiu o provedor e ele for Cognito, configure \`authType: 'COGNITO'\` no Fn.ApiGateway.
   Se o usuário quiser o User Pool de fato provisionado (não só referenciado), gere-o via \`Custom.Resource\` (veja seção de escape hatch) em vez de dizer que "precisa ser criado por fora"
4. Se o usuário quiser validação customizada própria (ex: "quero uma Lambda que valida o token") sem usar um provedor gerenciado, use \`authorizerLambdaId\` no Fn.ApiGateway apontando para uma \`Fn.Lambda\` — isso conecta de fato a Lambda ao gateway (Lambda Authorizer real, não uma Lambda solta sem ligação nenhuma).
   - NUNCA crie essa Lambda sem também setar \`authorizerLambdaId\` apontando para ela, MESMO QUE o Fn.ApiGateway já exista em outro arquivo/stack diferente do da Lambda. Criar a Lambda authorizer e a IAM Policy dela não é suficiente — o passo final OBRIGATÓRIO é editar o arquivo do Fn.ApiGateway (o arquivo que já existe, identificado em "Stacks existentes") incluindo \`authorizerLambdaId: '<id-da-lambda>'\` nas props. Se você gerar a Lambda authorizer sem incluir esse arquivo editado em \`files\`, a Lambda fica órfã (sem nenhuma seta/relacionamento no diagrama) e a autorização não funciona de verdade.
   - Antes de responder, confirme mentalmente: toda Lambda com nome/descrição de "authorizer" ou "auth" que você está gerando tem um Fn.ApiGateway em algum arquivo (novo ou já existente) referenciando o id dela em \`authorizerLambdaId\`? Se não, adicione esse arquivo à resposta.
5. Se o usuário insistir explicitamente que quer simular um servidor OAuth2 completo (emissão/renovação/revogação de tokens), só então gere as Lambdas correspondentes — mas deixe claro no \`explanation\` que é uma implementação própria, não um provedor gerenciado, e quais riscos isso implica (gestão de segredos, rotação de chaves, etc.)

## Padrão React CRUD com Aurora na AWS

Stacks: VPC (2 subnets privadas + LambdaSG + DBSG), database (Database.SQL com subnetIds/securityGroupIds), compute (Lambdas CRUD com vpcId/subnetIds/securityGroupIds + env vars de banco via \`ref()\`), network (ApiGateway), storage (S3 websiteHosting + CDN na mesma stack).

Regras-chave:
- DB_USER: SEMPRE \`ref('AppDB','Username')\` — NUNCA hardcode 'postgres'/'root'/'admin'
- DB_PASSWORD: \`process.env.DB_PASSWORD\` direto (synth injeta via \`{{resolve:secretsmanager}}\`) — NUNCA chame Secrets Manager SDK no handler (sem NAT → timeout)
- Handler com \`pg\`: use \`Pool\` (não \`Client\`), \`CREATE TABLE IF NOT EXISTS\` no cold start, \`ssl: { rejectUnauthorized: false }\`, params com \`$1,$2\`
- \`code: '.'\` para Lambdas com npm deps; \`handler: 'dist/<arquivo>.handler'\` para TypeScript compilado
- Gere \`frontend/.env\` com \`REACT_APP_API_URL=https://SEU_URL_AQUI\` + \`frontend/.env.example\`
`;
