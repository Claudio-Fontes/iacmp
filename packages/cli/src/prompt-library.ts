export interface PromptEntry {
  id: string;
  title: string;
  category: string;
  description: string;
  prompt: string;
}

export const PROMPT_LIBRARY: PromptEntry[] = [
  {
    id: '01-react-crud-rds',
    title: 'App React CRUD + RDS PostgreSQL + CloudFront',
    category: 'Fullstack',
    description: 'Aplicação React completa com backend CRUD, RDS PostgreSQL (free tier), VPC e CloudFront.',
    prompt: `Crie uma infraestrutura completa na AWS para uma aplicação web CRUD (conta AWS free tier) com as seguintes características:

Frontend: aplicação React (SPA), servida via S3 + CloudFront com HTTPS

Backend: API REST com os métodos GET (listar todos), GET por ID, POST, PUT e DELETE — cada método em uma Lambda separada, todas dentro de uma VPC privada

Banco de dados: RDS PostgreSQL (db.t3.micro, instância única) em subnets privadas — SEM criptografia e SEM backup (free tier não suporta)

Rede:
- VPC com CIDR 10.0.0.0/16
- 2 subnets privadas em AZs diferentes (para o RDS e as Lambdas)
- Security Group para as Lambdas (egress liberado, sem ingress direto)
- Security Group para o RDS (ingress na porta 5432 apenas da VPC)

Segurança:
- Cada Lambda com Policy IAM mínima (só as actions necessárias)
- RDS com senha gerada automaticamente no Secrets Manager
- Lambdas acessam o secret via Policy IAM com secretsmanager:GetSecretValue
- CloudFront com HTTPS obrigatório (redirect-to-https)
- S3 privado, acesso só via CloudFront (OAC)

Alta disponibilidade:
- RDS em subnet group cobrindo 2 AZs
- Lambdas em múltiplas AZs (2 subnets)

Gere também os handlers Node.js (TypeScript) para cada Lambda com lógica real de conexão ao PostgreSQL via secret do Secrets Manager e operações CRUD na tabela items (campos: id, name, description, createdAt).

Free tier: na AWS o db.t3.micro entra nas 750h/mês do free tier (12 meses). No Azure o banco vira PostgreSQL Flexible Server B1ms (também 750h/mês em conta free) — adicione em warnings que subscriptions FREE TRIAL podem bloquear a criação em algumas regiões (LocationIsOfferRestricted) e que a região eastus costuma aceitar.`,
  },
  {
    id: '02-serverless-api-dynamodb',
    title: 'API Serverless com DynamoDB',
    category: 'Backend',
    description: 'API REST simples com Lambda, API Gateway e DynamoDB. Sem VPC, ideal para começar rápido.',
    prompt: `Crie uma API serverless na AWS com:

- API Gateway REST com as rotas: GET /items, GET /items/{id}, POST /items, PUT /items/{id}, DELETE /items/{id}
- Uma Lambda separada por método (ListItemsFn, GetItemFn, CreateItemFn, UpdateItemFn, DeleteItemFn)
- DynamoDB com partitionKey "id" (string), billingMode PAY_PER_REQUEST e pointInTimeRecovery habilitado
- Cada Lambda com Policy IAM mínima para as actions DynamoDB necessárias
- CORS habilitado na API

Gere os handlers TypeScript para cada Lambda com lógica real de acesso ao DynamoDB usando @aws-sdk/client-dynamodb.`,
  },
  {
    id: '03-sqs-worker',
    title: 'Worker de Fila SQS',
    category: 'Mensageria',
    description: 'Padrão produtor/consumidor com SQS e Lambda. Inclui DLQ para mensagens com falha.',
    prompt: `Crie uma infraestrutura de processamento assíncrono na AWS com:

- Fila SQS principal "TaskQueue" com visibilityTimeout de 60s e retentionPeriod de 4 dias
- Dead Letter Queue "TaskDLQ" com maxReceiveCount de 3 (mensagens que falharem 3 vezes vão para a DLQ)
- Lambda "TaskProcessorFn" acionada pela SQS com batchSize 10 e bisectBatchOnFunctionError habilitado
- Lambda "TaskProducerFn" para enviar mensagens à fila, exposta via API Gateway (POST /tasks)
- Policy IAM para cada Lambda com apenas as actions necessárias (sqs:SendMessage, sqs:ReceiveMessage, sqs:DeleteMessage)

Gere handlers TypeScript reais: o produtor envia um JSON com { taskId, type, payload } e o consumidor processa logando e simulando trabalho com um delay aleatório.`,
  },
  {
    id: '04-s3-upload-presigned',
    title: 'Upload de Arquivos com URL Assinada',
    category: 'Storage',
    description: 'API para upload direto ao S3 via presigned URL. Cliente faz upload sem passar pelo backend.',
    prompt: `Crie uma infraestrutura de upload de arquivos na AWS com:

- S3 Bucket "UploadsBucket" com versioning e CORS configurado (para upload direto do browser)
- Lambda "GetUploadUrlFn" que gera uma presigned URL para PUT no S3 (validade 5 minutos)
- Lambda "ListFilesFn" que lista os arquivos do bucket com metadados
- Lambda "DeleteFileFn" que remove um arquivo pelo key
- API Gateway REST: POST /upload-url, GET /files, DELETE /files/{key}
- Policy IAM para cada Lambda com as actions S3 mínimas necessárias

Gere os handlers TypeScript com lógica real usando @aws-sdk/client-s3 e @aws-sdk/s3-request-presigner.`,
  },
  {
    id: '05-scheduled-job',
    title: 'Cron Job / Tarefa Agendada',
    category: 'Automação',
    description: 'Lambda executada automaticamente em horários definidos via EventBridge Scheduler.',
    prompt: `Crie uma infraestrutura de tarefas agendadas na AWS com:

- Lambda "DailyReportFn" que gera um relatório diário (runtime nodejs20, timeout 120s, memory 256MB)
- Lambda "HourlyCleanupFn" que faz limpeza de dados expirados (runtime nodejs20, timeout 60s)
- EventBridge Rule para executar DailyReportFn todo dia às 08:00 UTC (cron: 0 8 * * ? *)
- EventBridge Rule para executar HourlyCleanupFn a cada hora (rate: 1 hour)
- DynamoDB "ReportsTable" onde os relatórios são salvos (partitionKey: reportId, sortKey: date)
- Policy IAM para cada Lambda com as actions necessárias

Gere os handlers TypeScript com lógica real: DailyReportFn escaneia a tabela, agrega dados e salva o relatório. HourlyCleanupFn deleta itens com TTL expirado.`,
  },
  {
    id: '06-static-website',
    title: 'Website Estático com CloudFront',
    category: 'Frontend',
    description: 'Hosting de site estático (React/Vue/HTML) no S3 com CloudFront e HTTPS.',
    prompt: `Crie uma infraestrutura para hospedar um site estático na AWS com:

- S3 Bucket PRIVADO (websiteHosting: false — o CloudFront serve o site via OAC, não via website hosting)
- CloudFront Distribution com:
  - HTTPS obrigatório (redirect-to-https)
  - S3 como origin via OAC (bucket privado, acesso só pelo CloudFront)
  - Cache padrão de 86400s (1 dia)
  - defaultRootObject: index.html
  - priceClass PriceClass_100 (EUA + Europa)
- S3 sem acesso público direto (só o CloudFront acessa via OAC)

IMPORTANTE: o bucket e o CloudFront (com bucketRef) devem estar na MESMA stack. websiteHosting e OAC são mutuamente exclusivos — para acesso privado via OAC, use websiteHosting: false.

Adicione um nextStep explicando como fazer o deploy do site: aws s3 sync build/ s3://BUCKET_NAME --delete seguido de aws cloudfront create-invalidation.`,
  },
  {
    id: '07-rds-postgres-api',
    title: 'API com RDS PostgreSQL em VPC',
    category: 'Backend',
    description: 'Backend Lambdas com RDS PostgreSQL em VPC privada, ideal para dados relacionais complexos.',
    prompt: `Crie uma infraestrutura de API com banco relacional na AWS com:

- VPC com CIDR 10.0.0.0/16 e 2 subnets privadas
- RDS PostgreSQL (db.t3.micro) em subnets privadas, senha no Secrets Manager (conta free tier: sem criptografia e sem backup)
- Security Group para Lambda e Security Group para RDS (ingress 5432 só do SG da Lambda)
- Lambdas dentro da VPC: ListUsersFn, GetUserFn, CreateUserFn, UpdateUserFn, DeleteUserFn
- API Gateway REST /users com rotas CRUD completas
- Policy IAM para acesso ao Secrets Manager em cada Lambda

Gere os handlers TypeScript com lógica real usando a biblioteca pg (node-postgres) para conectar ao PostgreSQL via connection string montada a partir do secret. Inclua criação da tabela users (id UUID, name, email, createdAt) no CreateUserFn se não existir.

Free tier: na AWS o db.t3.micro entra nas 750h/mês (12 meses). No Azure vira PostgreSQL Flexible Server B1ms — adicione em warnings que subscriptions FREE TRIAL podem bloquear a criação em algumas regiões (LocationIsOfferRestricted); a região eastus costuma aceitar.`,
  },
  {
    id: '08-data-pipeline-s3-lambda',
    title: 'Pipeline de Dados S3 → Lambda → DynamoDB',
    category: 'Dados',
    description: 'Pipeline que processa arquivos CSV/JSON depositados no S3 e persiste no DynamoDB.',
    prompt: `Crie uma infraestrutura de pipeline de dados na AWS com:

- S3 Bucket "RawDataBucket" onde arquivos de entrada são depositados
- Lambda "DataProcessorFn" acionada por eventos S3 (ObjectCreated), timeout 300s, memory 512MB
- DynamoDB "ProcessedDataTable" onde os dados processados são salvos (partitionKey: recordId, sortKey: source)
- S3 Bucket "ProcessedBucket" onde os arquivos processados são arquivados
- Policy IAM para a Lambda com s3:GetObject e s3:DeleteObject no RawDataBucket, s3:PutObject no ProcessedBucket e dynamodb:PutItem/BatchWriteItem

Gere o handler TypeScript que: lê o arquivo do S3, parseia como JSON (array de objetos), salva cada item no DynamoDB com batchWrite e move o arquivo original para o ProcessedBucket.`,
  },
  {
    id: '09-lambda-authorizer-jwt',
    title: 'API com Autenticação JWT (Lambda Authorizer)',
    category: 'Segurança',
    description: 'API Gateway com Lambda Authorizer customizado que valida tokens JWT.',
    prompt: `Crie uma infraestrutura de API com autenticação JWT na AWS com:

- Lambda "JwtAuthorizerFn" que valida o Bearer token no header Authorization e retorna a policy IAM allow/deny
- Lambda "GetProfileFn" protegida pelo authorizer (rota GET /profile)
- Lambda "UpdateProfileFn" protegida pelo authorizer (rota PUT /profile)
- Lambda "PublicHealthFn" sem autenticação (rota GET /health)
- API Gateway REST com authType NONE na rota /health e authorizerLambdaId nos demais
- Secret.Vault "JwtSecret" para armazenar a chave secreta JWT
- Policy IAM para a JwtAuthorizerFn com secretsmanager:GetSecretValue

Gere os handlers TypeScript: o authorizer usa a biblioteca jsonwebtoken para verificar o token com a chave do Secrets Manager. As rotas protegidas leem o userId do contexto do authorizer.

Free tier: na AWS o Secrets Manager tem trial de 30 dias e depois custa USD 0,40/secret/mês — adicione em warnings. No Azure o Key Vault é praticamente gratuito (USD 0,03/10 mil operações).`,
  },
  {
    id: '10-cloudwatch-monitoring',
    title: 'Monitoramento com CloudWatch e Alertas SNS',
    category: 'Monitoramento',
    description: 'Alarmes CloudWatch para erros de Lambda e latência de API, com notificação via SNS.',
    prompt: `Crie uma infraestrutura de monitoramento na AWS para uma aplicação existente com:

- SNS Topic "AlertsTopic" para receber todos os alertas
- Monitoring.Alarm para erros de Lambda: threshold 5 erros em 5 minutos, actions para o AlertsTopic
- Monitoring.Alarm para latência alta de API Gateway: threshold p99 > 3000ms em 5 minutos
- Monitoring.Alarm para DynamoDB com throttling: threshold > 0 em 1 minuto
- Lambda "AlertHandlerFn" subscrita ao AlertsTopic que formata e loga o alerta (pode ser estendida para Slack/email)
- Monitoring.Dashboard "AppDashboard" com widgets para: erros Lambda, latência API, leituras DynamoDB

Gere o handler TypeScript da AlertHandlerFn que parseia a mensagem SNS e loga o alerta estruturado com timestamp, tipo, métrica e valor.`,
  },
  {
    id: '11-step-functions-workflow',
    title: 'Workflow de Aprovação com Step Functions',
    category: 'Workflow',
    description: 'Processo de aprovação em múltiplas etapas com Step Functions, SQS e Lambda.',
    prompt: `Crie uma infraestrutura de workflow de aprovação na AWS com:

- Lambda "SubmitRequestFn" que inicia a execução do Step Functions (POST /requests)
- Lambda "ValidateRequestFn" que valida os dados da solicitação
- Lambda "NotifyApproverFn" que envia notificação ao aprovador via SQS
- Lambda "ProcessApprovalFn" que processa o resultado (aprovado/rejeitado) e salva no DynamoDB
- Workflow.StepFunctions com estados: Validate → NotifyApprover → WaitForApproval → ProcessResult
- DynamoDB "RequestsTable" para persistir o estado das solicitações
- SQS "ApprovalQueue" para comunicação com o aprovador
- API Gateway: POST /requests (iniciar), POST /requests/{id}/approve, POST /requests/{id}/reject

Gere todos os handlers TypeScript com lógica real de transição de estados e persistência.`,
  },
  {
    id: '12-multi-env-config',
    title: 'Configuração Multi-Ambiente com Secrets Manager',
    category: 'Configuração',
    description: 'Centralização de configurações e secrets por ambiente (dev/staging/prod) via Secrets Manager.',
    prompt: `Crie uma infraestrutura de gerenciamento de configuração por ambiente na AWS com:

- Secret.Vault "AppConfigDev" com description "Configurações do ambiente de desenvolvimento"
- Secret.Vault "AppConfigStaging" com description "Configurações do ambiente de staging"
- Secret.Vault "AppConfigProd" com rotationDays 30 e description "Configurações de produção"
- Lambda "GetConfigFn" que lê o secret correto baseado na variável de ambiente ENV (dev/staging/prod) e retorna as configs (sem expor secrets sensíveis)
- API Gateway GET /config?env=dev|staging|prod
- Policy IAM para a Lambda com secretsmanager:GetSecretValue e secretsmanager:ListSecrets

Gere o handler TypeScript que valida o ENV, busca o secret correto e retorna apenas as keys não-sensíveis (remove password, token, key das responses).

Free tier: na AWS são 3 secrets × USD 0,40/mês após o trial de 30 dias (~USD 1,20/mês) — adicione em warnings. No Azure o Key Vault é praticamente gratuito.`,
  },
  {
    id: '13-url-shortener',
    title: 'Encurtador de URL',
    category: 'Backend',
    description: 'Encurtador de URLs com redirect 301, contagem de cliques e expiração. 100% free tier nas duas nuvens.',
    prompt: `Crie uma infraestrutura de encurtador de URL na AWS com:

- DynamoDB "LinksTable" (partitionKey: slug, tipo string) com os campos: slug, targetUrl, clicks, createdAt, expiresAt
- Lambda "CreateLinkFn": POST /links recebe { targetUrl, slug opcional } — se o slug não vier, gera um código curto aleatório de 7 caracteres; grava com ConditionExpression attribute_not_exists(slug) e retorna 409 se o slug já existir
- Lambda "RedirectFn": GET /{slug} busca o link, incrementa o contador clicks com UpdateCommand (ADD clicks :one) e retorna 301 com o header Location apontando para targetUrl; retorna 404 se não existir ou estiver expirado
- Lambda "StatsFn": GET /links/{slug}/stats retorna slug, targetUrl, clicks e createdAt
- API Gateway com as 3 rotas
- Policy IAM mínima por Lambda (GetItem, PutItem, UpdateItem — apenas o que cada handler usa)

Gere os handlers TypeScript com DynamoDBDocumentClient. O redirect retorna statusCode 301 com headers { Location: targetUrl } e body vazio.`,
  },
  {
    id: '14-waitlist-double-optin',
    title: 'Lista de Espera com Confirmação (Double Opt-in)',
    category: 'Backend',
    description: 'Inscrição em lista de espera com token de confirmação e limpeza de inscrições pendentes.',
    prompt: `Crie uma infraestrutura de lista de espera com confirmação em duas etapas na AWS com:

- DynamoDB "WaitlistTable" (partitionKey: email, tipo string) com os campos: email, status (pending|confirmed), token, createdAt
- Lambda "SubscribeFn": POST /subscribe recebe { email }, valida o formato do e-mail, gera um token com crypto.randomUUID() e grava com status "pending"; se o e-mail já estiver confirmado retorna 409
- Lambda "ConfirmFn": GET /confirm?email=...&token=... valida o token e muda o status para "confirmed" com ConditionExpression (o token tem que bater); token inválido retorna 403
- Lambda "CleanupFn": remove inscrições "pending" com mais de 48h usando Scan + FilterExpression (atenção: status é palavra reservada no DynamoDB — use alias #status) e BatchWrite de deletes
- EventBridge Rule executando CleanupFn a cada 6 horas (rate: 6 hours)
- API Gateway: POST /subscribe e GET /confirm
- Policy IAM mínima por Lambda

Gere os handlers TypeScript com DynamoDBDocumentClient e validação real de e-mail (regex simples).`,
  },
  {
    id: '15-webhook-receiver',
    title: 'Receptor de Webhooks com Assinatura HMAC',
    category: 'Integração',
    description: 'Endpoint que recebe webhooks externos, valida a assinatura HMAC e processa de forma assíncrona via fila.',
    prompt: `Crie uma infraestrutura de recepção de webhooks na AWS com:

- Secret.Vault "WebhookSecret" com a chave HMAC compartilhada com o emissor dos webhooks
- Lambda "ReceiverFn": POST /webhooks — valida a assinatura HMAC-SHA256 do body contra o header X-Signature usando a chave do secret (crypto.createHmac + timingSafeEqual); assinatura inválida retorna 401; válida → envia o payload para a fila e responde 202 imediatamente
- Fila SQS "WebhookQueue" com visibilityTimeout 60s e Dead Letter Queue "WebhookDLQ" (maxReceiveCount 3)
- Lambda "ProcessorFn" consumindo a fila (batchSize 10) que processa cada evento e persiste no DynamoDB
- DynamoDB "WebhookEventsTable" (partitionKey: eventId, tipo string) com campos: eventId, type, payload, receivedAt
- Policy IAM mínima por Lambda (o receiver precisa de secretsmanager:GetSecretValue e sqs:SendMessage; o processor das actions de consumo da fila e dynamodb:PutItem)

Gere os handlers TypeScript com lógica real de HMAC. O eventId vem do payload ou é gerado com crypto.randomUUID().

Free tier: tudo gratuito nas duas nuvens; o único custo é 1 secret na AWS (USD 0,40/mês após o trial de 30 dias — Key Vault no Azure é grátis). Adicione em warnings.`,
  },
  {
    id: '16-event-counter-analytics',
    title: 'Telemetria com Contadores Atômicos',
    category: 'Dados',
    description: 'API de ingestão de eventos com contadores atômicos por tipo e por dia, e endpoint de estatísticas.',
    prompt: `Crie uma infraestrutura de telemetria leve na AWS com:

- DynamoDB "CountersTable" (partitionKey: counterKey, tipo string) onde counterKey é a composição "<eventType>#<YYYY-MM-DD>" e o campo total é numérico
- Lambda "TrackFn": POST /track recebe { eventType } (ex: page_view, signup, click), monta a counterKey com a data UTC de hoje e incrementa com UpdateCommand ADD total :one (contador atômico — cria o item automaticamente se não existir)
- Lambda "StatsFn": GET /stats?eventType=...&days=7 retorna a série dos últimos N dias fazendo BatchGet das counterKeys calculadas (uma por dia) — sem Scan e sem GSI
- API Gateway com as 2 rotas e CORS habilitado (o track é chamado de browsers)
- Policy IAM mínima por Lambda

Gere os handlers TypeScript com DynamoDBDocumentClient. O StatsFn preenche com 0 os dias sem contador e retorna { eventType, series: [{ date, total }] }.`,
  },
  {
    id: '17-scheduled-backup-s3',
    title: 'Backup Agendado DynamoDB → S3',
    category: 'Automação',
    description: 'Export diário de uma tabela DynamoDB para S3 em JSON particionado por data, com retenção limitada.',
    prompt: `Crie uma infraestrutura de backup agendado na AWS com:

- DynamoDB "ItemsTable" (partitionKey: id, tipo string) — a tabela de dados da aplicação
- Lambda "SeedFn": POST /items insere um item (id via crypto.randomUUID(), name, value) — serve para popular a tabela e testar o fluxo
- Lambda "BackupFn" (timeout 300s, memory 512MB): escaneia a ItemsTable com paginação (LastEvaluatedKey) e grava um único arquivo JSON no bucket com a key backups/YYYY/MM/DD/items.json
- S3 Bucket "BackupsBucket" privado com versioning
- Lambda "RetentionFn": lista os objetos de backups/ e apaga os com mais de 30 dias (ListObjectsV2 + DeleteObjects)
- EventBridge Rule executando BackupFn todo dia às 03:00 UTC (cron: 0 3 * * ? *) e RetentionFn todo domingo às 04:00 UTC (cron: 0 4 ? * 1 *)
- API Gateway: POST /items
- Policy IAM mínima por Lambda (scan na tabela; put/list/delete no bucket — cada handler só o que usa)

Gere os handlers TypeScript com paginação real no Scan e @aws-sdk/client-s3 no backup.`,
  },
  {
    id: '18-uptime-monitor',
    title: 'Monitor de Disponibilidade (Uptime)',
    category: 'Monitoramento',
    description: 'Health checks agendados de URLs externas com histórico e alarme quando um site cai.',
    prompt: `Crie uma infraestrutura de monitoramento de disponibilidade na AWS com:

- DynamoDB "ChecksTable" (partitionKey: url, tipo string) com os campos: url, lastStatus, lastLatencyMs, lastCheckedAt, consecutiveFailures
- Lambda "CheckerFn" (timeout 60s): faz fetch com timeout de 10s numa lista fixa de URLs definida na env var TARGET_URLS (separadas por vírgula), mede a latência, grava o resultado na tabela e LANÇA UM ERRO ao final se alguma URL retornou status >= 400 ou estourou o timeout (o erro alimenta a métrica de Errors da Lambda)
- EventBridge Rule executando CheckerFn a cada 5 minutos (rate: 5 minutes)
- Monitoring.Alarm "SiteDownAlarm" sobre a métrica Errors da CheckerFn: threshold 1 erro em 5 minutos
- Lambda "StatusFn": GET /status retorna o snapshot de todas as URLs monitoradas (Scan na tabela)
- API Gateway: GET /status
- Policy IAM mínima por Lambda

Gere os handlers TypeScript. O CheckerFn usa fetch nativo do Node 20 com AbortController para o timeout e Promise.allSettled para checar as URLs em paralelo.`,
  },
  {
    id: '19-feature-flags',
    title: 'Feature Flags Multi-Ambiente',
    category: 'Configuração',
    description: 'Serviço de feature flags por ambiente com API de leitura pública e administração protegida.',
    prompt: `Crie uma infraestrutura de feature flags na AWS com:

- DynamoDB "FlagsTable" (partitionKey: flagKey, tipo string) onde flagKey é a composição "<env>#<flagName>" e os campos são: enabled (boolean), rolloutPercent (0-100), description, updatedAt
- Lambda "GetFlagsFn": GET /flags?env=dev|staging|prod retorna todas as flags do ambiente via Scan + FilterExpression begins_with(flagKey, :envPrefix) — valida o env e retorna 400 para valores inválidos
- Lambda "SetFlagFn": PUT /flags/{env}/{name} recebe { enabled, rolloutPercent, description } e faz upsert; exige o header X-Admin-Token igual ao valor do secret
- Secret.Vault "AdminToken" com o token de administração
- API Gateway com as 2 rotas e CORS habilitado
- Policy IAM mínima por Lambda (o SetFlagFn precisa de secretsmanager:GetSecretValue)

Gere os handlers TypeScript com DynamoDBDocumentClient. O GetFlagsFn responde { env, flags: { nome: { enabled, rolloutPercent } } } — formato pronto para o cliente consumir.

Free tier: tudo gratuito nas duas nuvens; único custo é 1 secret na AWS (USD 0,40/mês pós-trial — Key Vault no Azure é grátis).`,
  },
  {
    id: '20-leaderboard-api',
    title: 'Leaderboard de Pontuação',
    category: 'Dados',
    description: 'Ranking de jogadores com envio de pontuação e top 10, portável entre as duas nuvens (sem GSI).',
    prompt: `Crie uma infraestrutura de leaderboard na AWS com:

- DynamoDB "ScoresTable" (partitionKey: playerId, tipo string) com os campos: playerId, playerName, bestScore (numérico), gamesPlayed, updatedAt
- Lambda "SubmitScoreFn": POST /scores recebe { playerId, playerName, score } — atualiza bestScore APENAS se o novo score for maior (UpdateCommand com ConditionExpression score > bestScore, tratando ConditionalCheckFailedException como "não superou o recorde") e sempre incrementa gamesPlayed com ADD
- Lambda "TopScoresFn": GET /leaderboard retorna o top 10 fazendo Scan na tabela e ordenando por bestScore no handler (NÃO use GSI nem IndexName — a ordenação é feita em memória, o que mantém o cenário portável entre as nuvens)
- Lambda "PlayerFn": GET /players/{playerId} retorna o registro do jogador (404 se não existir)
- API Gateway com as 3 rotas e CORS habilitado
- Policy IAM mínima por Lambda

Gere os handlers TypeScript com DynamoDBDocumentClient. Atenção: "score" pode colidir com palavras reservadas — use ExpressionAttributeNames com alias em todas as expressions.`,
  },];

export const CATEGORIES = [...new Set(PROMPT_LIBRARY.map(p => p.category))];
