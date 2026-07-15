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
    id: '07-notification-system',
    title: 'Sistema de Notificações SNS + SQS',
    category: 'Mensageria',
    description: 'Padrão fan-out com SNS e múltiplas filas SQS para diferentes tipos de notificação.',
    prompt: `Crie uma infraestrutura de notificações na AWS com padrão fan-out:

- SNS Topic "NotificationsTopic" central
- SQS "EmailQueue" subscrita ao SNS para envio de emails (filterPolicy: type = "email")
- SQS "PushQueue" subscrita ao SNS para notificações push (filterPolicy: type = "push")
- SQS "AuditQueue" subscrita ao SNS sem filtro (recebe todos os tipos)
- Lambda "PublishNotificationFn" que publica no SNS, exposta via API Gateway POST /notifications
- Lambda "EmailProcessorFn" consumindo EmailQueue
- Lambda "PushProcessorFn" consumindo PushQueue
- Policies IAM mínimas para cada Lambda

Gere os handlers TypeScript. O publisher envia { type, userId, message, metadata } ao SNS. Os consumidores logam e simulam o processamento.

Free tier: na AWS, SNS+SQS são gratuitos (1M requisições/mês). No Azure, tópicos exigem Service Bus STANDARD (o tier Basic não tem topics) — custo base ~USD 10/mês cobrado por hora; adicione em warnings e recomende destruir após o teste.`,
  },
  {
    id: '08-api-with-cache-redis',
    title: 'API com Cache ElastiCache Redis',
    category: 'Backend',
    description: 'API que usa Redis para cache de resultados de queries caras, com TTL configurável.',
    prompt: `Crie uma infraestrutura de API com cache na AWS com:

- VPC com CIDR 10.0.0.0/16 e 2 subnets privadas em AZs diferentes
- ElastiCache Redis (cache.t3.micro) com replicationGroup de 1 nó em subnet privada
- Security Group para Lambda (egress liberado)
- Security Group para Redis (ingress na porta 6379 apenas do SG da Lambda)
- Lambda "GetProductsFn" dentro da VPC que: tenta buscar do cache Redis, se miss busca do DynamoDB e salva no cache com TTL de 300s
- DynamoDB "ProductsTable" (partitionKey: productId)
- API Gateway GET /products, GET /products/{id}
- Policy IAM para a Lambda

Gere o handler TypeScript com lógica real de cache usando a biblioteca ioredis. Adicione nextSteps sobre instalar ioredis com npm install ioredis.

Free tier: na AWS o cache.t3.micro entra nas 750h/mês do free tier (12 meses). No Azure NÃO existe Redis gratuito — o menor SKU é Basic C0 (~USD 16/mês, cobrado por hora); adicione em warnings e recomende destruir logo após o teste.`,
  },
  {
    id: '09-rds-postgres-api',
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
    id: '10-ecs-fargate-api',
    title: 'Container ECS Fargate com Load Balancer',
    category: 'Container',
    description: 'API containerizada no ECS Fargate com ALB, VPC e auto-scaling.',
    prompt: `Crie uma infraestrutura para rodar uma aplicação containerizada na AWS com:

- VPC com CIDR 10.0.0.0/16
- 2 subnets privadas para o Fargate (AZs diferentes)
- 2 subnets públicas para o ALB (AZs diferentes)
- Security Group para ALB (ingress 80 e 443 de 0.0.0.0/0)
- Security Group para ECS tasks (ingress na porta 3000 só do SG do ALB)
- Compute.Container com image "minha-api:latest", cpu 256, memory 512, port 3000, desiredCount 2
- Network.LoadBalancer application internet-facing nas subnets públicas
- Auto-scaling: mínimo 2, máximo 10 tasks

Adicione em nextSteps os comandos para criar o ECR e fazer push da imagem antes do deploy.

Custo: Fargate NÃO tem free tier na AWS (2 tasks 256/512 ≈ USD 0,02/hora) — adicione em warnings. No Azure este cenário vira Container Apps, que TEM franquia mensal gratuita (180 mil vCPU-s + 2M requisições).`,
  },
  {
    id: '11-data-pipeline-s3-lambda',
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
    id: '12-lambda-authorizer-jwt',
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
    id: '13-cloudwatch-monitoring',
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
    id: '14-step-functions-workflow',
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
    id: '15-waf-protected-api',
    title: 'API Protegida com WAF',
    category: 'Segurança',
    description: 'API Gateway com WAF para proteção contra ataques comuns (SQLi, XSS, rate limiting).',
    prompt: `Crie uma infraestrutura de API protegida com WAF na AWS com:

- Network.WAF com scope REGIONAL, modo Prevention e as seguintes regras gerenciadas:
  - AWSManagedRulesCommonRuleSet (proteção geral: SQLi, XSS, etc.)
  - AWSManagedRulesKnownBadInputsRuleSet (inputs maliciosos conhecidos)
  - Regra customizada de rate limiting: máximo 100 requisições por IP em 5 minutos
- Lambda "ApiFn" simples com handler real
- API Gateway REST /api/{proxy+} conectado ao WAF via wafAclId
- Policy IAM mínima para a Lambda

Adicione em warnings os custos do WAF (USD 5/mês por WebACL + USD 1/mês por regra na AWS; no Azure o WAF exige Application Gateway WAF_v2, ~USD 125/mês SEM free tier) e em nextSteps como associar o WAF ao CloudFront em vez de API Gateway para proteção na borda. No Azure, sugira em warnings as políticas de rate-limit do APIM como alternativa gratuita ao WAF.`,
  },
  {
    id: '16-documentdb-api',
    title: 'Document Store com DocumentDB',
    category: 'Backend',
    description: 'API com DocumentDB (compatível MongoDB) para dados semi-estruturados. ATENÇÃO: na AWS o DocumentDB NÃO é free tier (db.t3.medium é pago); no Azure o equivalente (Cosmos DB Mongo API) É free tier.',
    prompt: `Crie uma infraestrutura de document store na AWS com:

- VPC com CIDR 10.0.0.0/16 e 2 subnets privadas
- Database.DocumentDB com 1 instância (db.t3.medium) em subnets privadas — sem criptografia e sem backup (NOTA: DocumentDB não é free tier, gera custo)
- Security Group para Lambda (egress liberado)
- Security Group para DocumentDB (ingress na porta 27017 só do SG da Lambda)
- Lambdas dentro da VPC com conexão ao DocumentDB: ListDocsFn, GetDocFn, CreateDocFn, UpdateDocFn, DeleteDocFn
- API Gateway REST /documents com rotas CRUD
- Policy IAM para acesso ao Secrets Manager (senha do DocDB gerada automaticamente)

Gere os handlers TypeScript com lógica real usando a biblioteca mongodb para conectar ao DocumentDB. A collection se chama "documents" com campos: _id, title, content, tags (array), createdAt.

Custo: na AWS o DocumentDB é PAGO (db.t3.medium ~USD 0,08/hora, sem free tier) — adicione em warnings e recomende destruir após o teste. No Azure este cenário vira Cosmos DB Mongo API, que TEM free tier (1 conta grátis por subscription) — sem custo.`,
  },
  {
    id: '17-kinesis-log-pipeline',
    title: 'Pipeline de Logs com Kinesis',
    category: 'Dados',
    description: 'Ingestão de eventos em tempo real com Kinesis Data Stream, processamento Lambda e arquivo no S3.',
    prompt: `Crie uma infraestrutura de ingestão de logs em tempo real na AWS com:

- Messaging.Queue ou Kinesis Data Stream "EventStream" com 2 shards e retenção de 24h
- Lambda "EventIngestorFn" exposta via API Gateway POST /events que coloca eventos no stream
- Lambda "EventProcessorFn" acionada pelo stream com batchSize 100 que processa os eventos
- S3 Bucket "EventArchiveBucket" onde os eventos processados são arquivados em JSON (particionado por ano/mês/dia)
- DynamoDB "EventMetricsTable" com contagens por tipo de evento (partitionKey: eventType, sortKey: date)
- Policy IAM para cada Lambda com actions mínimas

Gere os handlers TypeScript. O ingestor recebe { eventType, userId, payload, timestamp } e coloca no stream. O processador agrupa por tipo, salva métricas no DynamoDB e arquiva no S3.

Custo: streams NÃO têm free tier em nenhuma das nuvens — Kinesis ~USD 0,015/shard-hora na AWS (contas novas podem exigir assinatura do serviço); Event Hubs Basic ~USD 11/mês no Azure. Adicione em warnings e recomende destruir após o teste. Alternativa gratuita quando ordem/replay não são exigidos: fila (SQS/Service Bus Basic).`,
  },
  {
    id: '18-multi-env-config',
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
    id: '19-websocket-api',
    title: 'API WebSocket em Tempo Real',
    category: 'Tempo Real',
    description: 'API WebSocket com API Gateway para comunicação bidirecional em tempo real entre clientes.',
    prompt: `Crie uma infraestrutura de API WebSocket na AWS com:

- API Gateway WebSocket (type: WEBSOCKET) com stageName "prod"
- Lambda "ConnectFn" para rota $connect (salva connectionId no DynamoDB)
- Lambda "DisconnectFn" para rota $disconnect (remove connectionId do DynamoDB)
- Lambda "MessageFn" para rota $default (processa mensagens e faz broadcast para todos conectados)
- Lambda "BroadcastFn" exposta via API Gateway REST POST /broadcast (envia mensagem para todos os connectionIds ativos)
- DynamoDB "ConnectionsTable" (partitionKey: connectionId, TTL: expiresAt)
- Policy IAM para cada Lambda, incluindo execute-api:ManageConnections para enviar mensagens de volta

Gere os handlers TypeScript com lógica real: ConnectFn salva a conexão com TTL de 2h, MessageFn processa e faz echo, BroadcastFn lista todas as conexões ativas e envia para cada uma usando @aws-sdk/client-apigatewaymanagementapi.

Free tier: na AWS o WebSocket do API Gateway entra no free tier (1M mensagens/mês, 12 meses). No Azure o APIM Consumption NÃO suporta WebSocket — adicione em warnings que o cenário exige APIM Standard (pago) ou o serviço Web PubSub (que tem tier Free F1).`,
  },
  {
    id: '20-microservice-complete',
    title: 'Microsserviço Completo com Cache e Banco',
    category: 'Fullstack',
    description: 'Microsserviço production-ready com Lambda, API Gateway, RDS, ElastiCache e observabilidade.',
    prompt: `Crie um microsserviço production-ready na AWS para gerenciamento de produtos com:

Rede:
- VPC com CIDR 10.0.0.0/16, 2 subnets privadas
- Security Groups separados para Lambda, RDS e Redis com regras mínimas

Banco de dados:
- RDS PostgreSQL (db.t3.micro) em subnets privadas, senha no Secrets Manager (conta free tier: sem criptografia e sem backup)

Cache:
- ElastiCache Redis (cache.t3.micro) com TTL configurável para cache de leituras

Backend (Lambdas na VPC):
- ListProductsFn: tenta Redis → fallback PostgreSQL → atualiza cache
- GetProductFn: mesma lógica com cache por productId
- CreateProductFn: insere no PostgreSQL e invalida cache
- UpdateProductFn: atualiza PostgreSQL e invalida cache
- DeleteProductFn: remove do PostgreSQL e invalida cache

API: GET /products, GET /products/{id}, POST /products, PUT /products/{id}, DELETE /products/{id}

Monitoramento:
- Monitoring.Alarm para erros das Lambdas (threshold 5 em 5 min)

Policy IAM mínima para cada Lambda.

Gere todos os handlers TypeScript com lógica real usando pg e ioredis. Inclua nextSteps para instalar dependências.

Free tier: na AWS, db.t3.micro e cache.t3.micro entram nas 750h/mês do free tier (12 meses). No Azure: (a) o Postgres Flexible B1ms pode ser bloqueado por região em subscriptions FREE TRIAL (LocationIsOfferRestricted — eastus costuma aceitar); (b) NÃO existe Redis gratuito — menor SKU Basic C0 ~USD 16/mês cobrado por hora. Adicione ambos em warnings e recomende destruir após o teste.`,
  },
];

export const CATEGORIES = [...new Set(PROMPT_LIBRARY.map(p => p.category))];
