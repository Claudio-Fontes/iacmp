import type { Example } from '../index.js';

// Exemplos legados (bulk, do insert-batch) trazidos para a fonte única versionada.
// Sanados + validados pelo harness de contrato (126/126). validated:false = synth-validado.
// Corrigir um exemplo aqui vale para o banco (seed no boot) E para o harness num commit só.
export const LEGACY_EXAMPLES: Example[] = [
  {
    "id": "aws-cache-memcached-1",
    "title": "Memcached com Lambda em VPC",
    "provider": "aws",
    "constructs": [
      "Cache.Memcached",
      "Fn.Lambda",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "cache.memcached",
      "fn.lambda",
      "network.vpc",
      "vpc",
      "memjs",
      "elasticache"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/network-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('memcached-vpc-network');\n\nnew Network.VPC(stack, 'MainVpc', { cidr: '10.0.0.0/16' });\n\nnew Network.Subnet(stack, 'PrivSubnetA', {\n  vpcId: 'MainVpc',\n  cidr: '10.0.1.0/24',\n  availabilityZone: 'us-east-1a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'PrivSubnetB', {\n  vpcId: 'MainVpc',\n  cidr: '10.0.2.0/24',\n  availabilityZone: 'us-east-1b',\n  public: false,\n});\n\nnew Network.SecurityGroup(stack, 'LambdaSg', {\n  vpcId: 'MainVpc',\n  description: 'Lambda cache handler',\n  egressRules: [{ protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0', description: 'All outbound' }],\n});\n\nnew Network.SecurityGroup(stack, 'MemcachedSg', {\n  vpcId: 'MainVpc',\n  description: 'ElastiCache Memcached',\n  ingressRules: [{\n    protocol: 'tcp',\n    fromPort: 11211,\n    toPort: 11211,\n    sourceSecurityGroupId: 'LambdaSg',\n    description: 'Memcached from Lambda',\n  }],\n});\n\nexport default stack;",
      "stacks/cache/cache-stack.ts": "import { Stack, Cache } from '@iacmp/core';\n\nconst stack = new Stack('memcached-vpc-cache');\n\n// subnetIds e securityGroupIds nao estao na interface CacheMemcachedProps\n// mas sao suportados pelo synth AWS — cast as any necessario.\nnew Cache.Memcached(stack, 'AppCache', {\n  nodeType: 'small',\n  numCacheNodes: 1,\n  subnetIds: ['PrivSubnetA', 'PrivSubnetB'],\n  securityGroupIds: ['MemcachedSg'],\n} as any);\n\nexport default stack;",
      "stacks/compute/compute-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('memcached-vpc-compute');\n\n// CACHE_ENDPOINT: Cache.Memcached nao possui entrada no RESOLVE_MAP do iacmp.\n// Apos o deploy, obtenha o endpoint via:\n// aws elasticache describe-cache-clusters \\\n//   --cache-cluster-id appcache --show-cache-node-info \\\n//   --query 'CacheClusters[0].CacheNodes[0].Endpoint'\n// e atualize esta stack com o valor real antes de nova implantacao.\nnew Fn.Lambda(stack, 'CacheHandlerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/cache-handler.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  vpcId: 'MainVpc',\n  subnetIds: ['PrivSubnetA', 'PrivSubnetB'],\n  securityGroupIds: ['LambdaSg'],\n  environment: {\n    CACHE_ENDPOINT: 'REPLACE_WITH_APPCACHE_ENDPOINT:11211',\n  },\n});\n\nexport default stack;",
      "stacks/policy/policy-stack.ts": "import { Stack, Policy } from '@iacmp/core';\n\nconst stack = new Stack('memcached-vpc-policy');\n\nnew Policy.IAM(stack, 'CacheHandlerPolicy', {\n  attachTo: 'CacheHandlerFn',\n  attachType: 'lambda',\n  statements: [{\n    effect: 'Allow',\n    actions: ['elasticache:DescribeCacheClusters'],\n    resources: ['*'],\n  }],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/cache-handler.ts": "import * as memjs from 'memjs';\n\nconst endpoint = process.env.CACHE_ENDPOINT ?? 'localhost:11211';\nconst DEFAULT_TTL = 300;\n\nlet client: memjs.Client | undefined;\n\nfunction getClient(): memjs.Client {\n  if (!client) {\n    client = memjs.Client.create(endpoint, {\n      failover: false,\n      timeout: 1,\n      retries: 2,\n    });\n  }\n  return client;\n}\n\ninterface CacheEvent {\n  action?: 'get' | 'set' | 'delete';\n  key?: string;\n  value?: string;\n  ttl?: number;\n}\n\nexport const handler = async (event: CacheEvent) => {\n  const { action = 'get', key = 'ping', value = '', ttl = DEFAULT_TTL } = event;\n  const c = getClient();\n\n  if (action === 'set') {\n    await c.set(key, value, { expires: ttl });\n    return { statusCode: 200, body: JSON.stringify({ ok: true, key }) };\n  }\n\n  if (action === 'delete') {\n    await c.delete(key);\n    return { statusCode: 200, body: JSON.stringify({ ok: true, key }) };\n  }\n\n  const result = await c.get(key);\n  const cached = result.value?.toString() ?? null;\n  return { statusCode: 200, body: JSON.stringify({ key, cached }) };\n};"
    },
    "notes": [
      "Cache.Memcached nao esta no RESOLVE_MAP do iacmp: ref('AppCache', 'Endpoint') lanca erro em runtime. Apos o deploy, obtenha o endpoint com `aws elasticache describe-cache-clusters --cache-cluster-id appcache --show-cache-node-info` e atualize CACHE_ENDPOINT manualmente na stack compute.",
      "subnetIds e securityGroupIds nao existem na interface TypeScript CacheMemcachedProps mas sao lidos e processados pelo synth AWS (constructs/database.ts, case Cache.Memcached). O cast `as any` e necessario para compilar; o synth cria o AWS::ElastiCache::SubnetGroup automaticamente a partir de subnetIds.",
      "Use Network.Subnet explicito (nao maxAzs) para que os IDs logicos sejam registrados no ctx.registry e resolvidos como Fn::ImportValue cross-stack. O CATALOG proibe combinar maxAzs com Network.Subnet explicitos na mesma stack.",
      "O synth anexa AWSLambdaVPCAccessExecutionRole automaticamente quando vpcId esta presente na Fn.Lambda, cobrindo ec2:CreateNetworkInterface, ec2:DeleteNetworkInterface e CloudWatch Logs. Nao e necessario adicionar essas permissoes no Policy.IAM.",
      "Reutilize a conexao memjs.Client como singleton fora do handler (let client). Lambda reutiliza o contexto entre invocacoes quentes, evitando TCP setup por chamada. Em VPC, o cold start pode levar 10-15 s na primeira invocacao devido ao provisionamento da ENI."
    ]
  },
  {
    "id": "aws-cache-memcached-2",
    "title": "Memcached cluster multi-node",
    "provider": "aws",
    "constructs": [
      "Cache.Memcached",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup"
    ],
    "tags": [
      "aws",
      "cache.memcached",
      "network.vpc",
      "elasticache",
      "cluster",
      "multi-node",
      "sharding"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/network-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('memcached-multinode-network');\n\nnew Network.VPC(stack, 'CacheVpc', { cidr: '10.1.0.0/16' });\n\nnew Network.Subnet(stack, 'CacheSubnetA', {\n  vpcId: 'CacheVpc',\n  cidr: '10.1.1.0/24',\n  availabilityZone: 'us-east-1a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'CacheSubnetB', {\n  vpcId: 'CacheVpc',\n  cidr: '10.1.2.0/24',\n  availabilityZone: 'us-east-1b',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'CacheSubnetC', {\n  vpcId: 'CacheVpc',\n  cidr: '10.1.3.0/24',\n  availabilityZone: 'us-east-1c',\n  public: false,\n});\n\nnew Network.SecurityGroup(stack, 'MemcachedSg', {\n  vpcId: 'CacheVpc',\n  description: 'Memcached multi-node cluster',\n  ingressRules: [{\n    protocol: 'tcp',\n    fromPort: 11211,\n    toPort: 11211,\n    cidr: '10.1.0.0/16',\n    description: 'Memcached from within VPC',\n  }],\n});\n\nexport default stack;",
      "stacks/cache/cache-stack.ts": "import { Stack, Cache } from '@iacmp/core';\n\nconst stack = new Stack('memcached-multinode-cache');\n\n// numCacheNodes: 3 cria 3 nos independentes com sharding por hash consistente.\n// Memcached NAO replica dados entre nos — cada no armazena um subconjunto\n// diferente do espaco de chaves (diferente do Redis Cluster que replica).\n// Perda de um no implica perda das chaves atribuidas a ele.\nnew Cache.Memcached(stack, 'ClusterCache', {\n  nodeType: 'medium',\n  numCacheNodes: 3,\n  subnetIds: ['CacheSubnetA', 'CacheSubnetB', 'CacheSubnetC'],\n  securityGroupIds: ['MemcachedSg'],\n} as any);\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "Memcached nao replica dados entre nos: numCacheNodes: 3 cria 3 particoes independentes via hash consistente. Perda de um no implica perda das chaves daquele no. Para alta disponibilidade com replicacao, use Cache.Redis com automaticFailoverEnabled.",
      "ElastiCache Memcached nao expoe um endpoint de balanceamento unico para clusters multi-no. O cliente (memjs, node-memcached) deve receber todos os endpoints e fazer o routing. Exemplo memjs: `memjs.Client.create('node0.xxxxx.cache.amazonaws.com:11211,node1.xxxxx.cache.amazonaws.com:11211,node2.xxxxx.cache.amazonaws.com:11211')`.",
      "O synth cria o AWS::ElastiCache::SubnetGroup automaticamente a partir de subnetIds. NAO declare subnetGroupName junto com subnetIds — o synth usa um ou outro, e subnetIds tem precedencia.",
      "ElastiCache distribui os nos entre as AZs disponibilizadas via SubnetGroup. Com 3 nos e 3 subnets em 3 AZs distintas (us-east-1a/b/c), cada no tende a ficar em uma AZ separada, reduzindo o impacto de falha de AZ.",
      "Cache.Memcached nao esta no RESOLVE_MAP: impossivel usar ref() para endpoint. Recupere os endpoints dos nos apos o deploy via `aws elasticache describe-cache-clusters --cache-cluster-id clustercache --show-cache-node-info --query 'CacheClusters[0].CacheNodes[*].Endpoint'`."
    ]
  },
  {
    "id": "aws-cache-memcached-3",
    "title": "Memcached como session store via API Gateway",
    "provider": "aws",
    "constructs": [
      "Cache.Memcached",
      "Fn.Lambda",
      "Fn.ApiGateway",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "cache.memcached",
      "fn.lambda",
      "fn.apigateway",
      "network.vpc",
      "session-store",
      "node-memcached",
      "elasticache"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/network-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('memcached-session-network');\n\nnew Network.VPC(stack, 'SessionVpc', { cidr: '10.2.0.0/16' });\n\nnew Network.Subnet(stack, 'SessSubnetA', {\n  vpcId: 'SessionVpc',\n  cidr: '10.2.1.0/24',\n  availabilityZone: 'us-east-1a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'SessSubnetB', {\n  vpcId: 'SessionVpc',\n  cidr: '10.2.2.0/24',\n  availabilityZone: 'us-east-1b',\n  public: false,\n});\n\nnew Network.SecurityGroup(stack, 'SessionLambdaSg', {\n  vpcId: 'SessionVpc',\n  description: 'Lambda session handler',\n  egressRules: [{ protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0', description: 'All outbound' }],\n});\n\nnew Network.SecurityGroup(stack, 'SessionMemcachedSg', {\n  vpcId: 'SessionVpc',\n  description: 'ElastiCache Memcached para sessoes',\n  ingressRules: [{\n    protocol: 'tcp',\n    fromPort: 11211,\n    toPort: 11211,\n    sourceSecurityGroupId: 'SessionLambdaSg',\n    description: 'Memcached from Lambda session handler',\n  }],\n});\n\nexport default stack;",
      "stacks/network/api-gateway-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('memcached-session-api');\n\nnew Fn.ApiGateway(stack, 'SessionApi', {\n  name: 'session-api',\n  type: 'HTTP',\n  cors: true,\n  routes: [\n    { method: 'POST',   path: '/session',  lambdaId: 'SessionHandlerFn' },\n    { method: 'GET',    path: '/session',  lambdaId: 'SessionHandlerFn' },\n    { method: 'DELETE', path: '/session',  lambdaId: 'SessionHandlerFn' },\n  ],\n});\n\nexport default stack;",
      "stacks/cache/cache-stack.ts": "import { Stack, Cache } from '@iacmp/core';\n\nconst stack = new Stack('memcached-session-cache');\n\n// subnetIds e securityGroupIds nao estao na interface CacheMemcachedProps\n// mas sao lidos pelo synth AWS. Cast as any necessario em TypeScript.\nnew Cache.Memcached(stack, 'SessionCache', {\n  nodeType: 'small',\n  numCacheNodes: 1,\n  subnetIds: ['SessSubnetA', 'SessSubnetB'],\n  securityGroupIds: ['SessionMemcachedSg'],\n} as any);\n\nexport default stack;",
      "stacks/compute/compute-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('memcached-session-compute');\n\n// CACHE_ENDPOINT: apos o deploy, obtenha via:\n// aws elasticache describe-cache-clusters \\\n//   --cache-cluster-id sessioncache --show-cache-node-info \\\n//   --query 'CacheClusters[0].CacheNodes[0].Endpoint'\nnew Fn.Lambda(stack, 'SessionHandlerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/session-handler.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  vpcId: 'SessionVpc',\n  subnetIds: ['SessSubnetA', 'SessSubnetB'],\n  securityGroupIds: ['SessionLambdaSg'],\n  environment: {\n    CACHE_ENDPOINT: 'REPLACE_WITH_SESSIONCACHE_ENDPOINT:11211',\n    SESSION_TTL_SECONDS: '3600',\n  },\n});\n\nexport default stack;",
      "stacks/policy/policy-stack.ts": "import { Stack, Policy } from '@iacmp/core';\n\nconst stack = new Stack('memcached-session-policy');\n\nnew Policy.IAM(stack, 'SessionHandlerPolicy', {\n  attachTo: 'SessionHandlerFn',\n  attachType: 'lambda',\n  statements: [{\n    effect: 'Allow',\n    actions: ['elasticache:DescribeCacheClusters'],\n    resources: ['*'],\n  }],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/session-handler.ts": "import Memcached from 'memcached';\n\nconst endpoint = process.env.CACHE_ENDPOINT ?? 'localhost:11211';\nconst SESSION_TTL = parseInt(process.env.SESSION_TTL_SECONDS ?? '3600', 10);\n\nlet client: Memcached | undefined;\n\nfunction getClient(): Memcached {\n  if (!client) {\n    client = new Memcached(endpoint, {\n      timeout: 1000,\n      retries: 1,\n      failures: 3,\n      retry: 5000,\n    });\n  }\n  return client;\n}\n\nfunction memGet(key: string): Promise<string | undefined> {\n  return new Promise((resolve, reject) =>\n    getClient().get(key, (err, data) => {\n      if (err) reject(err);\n      else resolve(data as string | undefined);\n    })\n  );\n}\n\nfunction memSet(key: string, value: string, ttl: number): Promise<void> {\n  return new Promise((resolve, reject) =>\n    getClient().set(key, value, ttl, (err) => {\n      if (err) reject(err);\n      else resolve();\n    })\n  );\n}\n\nfunction memDel(key: string): Promise<void> {\n  return new Promise((resolve, reject) =>\n    getClient().del(key, (err) => {\n      if (err) reject(err);\n      else resolve();\n    })\n  );\n}\n\nfunction newSessionId(): string {\n  return `sess:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;\n}\n\ninterface LambdaEvent {\n  path?: string;\n  rawPath?: string;\n  httpMethod?: string;\n  requestContext?: { http?: { method?: string; path?: string } };\n  headers?: Record<string, string>;\n  body?: string;\n}\n\nexport const handler = async (event: LambdaEvent) => {\n  const method =\n    event.httpMethod ??\n    event.requestContext?.http?.method ??\n    'GET';\n  const path =\n    event.rawPath ??\n    event.path ??\n    '/';\n  const sessionId = event.headers?.['x-session-id'] ?? event.headers?.['X-Session-Id'] ?? '';\n\n  if (method === 'POST' && path === '/session') {\n    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;\n    const id = newSessionId();\n    await memSet(id, JSON.stringify(body), SESSION_TTL);\n    return {\n      statusCode: 201,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ sessionId: id, expiresIn: SESSION_TTL }),\n    };\n  }\n\n  if (method === 'GET' && path === '/session') {\n    if (!sessionId) {\n      return { statusCode: 400, body: JSON.stringify({ error: 'x-session-id header required' }) };\n    }\n    const data = await memGet(sessionId);\n    if (!data) {\n      return { statusCode: 404, body: JSON.stringify({ error: 'Session not found or expired' }) };\n    }\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: data,\n    };\n  }\n\n  if (method === 'DELETE' && path === '/session') {\n    if (!sessionId) {\n      return { statusCode: 400, body: JSON.stringify({ error: 'x-session-id header required' }) };\n    }\n    await memDel(sessionId);\n    return { statusCode: 204, body: '' };\n  }\n\n  return { statusCode: 400, body: JSON.stringify({ error: 'Invalid route' }) };\n};"
    },
    "notes": [
      "node-memcached e callback-based com assinatura (err, data, cas) — nao use util.promisify diretamente pois a aridade varia. Use wrappers Promise explicitos como mostrado no handler (memGet, memSet, memDel).",
      "Cache.Memcached nao esta no RESOLVE_MAP do iacmp: ref('SessionCache', 'Endpoint') lanca erro. Apos o deploy, obtenha o endpoint via `aws elasticache describe-cache-clusters --cache-cluster-id sessioncache --show-cache-node-info` e atualize CACHE_ENDPOINT na stack compute.",
      "ElastiCache Memcached nao persiste dados: reinicializacao do cluster (manutencao, falha de AZ) apaga todas as sessoes. Para sessoes criticas, combine com DynamoDB como fallback ou use Cache.Redis (que suporta persistencia RDB/AOF).",
      "O ApiGateway HTTP (type: HTTP) com cors: true permite headers customizados como x-session-id por padrao. Se usar type: REST, e necessario configurar CORS manualmente por rota, o que o iacmp ainda nao abstrai.",
      "Para elasticache:DescribeCacheClusters, resources: ['*'] e obrigatorio — o ElastiCache nao suporta permissoes em nivel de recurso para acoes Describe*. Nao tente usar ref('SessionCache', 'Arn') aqui, pois Cache.Memcached nao possui entrada no RESOLVE_MAP."
    ]
  },
  {
    "id": "aws-certificate-tls-2",
    "title": "Certificado ACM wildcard para multiplos subdominios",
    "provider": "aws",
    "constructs": [
      "Certificate.TLS"
    ],
    "tags": [
      "aws",
      "certificate.tls",
      "acm",
      "wildcard",
      "subdominio",
      "san",
      "subjectAlternativeNames"
    ],
    "validated": false,
    "stacks": {
      "stacks/security/wildcard-certificate-stack.ts": "import { Stack, Certificate } from '@iacmp/core';\n\nconst stack = new Stack('wildcard-certificate');\n\nnew Certificate.TLS(stack, 'WildcardCert', {\n  domainName: '*.example.com',\n  subjectAlternativeNames: ['example.com'],\n  validationMethod: 'DNS',\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "Um certificado wildcard '*.example.com' cobre APENAS um nivel de subdominio: app.example.com, api.example.com, www.example.com — mas NAO cobre example.com (apex) nem sub.app.example.com (dois niveis). Para cobrir o apex, adicione-o em subjectAlternativeNames.",
      "A AWS cobra um unico certificado para o wildcard + todos os SANs listados — nao ha custo adicional por SAN (ACM e gratuito para certificados provisionados).",
      "Com DNS validation e dominio apex em subjectAlternativeNames, a AWS pode gerar um ou dois registros CNAME distintos para validacao — valide os dois antes que o certificado transite para 'ISSUED'.",
      "O mesmo certificado wildcard pode ser compartilhado entre CloudFront (us-east-1) e ALB (qualquer regiao) — mas o certificado precisa existir na mesma regiao do recurso que o usa. Para usar em CloudFront E em ALB em regioes diferentes, crie dois certificados separados.",
      "subjectAlternativeNames e um array — adicione todos os dominios adicionais desejados (ex: ['example.com', 'mail.example.com']). O domainName principal nao precisa ser repetido nos SANs."
    ]
  },
  {
    "id": "aws-certificate-tls-3",
    "title": "Certificado ACM com validacao DNS e zona Route53",
    "provider": "aws",
    "constructs": [
      "Certificate.TLS",
      "Network.Dns"
    ],
    "tags": [
      "aws",
      "certificate.tls",
      "network.dns",
      "acm",
      "route53",
      "validacao-dns",
      "hosted-zone"
    ],
    "validated": false,
    "stacks": {
      "stacks/security/api-certificate-stack.ts": "import { Stack, Certificate } from '@iacmp/core';\n\nconst stack = new Stack('api-certificate');\n\nnew Certificate.TLS(stack, 'ApiCert', {\n  domainName: 'api.example.com',\n  validationMethod: 'DNS',\n});\n\nexport default stack;\n",
      "stacks/network/dns-zone-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('dns-zone');\n\nnew Network.Dns(stack, 'ExampleZone', {\n  zoneName: 'example.com',\n  records: [\n    {\n      name: 'api.example.com',\n      type: 'A',\n      ttl: 300,\n      values: ['203.0.113.10'],\n    },\n    {\n      name: 'www.example.com',\n      type: 'CNAME',\n      ttl: 300,\n      values: ['app.example.com'],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "validationMethod: 'DNS' e o padrao (o synth aplica 'DNS' quando o campo e omitido) — prefira sempre DNS sobre EMAIL: EMAIL requer acesso a caixas como admin@, postmaster@, webmaster@ que frequentemente nao existem, e o link de validacao expira em 72h.",
      "O Network.Dns cria uma Hosted Zone no Route53 mas NAO insere automaticamente os registros CNAME de validacao do ACM — esses registros aparecem no console ACM apos o inicio do deploy de api-certificate-stack e devem ser adicionados manualmente (ou via CLI) na zona do dns-zone-stack.",
      "Se a zona Route53 ja existir na conta (importada de outro provedor), NAO use Network.Dns — crie os registros CNAME de validacao do ACM diretamente via console ou CLI da AWS para nao duplicar a Hosted Zone e incorrer em custo duplo ($0,50/zona/mes).",
      "O deploy do stack api-certificate fica em 'CREATE_IN_PROGRESS' ate a validacao DNS ser concluida — pode levar de 5 min a algumas horas dependendo do TTL do DNS e propagacao. Use 'iacmp deploy --watch' para acompanhar.",
      "Para renovacao automatica, o certificado DNS-validated e renovado automaticamente pela AWS antes do vencimento desde que o registro CNAME de validacao permaneca na zona. Remover o CNAME quebra a renovacao automatica."
    ]
  },
  {
    "id": "aws-combo-01",
    "title": "AWS: Lambda + SQS + DynamoDB — processamento assíncrono de pedidos",
    "provider": "aws",
    "constructs": [
      "Messaging.Queue",
      "Fn.Lambda",
      "Database.DynamoDB",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "sqs",
      "lambda",
      "dynamodb",
      "iam",
      "async",
      "messaging",
      "orders"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/orders-queue-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\nconst stack = new Stack('orders-queue');\nnew Messaging.Queue(stack, 'OrdersQueue', {\n  visibilityTimeoutSeconds: 300,\n  messageRetentionSeconds: 86400,\n  encrypted: true,\n});\nexport default stack;",
      "stacks/database/orders-table-stack.ts": "import { Stack, Database } from '@iacmp/core';\nconst stack = new Stack('orders-table');\nnew Database.DynamoDB(stack, 'OrdersTable', {\n  partitionKey: 'orderId',\n  partitionKeyType: 'S',\n  billingMode: 'PAY_PER_REQUEST',\n  pointInTimeRecovery: true,\n});\nexport default stack;",
      "stacks/compute/enqueue-order-stack.ts": "import { Stack, Fn, Policy, ref } from '@iacmp/core';\nconst stack = new Stack('enqueue-order');\n\nnew Fn.Lambda(stack, 'EnqueueOrderFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/enqueueOrder.handler',\n  code: '.',\n  timeout: 30,\n  environment: {\n    QUEUE_URL: ref('OrdersQueue', 'QueueUrl'),\n  },\n});\n\nnew Policy.IAM(stack, 'EnqueueOrderPolicy', {\n  attachTo: 'EnqueueOrderFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['sqs:SendMessage'],\n      resources: [ref('OrdersQueue', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;",
      "stacks/compute/process-order-stack.ts": "import { Stack, Fn, Policy, ref } from '@iacmp/core';\nconst stack = new Stack('process-order');\n\nnew Fn.Lambda(stack, 'ProcessOrderFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/processOrder.handler',\n  code: '.',\n  timeout: 60,\n  environment: {\n    TABLE_NAME: ref('OrdersTable', 'Name'),\n  },\n  eventSources: [\n    {\n      queueId: 'OrdersQueue',\n      batchSize: 10,\n      bisectBatchOnFunctionError: true,\n    },\n  ],\n});\n\nnew Policy.IAM(stack, 'ProcessOrderPolicy', {\n  attachTo: 'ProcessOrderFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],\n      resources: [ref('OrdersTable', 'Arn')],\n    },\n    {\n      effect: 'Allow',\n      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],\n      resources: [ref('OrdersQueue', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/enqueueOrder.ts": "import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';\n\nconst sqs = new SQSClient({});\n\nexport async function handler(event: any) {\n  const body = typeof event.body === 'string' ? JSON.parse(event.body) : event;\n  const { customerId, items } = body;\n\n  if (!customerId || !Array.isArray(items) || items.length === 0) {\n    return {\n      statusCode: 400,\n      body: JSON.stringify({ error: 'customerId e items são obrigatórios' }),\n    };\n  }\n\n  const orderId = `order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;\n  const order = {\n    orderId,\n    customerId,\n    items,\n    createdAt: new Date().toISOString(),\n    status: 'PENDING',\n  };\n\n  await sqs.send(new SendMessageCommand({\n    QueueUrl: process.env.QUEUE_URL,\n    MessageBody: JSON.stringify(order),\n  }));\n\n  return {\n    statusCode: 202,\n    body: JSON.stringify({ orderId, message: 'Pedido enfileirado com sucesso' }),\n  };\n}",
      "src/processOrder.ts": "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nimport { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';\n\nconst db = DynamoDBDocumentClient.from(new DynamoDBClient({}));\n\nexport async function handler(event: any) {\n  for (const record of event.Records) {\n    const order = JSON.parse(record.body);\n    const { orderId, customerId, items, createdAt } = order;\n\n    const total = items.reduce(\n      (sum: number, item: any) => sum + item.price * item.quantity,\n      0,\n    );\n\n    await db\n      .send(\n        new PutCommand({\n          TableName: process.env.TABLE_NAME,\n          Item: {\n            orderId,\n            customerId,\n            items,\n            total,\n            createdAt,\n            processedAt: new Date().toISOString(),\n            status: 'PROCESSED',\n          },\n          ConditionExpression: 'attribute_not_exists(orderId)',\n        }),\n      )\n      .catch(async (err) => {\n        if (err.name === 'ConditionalCheckFailedException') {\n          await db.send(\n            new UpdateCommand({\n              TableName: process.env.TABLE_NAME,\n              Key: { orderId },\n              UpdateExpression: 'set #status = :status, processedAt = :processedAt',\n              ExpressionAttributeNames: { '#status': 'status' },\n              ExpressionAttributeValues: {\n                ':status': 'REPROCESSED',\n                ':processedAt': new Date().toISOString(),\n              },\n            }),\n          );\n        } else {\n          throw err;\n        }\n      });\n  }\n}"
    },
    "notes": [
      "visibilityTimeoutSeconds (300s) >= timeout da ProcessOrderFn (60s) — obrigatório para evitar reprocessamento enquanto a Lambda ainda está rodando",
      "Policy.IAM de cada Lambda está na mesma stack que o Fn.Lambda correspondente (regra CRÍTICA do synth)",
      "ProcessOrderFn usa eventSources[].queueId (string ID do construct) — nunca ref() aqui, que seria para ARN",
      "QUEUE_URL usa ref('OrdersQueue', 'QueueUrl') — SQS exige URL, nunca ARN no SendMessageCommand",
      "PutCommand com ConditionExpression: 'attribute_not_exists(orderId)' garante idempotência; duplicatas recebem UpdateItem com status REPROCESSED",
      "bisectBatchOnFunctionError: true faz o EventSourceMapping dividir o batch ao meio em caso de erro, isolando mensagens problemáticas",
      "ExpressionAttributeNames: { '#status': 'status' } é obrigatório — 'status' é palavra reservada no DynamoDB"
    ]
  },
  {
    "id": "aws-combo-05",
    "title": "AWS: S3 + Lambda + DynamoDB — Pipeline de Processamento de Arquivos com Metadados",
    "provider": "aws",
    "constructs": [
      "Storage.Bucket",
      "Fn.Lambda",
      "Database.DynamoDB",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "Storage.Bucket",
      "Fn.Lambda",
      "Database.DynamoDB",
      "Policy.IAM",
      "pipeline",
      "s3-event",
      "serverless"
    ],
    "validated": false,
    "stacks": {
      "stacks/pipeline/pipeline-stack.ts": "import { Stack, ref, Storage, Fn, Policy } from '@iacmp/core';\n\nconst stack = new Stack('file-pipeline');\n\nnew Storage.Bucket(stack, 'RawFilesBucket', {\n  versioning: true,\n  eventNotifications: [\n    {\n      lambdaId: 'FileProcessorFn',\n      events: ['s3:ObjectCreated:*'],\n    },\n  ],\n});\n\nnew Fn.Lambda(stack, 'FileProcessorFn', {\n  runtime: 'nodejs20',\n  handler: 'fileProcessor.handler',\n  code: 'dist/',\n  timeout: 60,\n  memory: 256,\n  environment: {\n    PROCESSED_BUCKET_NAME: ref('ProcessedFilesBucket', 'Name'),\n    METADATA_TABLE_NAME: ref('FileMetadataTable', 'Name'),\n  },\n});\n\nnew Policy.IAM(stack, 'FileProcessorPolicy', {\n  attachTo: 'FileProcessorFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['s3:GetObject'],\n      resources: ['RawFilesBucket/*'],\n    },\n    {\n      effect: 'Allow',\n      actions: ['s3:PutObject'],\n      resources: ['ProcessedFilesBucket/*'],\n    },\n    {\n      effect: 'Allow',\n      actions: ['dynamodb:PutItem'],\n      resources: [ref('FileMetadataTable', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/storage/storage-stack.ts": "import { Stack, Storage } from '@iacmp/core';\n\nconst stack = new Stack('file-storage');\n\nnew Storage.Bucket(stack, 'ProcessedFilesBucket', {\n  versioning: true,\n  lifecycleRules: [\n    { prefix: 'processed/', expireAfterDays: 90 },\n  ],\n});\n\nexport default stack;\n",
      "stacks/database/database-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('file-metadata-db');\n\nnew Database.DynamoDB(stack, 'FileMetadataTable', {\n  partitionKey: 'fileId',\n  partitionKeyType: 'S',\n  billingMode: 'PAY_PER_REQUEST',\n  pointInTimeRecovery: true,\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/fileProcessor.ts": "import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';\nimport { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nimport { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';\n\nconst s3 = new S3Client({});\nconst doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));\n\nexport const handler = async (event: any): Promise<void> => {\n  for (const record of event.Records) {\n    const sourceBucket = record.s3.bucket.name;\n    const rawKey = decodeURIComponent(record.s3.object.key.replace(/\\+/g, ' '));\n    const fileSizeBytes: number = record.s3.object.size;\n\n    const getResult = await s3.send(new GetObjectCommand({ Bucket: sourceBucket, Key: rawKey }));\n    const contentType = getResult.ContentType ?? 'application/octet-stream';\n    const rawContent = await getResult.Body!.transformToString();\n\n    const processedContent = rawContent.trim();\n    const processedKey = `processed/${rawKey}`;\n    const processedBucket = process.env.PROCESSED_BUCKET_NAME!;\n\n    await s3.send(new PutObjectCommand({\n      Bucket: processedBucket,\n      Key: processedKey,\n      Body: processedContent,\n      ContentType: contentType,\n    }));\n\n    const fileId = crypto.randomUUID();\n    const processedAt = new Date().toISOString();\n\n    await doc.send(new PutCommand({\n      TableName: process.env.METADATA_TABLE_NAME!,\n      Item: {\n        fileId,\n        originalKey: rawKey,\n        processedKey,\n        sourceBucket,\n        processedBucket,\n        contentType,\n        sizeBytes: fileSizeBytes,\n        processedAt,\n        status: 'processed',\n      },\n    }));\n  }\n};\n"
    },
    "notes": [
      "RawFilesBucket e FileProcessorFn ficam na mesma stack (pipeline-stack) para evitar dependência circular cross-stack: o bucket precisa do ARN da Lambda para eventNotifications e a Lambda não pode ter RAW_BUCKET_NAME no environment.",
      "O handler lê o nome do bucket de origem diretamente de event.Records[0].s3.bucket.name — nunca de env var (evita o ciclo CFN bucket→lambda→bucket).",
      "A chave S3 vem URL-encoded; o decode (replace /+/g + decodeURIComponent) é obrigatório para chaves com espaços ou caracteres especiais.",
      "PROCESSED_BUCKET_NAME usa ref('ProcessedFilesBucket', 'Name') porque bucket name (não ARN) é o que os SDKs S3 aceitam; METADATA_TABLE_NAME usa string literal 'FileMetadataTable' pois o nome físico da tabela DynamoDB é idêntico ao construct ID.",
      "Policy.IAM resources para S3 objects usam a string 'BucketId/*' (o synth resolve para ARN/*) — nunca ref('Bucket','Arn') + '/*' (produziria '[object Object]/*').",
      "Policy.IAM para DynamoDB usa ref('FileMetadataTable', 'Arn') cobrindo apenas dynamodb:PutItem, que é o único SDK command usado pelo handler.",
      "ProcessedFilesBucket fica em stacks/storage separada (sem trigger), referenciada pela Lambda via env var — dependência unidirecional, sem ciclo.",
      "FileMetadataTable fica em stacks/database separada; partitionKey 'fileId' do tipo 'S' (UUID gerado via crypto.randomUUID() no handler)."
    ]
  },
  {
    "id": "aws-compute-autoscaling-1",
    "title": "ASG simples com CPU target tracking scaling",
    "provider": "aws",
    "constructs": [
      "Compute.AutoScaling"
    ],
    "tags": [
      "aws",
      "compute.autoscaling",
      "autoscaling",
      "cpu-scaling",
      "target-tracking",
      "ec2"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/asg-cpu-scaling-stack.ts": "import { Stack, Compute } from '@iacmp/core';\n\nconst stack = new Stack('asg-cpu-scaling');\n\nnew Compute.AutoScaling(stack, 'WebAsg', {\n  instanceType: 'small',\n  image: 'amazon-linux-2023',\n  minCapacity: 1,\n  maxCapacity: 5,\n  desiredCapacity: 2,\n  targetCpuUtilization: 60,\n});\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "Sem subnetIds: o synth usa { 'Fn::GetAZs': '' } — distribui instâncias por todas as AZs da região. Suficiente para testes; em produção passe subnetIds explícitas para controlar AZs e VPC.",
      "targetCpuUtilization gera uma AWS::AutoScaling::ScalingPolicy do tipo TargetTrackingScaling com PredefinedMetricType ASGAverageCPUUtilization. A policy é emitida somente quando este campo está presente; sem ele o ASG escala apenas via ações manuais.",
      "instanceType: 'small' mapeia para t3.small. Para cargas variáveis considere 'medium' (t3.medium) ou 'large' (t3.large) — esses são os três valores aceitos pelo construct.",
      "image: 'amazon-linux-2023' usa SSM Parameter Store ({{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}) para resolver o AMI mais recente em cada deploy — nunca fica com AMI obsoleto mas pode introduzir mudanças de SO inesperadas. Para fixar o AMI, passe o ID literal como string (ex: 'ami-0abcdef1234567890')."
    ]
  },
  {
    "id": "aws-compute-autoscaling-2",
    "title": "ASG multi-AZ com imagem customizada e subnets privadas",
    "provider": "aws",
    "constructs": [
      "Network.VPC",
      "Network.Subnet",
      "Compute.AutoScaling"
    ],
    "tags": [
      "aws",
      "compute.autoscaling",
      "network.vpc",
      "network.subnet",
      "multi-az",
      "custom-image",
      "private-subnet",
      "ec2"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/vpc-multiaz-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('vpc-multiaz');\n\nnew Network.VPC(stack, 'AppVpc', {\n  cidr: '10.10.0.0/16',\n});\n\nnew Network.Subnet(stack, 'PrivateSubnetA', {\n  vpcId: 'AppVpc',\n  cidr: '10.10.1.0/24',\n  availabilityZone: 'a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'PrivateSubnetB', {\n  vpcId: 'AppVpc',\n  cidr: '10.10.2.0/24',\n  availabilityZone: 'b',\n  public: false,\n});\n\nexport default stack;",
      "stacks/compute/asg-multiaz-stack.ts": "import { Stack, Compute } from '@iacmp/core';\n\nconst stack = new Stack('asg-multiaz');\n\nnew Compute.AutoScaling(stack, 'AppAsg', {\n  instanceType: 'medium',\n  image: 'ami-0abcdef1234567890',\n  minCapacity: 2,\n  maxCapacity: 8,\n  desiredCapacity: 2,\n  targetCpuUtilization: 70,\n  subnetIds: ['PrivateSubnetA', 'PrivateSubnetB'],\n});\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "subnetIds aceita IDs de constructs de outra stack (ex: 'PrivateSubnetA'). O synth resolve via Fn::ImportValue cross-stack — a stack 'vpc-multiaz' deve ser deployada ANTES de 'asg-multiaz'.",
      "minCapacity: 2 com duas subnets em AZs distintas garante que o ASG distribua as instâncias: ao menos uma por AZ. Com minCapacity: 1 o ASG pode colocar ambas instâncias na mesma AZ durante um rebalance.",
      "image: 'ami-0abcdef1234567890' é passado literalmente ao LaunchTemplate — substitua pelo ID real da AMI da sua região. IDs de AMI são region-specific; um ID válido em us-east-1 é inválido em sa-east-1.",
      "Subnets privadas sem NAT Gateway: as instâncias não têm acesso à internet. Para instalar pacotes via user data ou puxar imagens de ECR público, adicione um NAT Gateway na subnet pública (Network.VPC não cria NAT automaticamente — use Custom.Resource se necessário).",
      "Para adicionar SecurityGroups às instâncias, inclua securityGroupIds: ['MinhasSG'] no Compute.AutoScaling — o campo aceita IDs de constructs Network.SecurityGroup ou IDs literais (sg-xxxxxxx)."
    ]
  },
  {
    "id": "aws-compute-container-1",
    "title": "Container Node.js exposto por ALB com Network.LoadBalancer na mesma stack",
    "provider": "aws",
    "constructs": [
      "Compute.Container",
      "Network.LoadBalancer",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup"
    ],
    "tags": [
      "aws",
      "compute.container",
      "network.loadbalancer",
      "ecs",
      "fargate",
      "alb",
      "nodejs",
      "mesma-stack"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/vpc.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('network');\n\nnew Network.VPC(stack, 'AppVpc', { cidr: '10.0.0.0/16' });\n\nnew Network.Subnet(stack, 'PubSubnetA', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.0.0/24',\n  availabilityZone: 'us-east-1a',\n  public: true,\n});\n\nnew Network.Subnet(stack, 'PubSubnetB', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.2.0/24',\n  availabilityZone: 'us-east-1b',\n  public: true,\n});\n\nnew Network.SecurityGroup(stack, 'AlbSG', {\n  vpcId: 'AppVpc',\n  description: 'ALB internet-facing access',\n  ingressRules: [\n    { protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '0.0.0.0/0' },\n  ],\n});\n\nnew Network.SecurityGroup(stack, 'AppSG', {\n  vpcId: 'AppVpc',\n  description: 'ECS tasks inbound from ALB only',\n  ingressRules: [\n    { protocol: 'tcp', fromPort: 3000, toPort: 3000, sourceSecurityGroupId: 'AlbSG' },\n  ],\n});\n\nexport default stack;\n",
      "stacks/compute/web-app.ts": "import { Stack, Network, Compute } from '@iacmp/core';\n\nconst stack = new Stack('compute');\n\nnew Network.LoadBalancer(stack, 'AppAlb', {\n  vpcId: 'AppVpc',\n  type: 'application',\n  scheme: 'internet-facing',\n  subnetIds: ['PubSubnetA', 'PubSubnetB'],\n  securityGroupIds: ['AlbSG'],\n  listeners: [{ port: 80, protocol: 'HTTP' }],\n  targetGroups: [{ name: 'app', port: 3000, protocol: 'HTTP', healthCheckPath: '/health' }],\n});\n\nnew Compute.Container(stack, 'AppContainer', {\n  image: 'node:20-alpine',\n  cpu: 512,\n  memory: 1024,\n  port: 3000,\n  desiredCount: 2,\n  publicIp: false,\n  subnetIds: ['PubSubnetA', 'PubSubnetB'],\n  securityGroupIds: ['AppSG'],\n  targetGroupArn: 'AppAlb.TargetGroupArn',\n  environment: {\n    NODE_ENV: 'production',\n    PORT: '3000',\n  },\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "targetGroupArn aceita a string '<LbId>.TargetGroupArn' — o synth resolve via parseStringRef. NUNCA use ref() neste campo nem lb.targetGroupArn (o getter existe no objeto mas o prop é tipado como string).",
      "O synth injeta DependsOn do ECS Service no Listener HTTP do ALB. Se o listener não existir no template (ex: targetGroups vazio), o synth falha com erro antes do deploy.",
      "desiredCount: 0 é útil em dev para provisionar infra sem iniciar tasks — evita custo Fargate e falha no health check enquanto a imagem não está disponível no repositório.",
      "Network.LoadBalancer na camada compute (mesma stack do Container) é um padrão válido quando o ALB é dedicado ao serviço. Não há regra que force separação.",
      "Subnets explícitas (Network.Subnet) exigem availabilityZone diferente para o validateSemantics do iacmp não rejeitar o ALB. Use AZs reais da região (us-east-1a, us-east-1b). NUNCA use maxAzs > 0 junto com Network.Subnet na mesma stack.",
      "ALB internet-facing exige subnets PUBLIC com Internet Gateway. O synth cria o IGW automaticamente quando detecta Network.Subnet com public: true na mesma stack da VPC."
    ]
  },
  {
    "id": "aws-compute-container-2",
    "title": "Container com variáveis de ambiente de banco via ref()",
    "provider": "aws",
    "constructs": [
      "Compute.Container",
      "Database.SQL",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup"
    ],
    "tags": [
      "aws",
      "compute.container",
      "database.sql",
      "ecs",
      "fargate",
      "rds",
      "postgres",
      "ref",
      "cross-stack",
      "environment"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/vpc.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('network');\n\nnew Network.VPC(stack, 'AppVpc', { cidr: '10.0.0.0/16' });\n\nnew Network.Subnet(stack, 'PrivSubnetA', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.0.0/24',\n  availabilityZone: 'us-east-1a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'PrivSubnetB', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.1.0/24',\n  availabilityZone: 'us-east-1b',\n  public: false,\n});\n\nnew Network.SecurityGroup(stack, 'AppSG', {\n  vpcId: 'AppVpc',\n  description: 'ECS tasks outbound access',\n  ingressRules: [\n    { protocol: 'tcp', fromPort: 3000, toPort: 3000, cidr: '10.0.0.0/16' },\n  ],\n});\n\nnew Network.SecurityGroup(stack, 'DBSG', {\n  vpcId: 'AppVpc',\n  description: 'RDS access from app only',\n  ingressRules: [\n    { protocol: 'tcp', fromPort: 5432, toPort: 5432, sourceSecurityGroupId: 'AppSG' },\n  ],\n});\n\nexport default stack;\n",
      "stacks/database/db.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('database');\n\nnew Database.SQL(stack, 'AppDB', {\n  engine: 'postgres',\n  instanceType: 'db.t3.micro',\n  subnetIds: ['PrivSubnetA', 'PrivSubnetB'],\n  securityGroupIds: ['DBSG'],\n});\n\nexport default stack;\n",
      "stacks/compute/app.ts": "import { Stack, Compute, ref } from '@iacmp/core';\n\nconst stack = new Stack('compute');\n\nnew Compute.Container(stack, 'AppContainer', {\n  image: 'myapp:latest',\n  cpu: 512,\n  memory: 1024,\n  port: 3000,\n  desiredCount: 2,\n  publicIp: false,\n  subnetIds: ['PrivSubnetA', 'PrivSubnetB'],\n  securityGroupIds: ['AppSG'],\n  environment: {\n    DB_HOST: ref('AppDB', 'Endpoint'),\n    DB_PORT: ref('AppDB', 'Port'),\n    DB_USER: ref('AppDB', 'Username'),\n    DB_PASSWORD: ref('AppDB', 'Password'),\n    NODE_ENV: 'production',\n  },\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "ref('AppDB', 'Password') resolve para {{resolve:secretsmanager:database-AppDB-<suffix>:SecretString:password}} — o valor NUNCA fica em texto puro no template CloudFormation nem nos logs.",
      "ref('AppDB', 'Username') resolve para o username master configurado (default: 'dbadmin'). NUNCA hardcode 'postgres' nem 'admin' — o synth gerencia o username.",
      "ref('AppDB', 'Endpoint') e ref('AppDB', 'Port') cross-stack produzem Fn::ImportValue. A stack 'database' deve estar com status CREATE_COMPLETE antes de fazer deploy da stack 'compute'.",
      "ref() só é válido nos valores de environment (e em resources/alarmActions de Policy.IAM e Monitoring.Alarm). NUNCA use ref() em vpcId, subnetIds nem securityGroupIds — esses campos aceitam apenas string com o construct ID lógico.",
      "Container em subnet privada sem NAT Gateway não alcança o Docker Hub para pull de imagem. Use imagens do Amazon ECR ou configure NAT Gateway via Custom.Resource.",
      "NUNCA use maxAzs > 0 junto com Network.Subnet explícitos na mesma stack VPC — o validateSemantics do iacmp rejeita essa combinação com erro claro."
    ]
  },
  {
    "id": "aws-compute-container-3",
    "title": "Container worker sem porta pública consumindo fila SQS",
    "provider": "aws",
    "constructs": [
      "Compute.Container",
      "Messaging.Queue",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup"
    ],
    "tags": [
      "aws",
      "compute.container",
      "messaging.queue",
      "ecs",
      "fargate",
      "sqs",
      "worker",
      "sem-porta",
      "background"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/vpc.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('network');\n\nnew Network.VPC(stack, 'AppVpc', { cidr: '10.0.0.0/16' });\n\nnew Network.Subnet(stack, 'PrivSubnetA', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.0.0/24',\n  availabilityZone: 'us-east-1a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'PrivSubnetB', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.1.0/24',\n  availabilityZone: 'us-east-1b',\n  public: false,\n});\n\nnew Network.SecurityGroup(stack, 'WorkerSG', {\n  vpcId: 'AppVpc',\n  description: 'Worker ECS tasks egress only',\n});\n\nexport default stack;\n",
      "stacks/messaging/queue.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('messaging');\n\nnew Messaging.Queue(stack, 'WorkQueue', {\n  visibilityTimeoutSeconds: 300,\n  messageRetentionSeconds: 86400,\n});\n\nexport default stack;\n",
      "stacks/compute/worker.ts": "import { Stack, Compute, ref } from '@iacmp/core';\n\nconst stack = new Stack('compute');\n\nnew Compute.Container(stack, 'WorkerContainer', {\n  image: 'myworker:latest',\n  cpu: 256,\n  memory: 512,\n  desiredCount: 1,\n  publicIp: false,\n  subnetIds: ['PrivSubnetA', 'PrivSubnetB'],\n  securityGroupIds: ['WorkerSG'],\n  environment: {\n    QUEUE_URL: ref('WorkQueue', 'QueueUrl'),\n    NODE_ENV: 'production',\n  },\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "Omitir port no Compute.Container gera uma TaskDefinition sem PortMappings e um ECS Service sem LoadBalancers — padrão correto para workers que só leem de filas.",
      "Policy.IAM com attachType: 'compute' gera InstanceProfile para EC2, NÃO Task Role para ECS Fargate. Para conceder permissão SQS ao container use Custom.Resource criando um AWS::IAM::Role com principal ecs-tasks.amazonaws.com e anexe-o à TaskDefinition via taskRoleArn.",
      "ref('WorkQueue', 'QueueUrl') cross-stack resolve para { Fn::ImportValue: 'messaging-WorkQueue-QueueUrl' }. A stack 'messaging' deve estar CREATE_COMPLETE antes do deploy de 'compute'.",
      "Worker em subnet privada sem NAT Gateway não alcança o endpoint público do SQS (sqs.<region>.amazonaws.com). O iacmp não suporta VPC Endpoint para SQS via Network.VpcEndpoint (só dynamodb e s3 são suportados) — use NAT Gateway via Custom.Resource ou permita publicIp: true com subnet pública como alternativa de desenvolvimento.",
      "visibilityTimeoutSeconds da fila deve ser >= timeout de processamento do worker. Para workers que processam mensagens em até 5 minutos, 300 segundos é o valor correto para evitar reprocessamento duplicado."
    ]
  },
  {
    "id": "aws-compute-instance-1",
    "title": "VM Ubuntu 22.04 com nginx via UserData",
    "provider": "aws",
    "constructs": [
      "Custom.Resource"
    ],
    "tags": [
      "aws",
      "ec2",
      "ubuntu",
      "nginx",
      "userdata",
      "custom.resource"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/nginx-ubuntu-stack.ts": "import { Stack, Custom } from '@iacmp/core';\n\nconst stack = new Stack('nginx-ubuntu');\n\nnew Custom.Resource(stack, 'NginxServer', {\n  cloudformation: {\n    type: 'AWS::EC2::Instance',\n    properties: {\n      InstanceType: 't3.small',\n      ImageId: '{{resolve:ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}',\n      SubnetId: 'subnet-0123456789abcdef0',\n      SecurityGroupIds: ['sg-0123456789abcdef0'],\n      UserData: {\n        'Fn::Base64': '#!/bin/bash\\nset -e\\napt-get update -y\\napt-get install -y nginx\\nsystemctl enable nginx\\nsystemctl start nginx\\necho \"<html><body><h1>Servidor nginx em $(hostname)</h1></body></html>\" > /var/www/html/index.html',\n      },\n      Tags: [{ Key: 'Name', Value: 'NginxServer' }],\n    },\n  },\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "Compute.Instance nao tem prop userData — UserData em EC2 exige Custom.Resource com cloudformation; o synth passa o bloco cloudformation.properties diretamente para o CloudFormation sem transformacao.",
      "UserData deve ser uma string com \\n literais dentro de Fn::Base64 (nao objeto Fn::Sub) quando nao ha variaveis CloudFormation no script — evita erro de serializacao no synth.",
      "{{resolve:ssm:/aws/service/canonical/...}} e resolvido pelo CloudFormation em deploy time; a AMI e sempre a mais recente da regiao onde o stack e deployed, sem hardcode de ami-id.",
      "SubnetId e SecurityGroupIds passados como strings literais ('subnet-*', 'sg-*') ignoram o resolver de construct e sao emitidos diretamente no template — correto quando o recurso existe fora do iacmp.",
      "set -e no UserData garante que o script aborta se apt-get falhar; sem ele a instancia sobe mesmo com nginx nao instalado e o health check passa erroneamente."
    ]
  },
  {
    "id": "aws-compute-instance-2",
    "title": "VM Windows Server 2022 com IIS via PowerShell UserData",
    "provider": "aws",
    "constructs": [
      "Custom.Resource"
    ],
    "tags": [
      "aws",
      "ec2",
      "windows",
      "iis",
      "powershell",
      "userdata",
      "custom.resource"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/windows-iis-stack.ts": "import { Stack, Custom } from '@iacmp/core';\n\nconst stack = new Stack('windows-iis');\n\nnew Custom.Resource(stack, 'WindowsServer', {\n  cloudformation: {\n    type: 'AWS::EC2::Instance',\n    properties: {\n      InstanceType: 't3.medium',\n      ImageId: '{{resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base}}',\n      SubnetId: 'subnet-0123456789abcdef0',\n      SecurityGroupIds: ['sg-0123456789abcdef0'],\n      UserData: {\n        'Fn::Base64':\n          '<powershell>\\nSet-ExecutionPolicy Unrestricted -Scope LocalMachine -Force\\nInstall-WindowsFeature -Name Web-Server -IncludeManagementTools\\n$html = \"<html><body><h1>IIS em $env:COMPUTERNAME</h1></body></html>\"\\nSet-Content -Path C:\\\\inetpub\\\\wwwroot\\\\index.html -Value $html -Encoding UTF8\\n</powershell>',\n      },\n      Tags: [{ Key: 'Name', Value: 'WindowsServer' }],\n    },\n  },\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "UserData Windows deve ser envolvido em <powershell>...</powershell> (nao <script>); sem esse delimitador o EC2Launch agent ignora o bloco e o script nao e executado.",
      "t3.medium e o minimo recomendado para Windows Server 2022 — t3.small (1 vCPU / 2 GB) frequentemente causa OOM durante o sysprep do AMI Windows, resultando em instancia inacessivel.",
      "{{resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base}} resolve a AMI publica mais recente da Microsoft na regiao de deploy; nunca hardcode ami-id para Windows porque a AMI base e atualizada mensalmente.",
      "Install-WindowsFeature bloqueia ate a instalacao concluir — nao e necessario reiniciar manualmente; o EC2Launch 2 (padrao no 2022) executa UserData uma unica vez no primeiro boot sem precisar de cfn-signal para workflows simples.",
      "Caminhos Windows em strings JSON: C:\\\\inetpub (dupla barra invertida) — barra simples causa erro de parse no PowerShell quando a string e deserializada pelo agent."
    ]
  },
  {
    "id": "aws-compute-instance-3",
    "title": "VM com SecurityGroup dedicado e Elastic IP",
    "provider": "aws",
    "constructs": [
      "Compute.Instance",
      "Network.SecurityGroup",
      "Custom.Resource"
    ],
    "tags": [
      "aws",
      "ec2",
      "ubuntu",
      "securitygroup",
      "eip",
      "elastic-ip",
      "compute.instance",
      "network.securitygroup",
      "custom.resource"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/web-sg-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('web-sg');\n\nnew Network.SecurityGroup(stack, 'WebSG', {\n  vpcId: 'vpc-0123456789abcdef0',\n  description: 'Security group para servidor web publico',\n  ingressRules: [\n    { protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '0.0.0.0/0', description: 'HTTP publico' },\n    { protocol: 'tcp', fromPort: 443, toPort: 443, cidr: '0.0.0.0/0', description: 'HTTPS publico' },\n    { protocol: 'tcp', fromPort: 22, toPort: 22, cidr: '0.0.0.0/0', description: 'SSH admin' },\n  ],\n});\n\nexport default stack;\n",
      "stacks/compute/web-instance-eip-stack.ts": "import { Stack, Compute, Custom } from '@iacmp/core';\n\nconst stack = new Stack('web-instance-eip');\n\nnew Compute.Instance(stack, 'WebServer', {\n  instanceType: 'small',\n  image: 'ubuntu-22.04',\n  subnetId: 'subnet-0123456789abcdef0',\n  securityGroupIds: ['WebSG'],\n});\n\nnew Custom.Resource(stack, 'WebServerEIP', {\n  cloudformation: {\n    type: 'AWS::EC2::EIP',\n    properties: {\n      Domain: 'vpc',\n      Tags: [{ Key: 'Name', Value: 'WebServerEIP' }],\n    },\n  },\n});\n\nnew Custom.Resource(stack, 'WebServerEIPAssoc', {\n  cloudformation: {\n    type: 'AWS::EC2::EIPAssociation',\n    properties: {\n      AllocationId: { 'Fn::GetAtt': ['WebServerEIP', 'AllocationId'] },\n      InstanceId: { Ref: 'WebServer' },\n    },\n  },\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "EIP e EIPAssociation nao tem construct nativo no @iacmp/core — Custom.Resource com cloudformation e o unico caminho; o synth emite as propriedades sem transformacao.",
      "securityGroupIds: ['WebSG'] passa o construct ID como string; o resolver de SecurityGroup detecta que WebSG pertence a stack 'web-sg' (diferente de 'web-instance-eip') e emite Fn::ImportValue automaticamente — nunca passe o ID logico do CloudFormation nem o sg-* diretamente quando o SG foi criado pelo iacmp.",
      "{ Ref: 'WebServer' } dentro de Custom.Resource referencia o logical ID do EC2 na mesma stack; o logical ID e derivado do construct ID com caracteres nao-alfanumericos removidos (WebServer → WebServer sem alteracao neste caso).",
      "{ 'Fn::GetAtt': ['WebServerEIP', 'AllocationId'] } referencia o EIP pelo logical ID do Custom.Resource (WebServerEIP → WebServerEIP); funciona porque o synth emite o Custom.Resource com chave == construct ID sem transformacao de caracteres especiais alem de remocao.",
      "Deploy order: stack 'web-sg' deve ser deployed antes de 'web-instance-eip'; o Fn::ImportValue criado pelo resolver gera dependencia implicita no CloudFormation mas o iacmp nao ordena os deploys automaticamente — rode 'iacmp deploy web-sg' antes de 'iacmp deploy web-instance-eip'."
    ]
  },
  {
    "id": "aws-compute-kubernetes-1",
    "title": "Cluster básico EKS com node group small",
    "provider": "aws",
    "constructs": [
      "Compute.Kubernetes",
      "Network.VPC",
      "Network.Subnet"
    ],
    "tags": [
      "aws",
      "eks",
      "kubernetes",
      "compute.kubernetes",
      "network.vpc",
      "network.subnet",
      "small",
      "basico"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/eks-vpc.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('eks-network');\n\nnew Network.VPC(stack, 'EksVpc', {\n  cidr: '10.0.0.0/16',\n  maxAzs: 0,\n});\n\nnew Network.Subnet(stack, 'EksSubnetPrivA', {\n  vpcId: 'EksVpc',\n  cidr: '10.0.10.0/24',\n  availabilityZone: 'us-east-1a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'EksSubnetPrivB', {\n  vpcId: 'EksVpc',\n  cidr: '10.0.11.0/24',\n  availabilityZone: 'us-east-1b',\n  public: false,\n});\n\nexport default stack;",
      "stacks/compute/eks-basico.ts": "import { Stack, Compute } from '@iacmp/core';\n\nconst stack = new Stack('eks-compute');\n\nnew Compute.Kubernetes(stack, 'ClusterBasico', {\n  version: '1.29',\n  nodeInstanceType: 'small',\n  minNodes: 2,\n  maxNodes: 3,\n  desiredNodes: 2,\n  subnetIds: ['EksSubnetPrivA', 'EksSubnetPrivB'],\n});\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "EKS exige pelo menos 2 subnets em AZs distintas — sem isso o cluster é criado mas o nodegroup falha com InvalidParameter: Two subnets must be provided with different availability zones",
      "nodeInstanceType: 'small' mapeia para t3.medium no synth AWS — t3.micro e t3.small falham por falta de memória para o kubelet e o kube-proxy",
      "desiredNodes deve estar entre minNodes e maxNodes inclusive — CloudFormation rejeita DesiredSize fora do intervalo [MinSize, MaxSize] em tempo de deploy",
      "O nodegroup só é criado após o cluster via DependsOn implícito no synth — o deploy completo leva ~15 min na AWS por conta da inicialização do control plane",
      "maxAzs: 0 na VPC desliga a geração automática de subnets — use Network.Subnet explícitos para controlar CIDR e AZ de cada subnet antes de passar os IDs ao EKS",
      "A stack eks-network deve ser deployada antes de eks-compute — os subnetIds são resolvidos via Fn::ImportValue com o export eks-network-EksSubnetPrivA-SubnetId"
    ]
  },
  {
    "id": "aws-compute-kubernetes-2",
    "title": "Dois clusters EKS com node types distintos (small para sistema, large para aplicação)",
    "provider": "aws",
    "constructs": [
      "Compute.Kubernetes",
      "Network.VPC",
      "Network.Subnet"
    ],
    "tags": [
      "aws",
      "eks",
      "kubernetes",
      "compute.kubernetes",
      "network.vpc",
      "network.subnet",
      "multi-cluster",
      "small",
      "large",
      "multi-node-type"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/eks-multi-vpc.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('eks-multi-network');\n\nnew Network.VPC(stack, 'EksMultiVpc', {\n  cidr: '10.1.0.0/16',\n  maxAzs: 0,\n});\n\nnew Network.Subnet(stack, 'EksMultiSubnetPrivA', {\n  vpcId: 'EksMultiVpc',\n  cidr: '10.1.10.0/24',\n  availabilityZone: 'us-east-1a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'EksMultiSubnetPrivB', {\n  vpcId: 'EksMultiVpc',\n  cidr: '10.1.11.0/24',\n  availabilityZone: 'us-east-1b',\n  public: false,\n});\n\nexport default stack;",
      "stacks/compute/eks-sistema.ts": "import { Stack, Compute } from '@iacmp/core';\n\nconst stack = new Stack('eks-sistema');\n\nnew Compute.Kubernetes(stack, 'ClusterSistema', {\n  version: '1.29',\n  nodeInstanceType: 'small',\n  minNodes: 2,\n  maxNodes: 4,\n  desiredNodes: 2,\n  subnetIds: ['EksMultiSubnetPrivA', 'EksMultiSubnetPrivB'],\n});\n\nexport default stack;",
      "stacks/compute/eks-app.ts": "import { Stack, Compute } from '@iacmp/core';\n\nconst stack = new Stack('eks-app');\n\nnew Compute.Kubernetes(stack, 'ClusterApp', {\n  version: '1.29',\n  nodeInstanceType: 'large',\n  minNodes: 1,\n  maxNodes: 8,\n  desiredNodes: 2,\n  subnetIds: ['EksMultiSubnetPrivA', 'EksMultiSubnetPrivB'],\n});\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "Compute.Kubernetes cria um EKS cluster + um managed nodegroup por construct — não há suporte nativo a múltiplos nodegroups em um mesmo cluster via iacmp; o padrão é usar clusters separados por stack com node types distintos",
      "Dois constructs referenciando as mesmas subnets via cross-stack Fn::ImportValue é válido — a stack eks-multi-network deve ser deployada primeiro e as outras duas podem ser deployadas em paralelo depois",
      "nodeInstanceType: 'large' mapeia para m5.2xlarge — verifique a quota EC2 Running On-Demand m5 instances na conta antes de definir maxNodes alto; o limite padrão em contas novas pode bloquear o nodegroup",
      "Stack names distintos (eks-sistema, eks-app) são obrigatórios — dois Compute.Kubernetes com o mesmo stack name causam colisão de Export Names no CloudFormation",
      "Para workloads que exigem múltiplos node pools no MESMO cluster (ex: GPU + CPU), o padrão iacmp é multi-cluster; o construto não expõe um segundo nodegroup no mesmo EKS cluster"
    ]
  },
  {
    "id": "aws-compute-kubernetes-3",
    "title": "Cluster EKS privado sem endpoint público, acesso apenas via VPC",
    "provider": "aws",
    "constructs": [
      "Compute.Kubernetes",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup"
    ],
    "tags": [
      "aws",
      "eks",
      "kubernetes",
      "compute.kubernetes",
      "network.vpc",
      "network.subnet",
      "network.securitygroup",
      "privado",
      "private-cluster",
      "sem-acesso-publico"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/eks-private-vpc.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('eks-private-network');\n\nnew Network.VPC(stack, 'EksPrivVpc', {\n  cidr: '10.2.0.0/16',\n  maxAzs: 0,\n});\n\nnew Network.Subnet(stack, 'EksPrivSubnetA', {\n  vpcId: 'EksPrivVpc',\n  cidr: '10.2.10.0/24',\n  availabilityZone: 'us-east-1a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'EksPrivSubnetB', {\n  vpcId: 'EksPrivVpc',\n  cidr: '10.2.11.0/24',\n  availabilityZone: 'us-east-1b',\n  public: false,\n});\n\nexport default stack;",
      "stacks/network/eks-private-sg.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('eks-private-sg');\n\nnew Network.SecurityGroup(stack, 'EksPrivSg', {\n  vpcId: 'EksPrivVpc',\n  description: 'EKS cluster privado - acesso interno apenas',\n  ingressRules: [\n    {\n      protocol: 'tcp',\n      fromPort: 443,\n      toPort: 443,\n      cidr: '10.2.0.0/16',\n      description: 'API server HTTPS interno',\n    },\n    {\n      protocol: 'tcp',\n      fromPort: 10250,\n      toPort: 10250,\n      cidr: '10.2.0.0/16',\n      description: 'Kubelet entre nodes',\n    },\n  ],\n  egressRules: [\n    {\n      protocol: '-1',\n      fromPort: 0,\n      toPort: 0,\n      cidr: '0.0.0.0/0',\n      description: 'Saida irrestrita para ECR, S3 e APIs AWS',\n    },\n  ],\n});\n\nexport default stack;",
      "stacks/compute/eks-privado.ts": "import { Stack, Compute } from '@iacmp/core';\n\nconst stack = new Stack('eks-private-compute');\n\nnew Compute.Kubernetes(stack, 'ClusterPrivado', {\n  version: '1.29',\n  nodeInstanceType: 'medium',\n  minNodes: 2,\n  maxNodes: 5,\n  desiredNodes: 3,\n  privateCluster: true,\n  subnetIds: ['EksPrivSubnetA', 'EksPrivSubnetB'],\n  securityGroupIds: ['EksPrivSg'],\n});\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "privateCluster: true gera EndpointPrivateAccess: true e EndpointPublicAccess: false no CloudFormation — após o deploy, kubectl de fora da VPC falha imediatamente; é necessário bastion host, VPN ou AWS Systems Manager Session Manager na mesma VPC",
      "O deploy via CloudFormation continua funcionando com cluster privado — o CloudFormation usa a ENI interna do EKS, não o endpoint público; mas pipelines de CI/CD que executam kubectl precisam estar dentro da VPC",
      "O security group EksPrivSg referencia EksPrivVpc de outra stack — o synth resolve via Fn::ImportValue; a stack eks-private-network deve ser deployada antes de eks-private-sg, e esta antes de eks-private-compute",
      "A porta 10250 (kubelet) no ingress do SG é necessária para que o control plane do EKS se comunique com os nodes — sem ela os nodes ficam em NotReady e os pods não são schedulados",
      "nodeInstanceType: 'medium' mapeia para m5.large — escolha adequada para um cluster privado de produção com 3 nodes desejados; t3.medium (small) pode ser insuficiente se houver addons como CoreDNS, kube-proxy e aws-node simultaneamente",
      "Sem endpoint público, o EKS ainda requer que os nodes acessem o ECR para pull de imagens e a API da AWS — a saída irrestrita no SG (protocolo -1) é obrigatória ou implemente VPC endpoints para ECR, S3 e EC2"
    ]
  },
  {
    "id": "aws-database-documentdb-2",
    "title": "DocumentDB com 3 instâncias replica e readPreference secundário",
    "provider": "aws",
    "constructs": [
      "Database.DocumentDB",
      "Function.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "documentdb",
      "mongodb",
      "replica",
      "read-preference",
      "high-availability",
      "database.documentdb",
      "function.lambda",
      "policy.iam"
    ],
    "validated": false,
    "stacks": {
      "stacks/database/docdb-replica-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('docdb-replica');\n\n// 1 primária + 2 réplicas — instâncias numeradas pelo synth: instance-1 (primary), instance-2, instance-3\nnew Database.DocumentDB(stack, 'ReplicaDocDb', {\n  instanceType: 'db.t3.medium',\n  instances: 3,\n});\n\nexport default stack;\n",
      "stacks/compute/docdb-replica-lambda-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('docdb-replica-lambda');\n\nnew Fn.Lambda(stack, 'DocDbReplicaFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/docdbReplicaQuery.handler',\n  code: '.',\n  timeout: 30,\n  memory: 256,\n  environment: {\n    DOCDB_ENDPOINT: ref('ReplicaDocDb', 'Endpoint'),\n    DOCDB_PORT: ref('ReplicaDocDb', 'Port'),\n    DOCDB_SECRET_ARN: ref('ReplicaDocDb', 'SecretArn'),\n  },\n});\n\nexport default stack;\n",
      "stacks/policy/docdb-replica-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('docdb-replica-policy');\n\nnew Policy.IAM(stack, 'DocDbReplicaPolicy', {\n  attachTo: 'DocDbReplicaFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['secretsmanager:GetSecretValue'],\n      resources: [ref('ReplicaDocDb', 'SecretArn')],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/docdbReplicaQuery.ts": "import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';\nimport { MongoClient, ReadPreference } from 'mongodb';\nimport * as path from 'path';\n\nconst secretsClient = new SecretsManagerClient({});\n\nlet cachedClient: MongoClient | null = null;\n\nasync function getMongoClient(): Promise<MongoClient> {\n  if (cachedClient) return cachedClient;\n\n  const secretArn = process.env.DOCDB_SECRET_ARN ?? '';\n  const endpoint = process.env.DOCDB_ENDPOINT ?? '';\n  const port = process.env.DOCDB_PORT ?? '27017';\n\n  const result = await secretsClient.send(\n    new GetSecretValueCommand({ SecretId: secretArn }),\n  );\n  const { password } = JSON.parse(result.SecretString ?? '{}');\n\n  const caFilePath = path.join(__dirname, '..', 'global-bundle.pem');\n\n  // readPreference=secondaryPreferred distribui leitura pelas réplicas\n  // e faz fallback para a primária se todas as réplicas estiverem indisponíveis\n  const uri =\n    `mongodb://docdbadmin:${encodeURIComponent(password)}@${endpoint}:${port}` +\n    '/?replicaSet=rs0&retryWrites=false&readPreference=secondaryPreferred';\n\n  const client = new MongoClient(uri, {\n    tls: true,\n    tlsCAFile: caFilePath,\n    retryWrites: false,\n    readPreference: ReadPreference.SECONDARY_PREFERRED,\n  });\n\n  await client.connect();\n  cachedClient = client;\n  return client;\n}\n\nexport const handler = async (event: Record<string, unknown>) => {\n  const client = await getMongoClient();\n  const db = client.db('app');\n  const collection = db.collection('reports');\n\n  const params = (event.pathParameters as Record<string, string | null> | null) ?? {};\n  const category = params?.category ?? '';\n  const query = category ? { category } : {};\n\n  // Leitura intensiva distribuída pelas réplicas\n  const docs = await collection.find(query).sort({ createdAt: -1 }).limit(50).toArray();\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ count: docs.length, items: docs }),\n  };\n};\n"
    },
    "notes": [
      "instances:3 gera 1 primária + 2 réplicas de leitura — DocumentDB numera as instâncias automaticamente como <cluster-id>-1, -2, -3.",
      "readPreference=secondaryPreferred deve aparecer TANTO na URI string QUANTO em MongoClient options para garantir que o driver respeite a preferência mesmo em reconexões.",
      "O endpoint exposto pelo synth (ref 'Endpoint') é o cluster endpoint, que roteia writes para a primária — para reads em réplicas específicas use os reader endpoints disponíveis no console, mas o secondaryPreferred na URI já resolve isso automaticamente.",
      "retryWrites=false é obrigatório em todos os cenários DocumentDB — o driver MongoDB nativo tenta retryable writes por padrão desde a versão 4.x e o DocumentDB rejeita com 'Unrecognized field: lsid'.",
      "replicaSet=rs0 é obrigatório mesmo com instância única — sem ele o driver trata o nó como standalone e não consegue executar operações em sessão.",
      "A senha do docdbadmin é gerada e armazenada automaticamente pelo synth no Secrets Manager com o nome <stack>-ReplicaDocDb-docdb-password — nunca passe a senha em plaintext no environment da Lambda."
    ]
  },
  {
    "id": "aws-database-documentdb-3",
    "title": "DocumentDB com backup retention de 7 dias e deletion protection",
    "provider": "aws",
    "constructs": [
      "Database.DocumentDB",
      "Function.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "documentdb",
      "mongodb",
      "backup",
      "retention",
      "deletion-protection",
      "production",
      "database.documentdb",
      "function.lambda",
      "policy.iam"
    ],
    "validated": false,
    "stacks": {
      "stacks/database/docdb-backup-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('docdb-backup');\n\n// backupRetentionDays é lido pelo synth (CloudFormation: BackupRetentionPeriod)\n// mas não está declarado na interface TypeScript — cast necessário\nnew Database.DocumentDB(stack, 'ProdDocDb', {\n  instanceType: 'db.r5.large',\n  instances: 2,\n  deletionProtection: true,\n  backupRetentionDays: 7,\n} as any);\n\nexport default stack;\n",
      "stacks/compute/docdb-backup-lambda-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('docdb-backup-lambda');\n\nnew Fn.Lambda(stack, 'DocDbProdFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/docdbBackupQuery.handler',\n  code: '.',\n  timeout: 30,\n  memory: 512,\n  environment: {\n    DOCDB_ENDPOINT: ref('ProdDocDb', 'Endpoint'),\n    DOCDB_PORT: ref('ProdDocDb', 'Port'),\n    DOCDB_SECRET_ARN: ref('ProdDocDb', 'SecretArn'),\n  },\n});\n\nexport default stack;\n",
      "stacks/policy/docdb-backup-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('docdb-backup-policy');\n\nnew Policy.IAM(stack, 'DocDbProdPolicy', {\n  attachTo: 'DocDbProdFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['secretsmanager:GetSecretValue'],\n      resources: [ref('ProdDocDb', 'SecretArn')],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/docdbBackupQuery.ts": "import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';\nimport { MongoClient } from 'mongodb';\nimport * as path from 'path';\n\nconst secretsClient = new SecretsManagerClient({});\n\nlet cachedClient: MongoClient | null = null;\n\nasync function getMongoClient(): Promise<MongoClient> {\n  if (cachedClient) return cachedClient;\n\n  const secretArn = process.env.DOCDB_SECRET_ARN ?? '';\n  const endpoint = process.env.DOCDB_ENDPOINT ?? '';\n  const port = process.env.DOCDB_PORT ?? '27017';\n\n  const result = await secretsClient.send(\n    new GetSecretValueCommand({ SecretId: secretArn }),\n  );\n  const { password } = JSON.parse(result.SecretString ?? '{}');\n\n  const caFilePath = path.join(__dirname, '..', 'global-bundle.pem');\n\n  const uri =\n    `mongodb://docdbadmin:${encodeURIComponent(password)}@${endpoint}:${port}` +\n    '/?replicaSet=rs0&retryWrites=false';\n\n  const client = new MongoClient(uri, {\n    tls: true,\n    tlsCAFile: caFilePath,\n    retryWrites: false,\n  });\n\n  await client.connect();\n  cachedClient = client;\n  return client;\n}\n\nexport const handler = async (event: Record<string, unknown>) => {\n  const client = await getMongoClient();\n  const db = client.db('prodapp');\n  const collection = db.collection('orders');\n\n  const params = (event.pathParameters as Record<string, string | null> | null) ?? {};\n  const orderId = params?.id ?? '';\n\n  if (!orderId) {\n    return {\n      statusCode: 400,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'orderId obrigatório' }),\n    };\n  }\n\n  const order = await collection.findOne({ orderId });\n\n  return {\n    statusCode: order ? 200 : 404,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify(order ?? { error: 'not found' }),\n  };\n};\n"
    },
    "notes": [
      "backupRetentionDays não está declarado na interface DatabaseDocumentDBProps mas é lido pelo synth (cloudformation.ts: BackupRetentionPeriod) — o cast `as any` é necessário até a interface ser atualizada.",
      "deletionProtection:true gera DeletionPolicy:'Retain' no CloudFormation E habilita DeletionProtection no cluster — o destroy via iacmp falha com UPDATE_FAILED até deletionProtection ser desabilitado manualmente no console antes do destroy.",
      "backupRetentionDays aceita valores de 1 a 35 dias — o default do synth é 1 quando omitido; valores acima de 35 são rejeitados pela API da AWS com InvalidParameterCombination.",
      "O instanceType 'db.r5.large' é recomendado para produção — 'db.t3.medium' tem créditos de CPU que se esgotam em workloads contínuos e causam throttling silencioso.",
      "Para restaurar a partir de backup, use o console AWS ou boto3/CLI — o iacmp não expõe construct de restore point-in-time; o cluster restaurado deve ser criado fora do iacmp e referenciado por literal ID se necessário.",
      "A senha do master user (docdbadmin) NÃO é rotacionada automaticamente pelo DocumentDB — configure rotação via Lambda de rotação no Secrets Manager se necessário para compliance."
    ]
  },
  {
    "id": "aws-events-eventbridge-1",
    "title": "EventBridge rate rule disparando Lambda de limpeza a cada hora",
    "provider": "aws",
    "constructs": [
      "Events.EventBridge",
      "Fn.Lambda",
      "Database.DynamoDB",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "eventbridge",
      "lambda",
      "dynamodb",
      "rate",
      "cron",
      "scheduled",
      "cleanup"
    ],
    "validated": false,
    "stacks": {
      "stacks/database/cleanup-events-table-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('cleanup-events-table');\n\nnew Database.DynamoDB(stack, 'EventsTable', {\n  partitionKey: 'eventId',\n  sortKey: 'timestamp',\n  billingMode: 'PAY_PER_REQUEST',\n});\n\nexport default stack;\n",
      "stacks/compute/hourly-cleanup-lambda-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('hourly-cleanup-lambda');\n\nnew Fn.Lambda(stack, 'HourlyCleanupFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/hourlyCleanup.handler',\n  code: '.',\n  timeout: 60,\n  memory: 128,\n  environment: {\n    TABLE_NAME: ref('EventsTable', 'Name'),\n  },\n});\n\nexport default stack;\n",
      "stacks/policy/hourly-cleanup-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('hourly-cleanup-policy');\n\nnew Policy.IAM(stack, 'HourlyCleanupFnPolicy', {\n  attachTo: 'HourlyCleanupFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['dynamodb:Scan', 'dynamodb:DeleteItem'],\n      resources: [ref('EventsTable', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/compute/hourly-cleanup-schedule-stack.ts": "import { Stack, Events } from '@iacmp/core';\n\nconst stack = new Stack('hourly-cleanup-schedule');\n\nnew Events.EventBridge(stack, 'HourlyScheduler', {\n  rules: [\n    {\n      name: 'hourly-cleanup-rule',\n      rate: '1 hour',\n      targetLambdaId: 'HourlyCleanupFn',\n      description: 'Executa limpeza de eventos expirados a cada hora',\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/hourlyCleanup.ts": "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nimport { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';\n\nconst client = new DynamoDBClient({});\nconst ddb = DynamoDBDocumentClient.from(client);\n\nconst TABLE_NAME = process.env.TABLE_NAME ?? '';\nconst RETENTION_MS = 24 * 60 * 60 * 1000;\n\nexport const handler = async (): Promise<void> => {\n  const cutoff = Date.now() - RETENTION_MS;\n\n  const { Items = [] } = await ddb.send(new ScanCommand({\n    TableName: TABLE_NAME,\n    FilterExpression: '#ts < :cutoff',\n    ExpressionAttributeNames: { '#ts': 'timestamp' },\n    ExpressionAttributeValues: { ':cutoff': cutoff.toString() },\n  }));\n\n  console.log(`[hourlyCleanup] ${Items.length} evento(s) expirado(s)`);\n\n  for (const item of Items) {\n    await ddb.send(new DeleteCommand({\n      TableName: TABLE_NAME,\n      Key: { eventId: item['eventId'], timestamp: item['timestamp'] },\n    }));\n  }\n\n  console.log('[hourlyCleanup] limpeza concluída');\n};\n"
    },
    "notes": [
      "rate: '1 hour' é o valor cru — o synth envolve com rate(...). Nunca escrever 'rate(1 hour)' diretamente no prop, CloudFormation vai receber rate(rate(1 hour)).",
      "O synth normaliza plural/singular automaticamente: rate: '1 hours' → rate(1 hour). AWS rejeita rate(1 hours) em deploy.",
      "targetLambdaId referencia o id do construct Fn.Lambda — o synth resolve o ARN via Fn::GetAtt e cria a Lambda::Permission com Principal events.amazonaws.com automaticamente.",
      "Rate rules usam o default bus — NUNCA definir busName em regras de agendamento. O synth omite EventBusName quando scheduleExpression está presente.",
      "Policy separada por Lambda (regra inegociável): nunca compartilhar uma Policy.IAM entre HourlyCleanupFn e outra Lambda.",
      "DynamoDB Scan com FilterExpression não substitui index: para tabelas grandes, adicionar GSI com TTL nativo e usar dynamodb:DeleteItem em vez de Scan."
    ]
  },
  {
    "id": "aws-events-eventbridge-2",
    "title": "EventBridge rule com event pattern filtrando eventos Object Created do S3",
    "provider": "aws",
    "constructs": [
      "Events.EventBridge",
      "Fn.Lambda",
      "Storage.Bucket",
      "Database.DynamoDB",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "eventbridge",
      "s3",
      "lambda",
      "dynamodb",
      "eventpattern",
      "filter",
      "objectcreated"
    ],
    "validated": false,
    "stacks": {
      "stacks/storage/media-uploads-bucket-stack.ts": "import { Stack, Storage } from '@iacmp/core';\n\nconst stack = new Stack('media-uploads-bucket');\n\nnew Storage.Bucket(stack, 'MediaUploadsBucket', {\n  versioning: true,\n  publicAccess: false,\n});\n\nexport default stack;\n",
      "stacks/database/upload-metadata-table-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('upload-metadata-table');\n\nnew Database.DynamoDB(stack, 'UploadMetadataTable', {\n  partitionKey: 'objectKey',\n  billingMode: 'PAY_PER_REQUEST',\n});\n\nexport default stack;\n",
      "stacks/compute/s3-event-processor-lambda-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('s3-event-processor-lambda');\n\nnew Fn.Lambda(stack, 'S3EventProcessorFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/processS3Event.handler',\n  code: '.',\n  timeout: 30,\n  memory: 128,\n  environment: {\n    BUCKET_NAME: ref('MediaUploadsBucket', 'Name'),\n    TABLE_NAME: ref('UploadMetadataTable', 'Name'),\n  },\n});\n\nexport default stack;\n",
      "stacks/policy/s3-event-processor-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('s3-event-processor-policy');\n\nnew Policy.IAM(stack, 'S3EventProcessorFnPolicy', {\n  attachTo: 'S3EventProcessorFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['s3:HeadObject', 's3:GetObject'],\n      resources: ['MediaUploadsBucket/*'],\n    },\n    {\n      effect: 'Allow',\n      actions: ['dynamodb:PutItem'],\n      resources: [ref('UploadMetadataTable', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/compute/s3-event-bridge-rule-stack.ts": "import { Stack, Events } from '@iacmp/core';\n\nconst stack = new Stack('s3-event-bridge-rule');\n\nnew Events.EventBridge(stack, 'S3ObjectCreatedRule', {\n  rules: [\n    {\n      name: 's3-object-created-rule',\n      source: ['aws.s3'],\n      detailTypes: ['Object Created'],\n      targetLambdaId: 'S3EventProcessorFn',\n      description: 'Filtra eventos Object Created do S3 e invoca o processor',\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/processS3Event.ts": "import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';\nimport { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nimport { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';\n\nconst s3 = new S3Client({});\nconst ddbClient = new DynamoDBClient({});\nconst ddb = DynamoDBDocumentClient.from(ddbClient);\n\nconst TABLE_NAME = process.env.TABLE_NAME ?? '';\n\ninterface S3EventBridgeEvent {\n  source: string;\n  'detail-type': string;\n  time: string;\n  detail: {\n    bucket: { name: string };\n    object: { key: string; size: number; etag: string };\n  };\n}\n\nexport const handler = async (event: S3EventBridgeEvent): Promise<void> => {\n  const { bucket, object } = event.detail;\n  const bucketName = bucket.name;\n  const key = object.key;\n\n  console.log(`[processS3Event] ${event['detail-type']}: s3://${bucketName}/${key}`);\n\n  const meta = await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));\n\n  await ddb.send(new PutCommand({\n    TableName: TABLE_NAME,\n    Item: {\n      objectKey: key,\n      bucketName,\n      contentType: meta.ContentType ?? 'application/octet-stream',\n      contentLength: meta.ContentLength ?? 0,\n      etag: meta.ETag ?? '',\n      processedAt: new Date().toISOString(),\n    },\n  }));\n\n  console.log(`[processS3Event] metadata salvo: key=${key} size=${meta.ContentLength}`);\n};\n"
    },
    "notes": [
      "S3 EventBridge integration NÃO é exposta pelo Storage.Bucket construct — habilitar via CLI antes do deploy: aws s3api put-bucket-notification-configuration --bucket <nome> --notification-configuration '{\"EventBridgeConfiguration\": {}}'",
      "detailTypes: ['Object Created'] (com espaço) é o nome exato do evento EventBridge S3 — NÃO usar 'ObjectCreated' sem espaço (esse é o formato de S3 Event Notification direto, não EventBridge).",
      "Rule com source/detailTypes (event pattern) deve estar no DEFAULT bus — NUNCA definir busName para eventos aws.s3 que chegam pelo bus padrão da AWS.",
      "'MediaUploadsBucket/*' em resources do Policy.IAM é resolvido pelo synth para Fn::Sub ['${BArn}/*', ...] — NUNCA usar o nome físico do bucket como string literal.",
      "O synth omite EventBusName na rule quando busName é 'default' ou omitido — comportamento correto, a rule herda o default bus.",
      "Filtro por bucket específico via campo detail (ex: detail.bucket.name = 'meu-bucket') não é suportado pelo construct EventBridgeRule — ainda não há prop detail/eventPattern livre. Para isso usar um segundo filtro dentro do handler ou aguardar suporte no iacmp."
    ]
  },
  {
    "id": "aws-events-eventbridge-3",
    "title": "EventBridge rule cross-account roteando OrderPlaced para Lambda em conta externa",
    "provider": "aws",
    "constructs": [
      "Events.EventBridge",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "eventbridge",
      "lambda",
      "crossaccount",
      "eventpattern",
      "putevents",
      "custombus"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/cross-account-orders-rule-stack.ts": "import { Stack, Events } from '@iacmp/core';\n\nconst stack = new Stack('cross-account-orders-rule');\n\nnew Events.EventBridge(stack, 'OrdersBus', {\n  busName: 'orders-bus',\n  rules: [\n    {\n      name: 'cross-account-order-placed-rule',\n      source: ['myapp.orders'],\n      detailTypes: ['OrderPlaced'],\n      targetArn: 'arn:aws:lambda:us-east-1:222222222222:function:CrossAccountOrdersProcessorFn',\n      description: 'Encaminha OrderPlaced para a Lambda de processamento na conta B',\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/compute/orders-event-publisher-lambda-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('orders-event-publisher-lambda');\n\nnew Fn.Lambda(stack, 'OrdersEventPublisherFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/ordersEventPublisher.handler',\n  code: '.',\n  timeout: 30,\n  memory: 128,\n  environment: {\n    EVENT_BUS_NAME: 'orders-bus',\n  },\n});\n\nexport default stack;\n",
      "stacks/policy/orders-event-publisher-policy-stack.ts": "import { Stack, Policy } from '@iacmp/core';\n\nconst stack = new Stack('orders-event-publisher-policy');\n\nnew Policy.IAM(stack, 'OrdersEventPublisherFnPolicy', {\n  attachTo: 'OrdersEventPublisherFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['events:PutEvents'],\n      resources: ['*'],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/ordersEventPublisher.ts": "import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';\n\nconst eb = new EventBridgeClient({});\nconst EVENT_BUS_NAME = process.env.EVENT_BUS_NAME ?? '';\n\ninterface OrderItem {\n  sku: string;\n  qty: number;\n  price: number;\n}\n\ninterface OrderPayload {\n  orderId: string;\n  customerId: string;\n  totalAmount: number;\n  items: OrderItem[];\n}\n\nexport const handler = async (order: OrderPayload): Promise<void> => {\n  const result = await eb.send(new PutEventsCommand({\n    Entries: [\n      {\n        EventBusName: EVENT_BUS_NAME,\n        Source: 'myapp.orders',\n        DetailType: 'OrderPlaced',\n        Detail: JSON.stringify(order),\n        Time: new Date(),\n      },\n    ],\n  }));\n\n  const failed = result.FailedEntryCount ?? 0;\n  if (failed > 0) {\n    throw new Error(`[ordersEventPublisher] ${failed} entrada(s) falharam no PutEvents`);\n  }\n\n  console.log(`[ordersEventPublisher] OrderPlaced publicado: orderId=${order.orderId}`);\n};\n"
    },
    "notes": [
      "targetArn com ARN literal de outra conta: o synth NÃO cria Lambda::Permission — é responsabilidade do owner da conta B executar: aws lambda add-permission --function-name CrossAccountOrdersProcessorFn --statement-id allow-from-account-a --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn <rule-arn> --source-account <account-a-id>",
      "Events.EventBridge não tem atributos referenciáveis no RESOLVE_MAP do provider AWS — ref('OrdersBus', 'Arn') lança erro em synth. Única opção para resources do Policy.IAM de events:PutEvents é '*'.",
      "EVENT_BUS_NAME como literal string na env var é aceito pois Events.EventBridge não expõe ref de atributo Name — não há alternativa dinâmica disponível no iacmp atual.",
      "busName: 'orders-bus' cria um custom AWS::Events::EventBus. Rules de event pattern em custom bus recebem EventBusName: <Ref bus> automaticamente pelo synth. Regras de schedule (cron/rate) NUNCA recebem EventBusName.",
      "Para cross-account via bus intermediário (conta A → bus conta B → Lambda conta B), usar targetArn apontando para o ARN do bus da conta B e configurar resource policy: aws events put-permission --event-bus-name orders-bus --action events:PutEvents --principal <account-a-id> --statement-id allow-account-a",
      "source e detailTypes geram EventPattern como objeto JSON no CloudFormation — o synth faz a serialização correta. Nunca passar EventPattern como string JSON no prop."
    ]
  },
  {
    "id": "aws-logging-stream-1",
    "title": "Log Group para Lambda com retention 7 dias",
    "provider": "aws",
    "constructs": [
      "Logging.Stream",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "logging.stream",
      "fn.lambda",
      "policy.iam",
      "cloudwatch",
      "retention",
      "log-group"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/processor-log-group-stack.ts": "import { Stack, Logging } from '@iacmp/core';\n\nconst stack = new Stack('processor-log-group');\n\nnew Logging.Stream(stack, 'ProcessorLogs', {\n  retentionDays: 7,\n});\n\nexport default stack;",
      "stacks/compute/processor-lambda-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('processor-lambda');\n\nnew Fn.Lambda(stack, 'ProcessorFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/processor.handler',\n  code: '.',\n  environment: {\n    LOG_GROUP_NAME: '/iacmp/ProcessorLogs',\n  },\n});\n\nexport default stack;",
      "stacks/policy/processor-policy-stack.ts": "import { Stack, Policy } from '@iacmp/core';\n\nconst stack = new Stack('processor-policy');\n\nnew Policy.IAM(stack, 'ProcessorPolicy', {\n  attachTo: 'ProcessorFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'logs:CreateLogStream',\n        'logs:PutLogEvents',\n        'logs:DescribeLogStreams',\n      ],\n      resources: ['*'],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/processor.ts": "import {\n  CloudWatchLogsClient,\n  CreateLogStreamCommand,\n  PutLogEventsCommand,\n} from '@aws-sdk/client-cloudwatch-logs';\n\nconst logs = new CloudWatchLogsClient({});\nconst LOG_GROUP = process.env.LOG_GROUP_NAME ?? '/iacmp/ProcessorLogs';\n\nexport async function handler(event: Record<string, unknown>): Promise<{ statusCode: number }> {\n  const streamName = new Date().toISOString().slice(0, 10);\n  try {\n    await logs.send(new CreateLogStreamCommand({\n      logGroupName: LOG_GROUP,\n      logStreamName: streamName,\n    }));\n  } catch (err: unknown) {\n    const code = (err as { name?: string }).name;\n    if (code !== 'ResourceAlreadyExistsException') throw err;\n  }\n  await logs.send(new PutLogEventsCommand({\n    logGroupName: LOG_GROUP,\n    logStreamName: streamName,\n    logEvents: [{ timestamp: Date.now(), message: JSON.stringify({ level: 'INFO', event }) }],\n  }));\n  return { statusCode: 200 };\n}"
    },
    "notes": [
      "Logging.Stream cria o log group em /iacmp/{constructId} — não em /aws/lambda/{functionName}. Para gerenciar retenção do log group nativo da Lambda, crie um Custom.Resource com AWS::Logs::LogGroup e LogGroupName: /aws/lambda/{nome-da-funcao} antes do primeiro deploy.",
      "retentionDays aceita apenas os valores literais da union type (1, 3, 5, 7, 14, 30, 60, 90…). Valor arbitrário como 10 causa erro de TypeScript no synth antes de chegar no CloudFormation.",
      "Logging.Stream não está no ConstructAttributeMap do @iacmp/core, portanto ref('ProcessorLogs', 'Arn') falha em synth com 'Tipo Logging.Stream não tem atributos referenciáveis'. Use '*' em resources de Policy.IAM para permissões de CloudWatch Logs.",
      "CreateLogStreamCommand lança ResourceAlreadyExistsException se o stream já existe no mesmo dia. Sempre capturar este erro pelo name, nunca suprimir todos os erros indiscriminadamente."
    ]
  },
  {
    "id": "aws-logging-stream-2",
    "title": "Log Group com metric filter gerando CloudWatch metric e alarme",
    "provider": "aws",
    "constructs": [
      "Logging.Stream",
      "Custom.Resource",
      "Monitoring.Alarm",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "logging.stream",
      "custom.resource",
      "monitoring.alarm",
      "fn.lambda",
      "policy.iam",
      "cloudwatch",
      "metric-filter",
      "alarm"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/api-log-group-stack.ts": "import { Stack, Logging } from '@iacmp/core';\n\nconst stack = new Stack('api-log-group');\n\nnew Logging.Stream(stack, 'ApiLogs', {\n  retentionDays: 30,\n});\n\nexport default stack;",
      "stacks/compute/api-lambda-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('api-lambda');\n\nnew Fn.Lambda(stack, 'ApiHandlerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/apiHandler.handler',\n  code: '.',\n  timeout: 30,\n  environment: {\n    LOG_GROUP_NAME: '/iacmp/ApiLogs',\n  },\n});\n\nexport default stack;",
      "stacks/compute/error-metric-filter-stack.ts": "import { Stack, Custom } from '@iacmp/core';\n\nconst stack = new Stack('error-metric-filter');\n\nnew Custom.Resource(stack, 'ApiErrorMetricFilter', {\n  cloudformation: {\n    type: 'AWS::Logs::MetricFilter',\n    properties: {\n      LogGroupName: '/iacmp/ApiLogs',\n      FilterPattern: '{ $.level = \"ERROR\" }',\n      MetricTransformations: [\n        {\n          MetricName: 'ApiErrorCount',\n          MetricNamespace: 'IaCMP/Api',\n          MetricValue: '1',\n          DefaultValue: 0,\n          Unit: 'Count',\n        },\n      ],\n    },\n  },\n});\n\nexport default stack;",
      "stacks/compute/error-alarm-stack.ts": "import { Stack, Monitoring } from '@iacmp/core';\n\nconst stack = new Stack('error-alarm');\n\nnew Monitoring.Alarm(stack, 'ApiErrorAlarm', {\n  metricName: 'ApiErrorCount',\n  namespace: 'IaCMP/Api',\n  threshold: 5,\n  evaluationPeriods: 2,\n  periodSeconds: 300,\n  comparisonOperator: 'GreaterThanOrEqualToThreshold',\n  treatMissingData: 'notBreaching',\n});\n\nexport default stack;",
      "stacks/policy/api-policy-stack.ts": "import { Stack, Policy } from '@iacmp/core';\n\nconst stack = new Stack('api-policy');\n\nnew Policy.IAM(stack, 'ApiHandlerPolicy', {\n  attachTo: 'ApiHandlerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'logs:CreateLogStream',\n        'logs:PutLogEvents',\n        'logs:DescribeLogStreams',\n      ],\n      resources: ['*'],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/apiHandler.ts": "import {\n  CloudWatchLogsClient,\n  CreateLogStreamCommand,\n  PutLogEventsCommand,\n} from '@aws-sdk/client-cloudwatch-logs';\n\nconst logs = new CloudWatchLogsClient({});\nconst LOG_GROUP = process.env.LOG_GROUP_NAME ?? '/iacmp/ApiLogs';\n\nexport async function handler(event: {\n  httpMethod?: string;\n  path?: string;\n  body?: string;\n}): Promise<{ statusCode: number; body: string }> {\n  const streamName = new Date().toISOString().slice(0, 10);\n  const isError = !event.path?.startsWith('/');\n  const level = isError ? 'ERROR' : 'INFO';\n\n  try {\n    await logs.send(new CreateLogStreamCommand({\n      logGroupName: LOG_GROUP,\n      logStreamName: streamName,\n    }));\n  } catch (err: unknown) {\n    const code = (err as { name?: string }).name;\n    if (code !== 'ResourceAlreadyExistsException') throw err;\n  }\n\n  await logs.send(new PutLogEventsCommand({\n    logGroupName: LOG_GROUP,\n    logStreamName: streamName,\n    logEvents: [{\n      timestamp: Date.now(),\n      message: JSON.stringify({\n        level,\n        method: event.httpMethod ?? 'UNKNOWN',\n        path: event.path ?? '/',\n      }),\n    }],\n  }));\n\n  return {\n    statusCode: isError ? 400 : 200,\n    body: JSON.stringify({ ok: !isError }),\n  };\n}"
    },
    "notes": [
      "O LogGroupName em AWS::Logs::MetricFilter é hardcoded como '/iacmp/ApiLogs'. Se o id do construct Logging.Stream mudar, o MetricFilter aponta para um log group inexistente — falha silenciosa em deploy, sem erro de synth.",
      "FilterPattern usa sintaxe JSON do CloudWatch Logs: { $.campo = \"valor\" }. Pattern vazio '' captura todos os eventos. Campos sem prefixo $ são tratados como texto livre (não JSON).",
      "Monitoring.Alarm referencia a metric por metricName + namespace: ambos devem coincidir exatamente com os valores em MetricTransformations (case-sensitive). Discrepância resulta em alarme que nunca dispara.",
      "Custom.Resource com AWS::Logs::MetricFilter não exporta atributos referenciáveis via ref() — o Monitoring.Alarm recebe metricName e namespace como strings literais, criando acoplamento implícito entre as stacks.",
      "O MetricFilter só processa eventos novos após a criação. Logs anteriores ao deploy não alimentam a métrica ApiErrorCount."
    ]
  },
  {
    "id": "aws-logging-stream-3",
    "title": "Log Group exportado para S3 via Lambda agendada",
    "provider": "aws",
    "constructs": [
      "Logging.Stream",
      "Storage.Bucket",
      "Custom.Resource",
      "Fn.Lambda",
      "Events.EventBridge",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "logging.stream",
      "storage.bucket",
      "custom.resource",
      "fn.lambda",
      "events.eventbridge",
      "policy.iam",
      "cloudwatch",
      "s3",
      "export",
      "schedule"
    ],
    "validated": false,
    "stacks": {
      "stacks/storage/log-archive-bucket-stack.ts": "import { Stack, Storage, Custom } from '@iacmp/core';\n\nconst stack = new Stack('log-archive-bucket');\n\nnew Storage.Bucket(stack, 'LogArchiveBucket', {\n  versioning: false,\n  lifecycleRules: [\n    { expireAfterDays: 365 },\n  ],\n});\n\nnew Custom.Resource(stack, 'LogArchiveBucketPolicy', {\n  cloudformation: {\n    type: 'AWS::S3::BucketPolicy',\n    properties: {\n      Bucket: { Ref: 'LogArchiveBucket' },\n      PolicyDocument: {\n        Version: '2012-10-17',\n        Statement: [\n          {\n            Effect: 'Allow',\n            Principal: {\n              Service: { 'Fn::Sub': 'logs.${AWS::Region}.amazonaws.com' },\n            },\n            Action: 's3:PutObject',\n            Resource: {\n              'Fn::Join': ['', [{ 'Fn::GetAtt': ['LogArchiveBucket', 'Arn'] }, '/*']],\n            },\n            Condition: {\n              StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' },\n            },\n          },\n        ],\n      },\n    },\n  },\n});\n\nexport default stack;",
      "stacks/compute/app-log-group-stack.ts": "import { Stack, Logging } from '@iacmp/core';\n\nconst stack = new Stack('app-log-group');\n\nnew Logging.Stream(stack, 'AppLogs', {\n  retentionDays: 90,\n});\n\nexport default stack;",
      "stacks/compute/log-export-lambda-stack.ts": "import { Stack, Fn, Events, ref } from '@iacmp/core';\n\nconst stack = new Stack('log-export-lambda');\n\nnew Fn.Lambda(stack, 'LogExportFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/logExporter.handler',\n  code: '.',\n  timeout: 300,\n  environment: {\n    LOG_GROUP_NAME: '/iacmp/AppLogs',\n    EXPORT_BUCKET: ref('LogArchiveBucket', 'Name'),\n  },\n});\n\nnew Events.EventBridge(stack, 'LogExportSchedule', {\n  rules: [\n    {\n      name: 'DailyLogExport',\n      rate: '1 day',\n      targetLambdaId: 'LogExportFn',\n      description: 'Exporta logs do dia anterior para S3 diariamente',\n    },\n  ],\n});\n\nexport default stack;",
      "stacks/policy/log-export-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('log-export-policy');\n\nnew Policy.IAM(stack, 'LogExportPolicy', {\n  attachTo: 'LogExportFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'logs:CreateExportTask',\n        'logs:DescribeExportTasks',\n        'logs:DescribeLogGroups',\n      ],\n      resources: ['*'],\n    },\n    {\n      effect: 'Allow',\n      actions: ['s3:PutObject'],\n      resources: ['LogArchiveBucket/*'],\n    },\n    {\n      effect: 'Allow',\n      actions: ['s3:GetBucketAcl'],\n      resources: [ref('LogArchiveBucket', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/logExporter.ts": "import {\n  CloudWatchLogsClient,\n  CreateExportTaskCommand,\n} from '@aws-sdk/client-cloudwatch-logs';\n\nconst logs = new CloudWatchLogsClient({});\n\nexport async function handler(): Promise<{ taskId: string | undefined }> {\n  const logGroupName = process.env.LOG_GROUP_NAME ?? '/iacmp/AppLogs';\n  const destination = process.env.EXPORT_BUCKET ?? '';\n\n  const yesterday = new Date();\n  yesterday.setDate(yesterday.getDate() - 1);\n  yesterday.setHours(0, 0, 0, 0);\n\n  const fromTime = yesterday.getTime();\n  const toTime = fromTime + 86_400_000;\n  const dateStr = yesterday.toISOString().slice(0, 10);\n\n  const { taskId } = await logs.send(new CreateExportTaskCommand({\n    logGroupName,\n    destination,\n    destinationPrefix: `logs/${dateStr}`,\n    from: fromTime,\n    to: toTime,\n  }));\n\n  console.log(JSON.stringify({ taskId, logGroupName, destination, date: dateStr }));\n  return { taskId };\n}"
    },
    "notes": [
      "CreateExportTask é assíncrono: o taskId retornado indica apenas o início. A conclusão leva de 5 a 15 minutos dependendo do volume. Para aguardar, use DescribeExportTasksCommand em polling com status COMPLETED ou FAILED.",
      "O bucket S3 obrigatoriamente precisa de uma bucket policy permitindo logs.{region}.amazonaws.com fazer s3:PutObject com condição s3:x-amz-acl: bucket-owner-full-control. Sem essa policy, CreateExportTask retorna InvalidOperationException em runtime, sem falha no deploy.",
      "O Custom.Resource LogArchiveBucketPolicy usa Ref: 'LogArchiveBucket' e Fn::GetAtt: ['LogArchiveBucket', 'Arn'] que referenciam o logical ID CloudFormation gerado pelo synth (construct id sem caracteres especiais). Se o construct id mudar, atualizar as referências na bucket policy.",
      "subscriptionFilters.destinationArn em LoggingStreamProps é string puro — não aceita ref(). Para apontar uma Lambda cross-stack como destino de subscription filter em tempo real, use Custom.Resource com AWS::Logs::SubscriptionFilter e inclua Fn::ImportValue manualmente no destinationArn.",
      "A string 'LogArchiveBucket/*' em resources de Policy.IAM é resolvida pelo synth para { Fn::Sub: ['${BArn}/*', { BArn: Fn::ImportValue }] } via resolvePolicyResource — este é o único caso onde string de construct em resources é válido (o synth reconhece o padrão {id}/{path} para Storage.Bucket).",
      "LOG_GROUP_NAME está hardcoded como '/iacmp/AppLogs' no handler. Se o id do construct Logging.Stream mudar para outro valor, o env var no log-export-lambda-stack.ts também precisa ser atualizado manualmente."
    ]
  },
  {
    "id": "aws-messaging-queue-1",
    "title": "SQS com Lambda consumer via event source mapping e Policy",
    "provider": "aws",
    "constructs": [
      "Messaging.Queue",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "sqs",
      "messaging.queue",
      "fn.lambda",
      "policy.iam",
      "event-source-mapping",
      "esm"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/orders-queue-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\nconst stack = new Stack('orders-queue');\nnew Messaging.Queue(stack, 'OrdersQueue', {\n  visibilityTimeoutSeconds: 30,\n  messageRetentionSeconds: 86400,\n  encrypted: true,\n});\nexport default stack;",
      "stacks/compute/orders-producer-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\nconst stack = new Stack('orders-producer');\nnew Fn.Lambda(stack, 'OrdersProducerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/ordersProducer.handler',\n  code: '.',\n  timeout: 30,\n  environment: {\n    QUEUE_URL: ref('OrdersQueue', 'QueueUrl'),\n  },\n});\nexport default stack;",
      "stacks/compute/orders-consumer-stack.ts": "import { Stack, Fn } from '@iacmp/core';\nconst stack = new Stack('orders-consumer');\nnew Fn.Lambda(stack, 'OrdersConsumerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/ordersConsumer.handler',\n  code: '.',\n  timeout: 60,\n  eventSources: [\n    {\n      queueId: 'OrdersQueue',\n      batchSize: 10,\n      maxBatchingWindowSeconds: 5,\n    },\n  ],\n});\nexport default stack;",
      "stacks/policy/orders-producer-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\nconst stack = new Stack('orders-producer-policy');\nnew Policy.IAM(stack, 'OrdersProducerPolicy', {\n  attachTo: 'OrdersProducerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['sqs:SendMessage'],\n      resources: [ref('OrdersQueue', 'Arn')],\n    },\n  ],\n});\nexport default stack;",
      "stacks/policy/orders-consumer-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\nconst stack = new Stack('orders-consumer-policy');\nnew Policy.IAM(stack, 'OrdersConsumerPolicy', {\n  attachTo: 'OrdersConsumerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],\n      resources: [ref('OrdersQueue', 'Arn')],\n    },\n  ],\n});\nexport default stack;"
    },
    "handlers": {
      "src/ordersProducer.ts": "import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';\n\nconst sqs = new SQSClient({});\n\nexport async function handler(event: { orderId: string; amount: number }) {\n  await sqs.send(new SendMessageCommand({\n    QueueUrl: process.env.QUEUE_URL,\n    MessageBody: JSON.stringify({ orderId: event.orderId, amount: event.amount }),\n  }));\n  return { statusCode: 200 };\n}",
      "src/ordersConsumer.ts": "import type { SQSEvent } from 'aws-lambda';\n\nexport async function handler(event: SQSEvent) {\n  for (const record of event.Records) {\n    const body = JSON.parse(record.body);\n    console.log('Processing order:', body.orderId, 'amount:', body.amount);\n  }\n}"
    },
    "notes": [
      "sqs:GetQueueAttributes é obrigatória junto com sqs:ReceiveMessage e sqs:DeleteMessage para o ESM funcionar — o serviço Lambda usa essa action para inspecionar a fila antes de criar o mapping",
      "visibilityTimeoutSeconds da fila deve ser >= timeout da Lambda consumer; se a Lambda ultrapassar o visibility timeout a mensagem rereaparece na fila e é processada novamente",
      "queueId em eventSources aceita string com o id do construct (ex: 'OrdersQueue') ou o getter queue.arn — o synth resolve o ARN internamente via GetAtt; nunca passar string com ARN hardcoded",
      "A Lambda consumer NÃO precisa chamar DeleteMessage no código: o ESM deleta automaticamente as mensagens do batch quando a função retorna sem erro",
      "maxBatchingWindowSeconds adiciona latência mas reduz custo de invocações ao acumular mensagens antes de disparar — zero em cenários de baixa latência"
    ]
  },
  {
    "id": "aws-messaging-queue-2",
    "title": "SQS FIFO com deduplication e Lambda consumer",
    "provider": "aws",
    "constructs": [
      "Messaging.Queue",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "sqs",
      "messaging.queue",
      "fn.lambda",
      "policy.iam",
      "fifo",
      "deduplication",
      "ordering"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/payments-queue-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\nconst stack = new Stack('payments-queue');\nnew Messaging.Queue(stack, 'PaymentsQueue', {\n  fifo: true,\n  encrypted: true,\n  visibilityTimeoutSeconds: 60,\n  messageRetentionSeconds: 345600,\n});\nexport default stack;",
      "stacks/compute/payments-producer-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\nconst stack = new Stack('payments-producer');\nnew Fn.Lambda(stack, 'PaymentsProducerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/paymentsProducer.handler',\n  code: '.',\n  timeout: 30,\n  environment: {\n    QUEUE_URL: ref('PaymentsQueue', 'QueueUrl'),\n  },\n});\nexport default stack;",
      "stacks/compute/payments-consumer-stack.ts": "import { Stack, Fn } from '@iacmp/core';\nconst stack = new Stack('payments-consumer');\nnew Fn.Lambda(stack, 'PaymentsConsumerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/paymentsConsumer.handler',\n  code: '.',\n  timeout: 60,\n  eventSources: [\n    {\n      queueId: 'PaymentsQueue',\n      batchSize: 1,\n    },\n  ],\n});\nexport default stack;",
      "stacks/policy/payments-producer-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\nconst stack = new Stack('payments-producer-policy');\nnew Policy.IAM(stack, 'PaymentsProducerPolicy', {\n  attachTo: 'PaymentsProducerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['sqs:SendMessage'],\n      resources: [ref('PaymentsQueue', 'Arn')],\n    },\n  ],\n});\nexport default stack;",
      "stacks/policy/payments-consumer-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\nconst stack = new Stack('payments-consumer-policy');\nnew Policy.IAM(stack, 'PaymentsConsumerPolicy', {\n  attachTo: 'PaymentsConsumerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],\n      resources: [ref('PaymentsQueue', 'Arn')],\n    },\n  ],\n});\nexport default stack;"
    },
    "handlers": {
      "src/paymentsProducer.ts": "import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';\nimport { randomUUID } from 'crypto';\n\nconst sqs = new SQSClient({});\n\nexport async function handler(event: { paymentId: string; accountId: string; amount: number }) {\n  await sqs.send(new SendMessageCommand({\n    QueueUrl: process.env.QUEUE_URL,\n    MessageBody: JSON.stringify({\n      paymentId: event.paymentId,\n      accountId: event.accountId,\n      amount: event.amount,\n    }),\n    MessageGroupId: event.accountId,\n    MessageDeduplicationId: event.paymentId,\n  }));\n  return { statusCode: 200 };\n}",
      "src/paymentsConsumer.ts": "import type { SQSEvent } from 'aws-lambda';\n\nexport async function handler(event: SQSEvent) {\n  for (const record of event.Records) {\n    const body = JSON.parse(record.body);\n    console.log('Processing payment:', body.paymentId, 'account:', body.accountId, 'amount:', body.amount);\n  }\n}"
    },
    "notes": [
      "Filas FIFO exigem MessageGroupId e MessageDeduplicationId em cada SendMessage — sem eles a chamada falha com InvalidParameterValue; ContentBasedDeduplication não é exposto pelo iacmp, logo deduplicationId é sempre obrigatório",
      "batchSize: 1 preserva a ordem estrita por MessageGroupId; batchSize > 1 em FIFO pode incluir mensagens de grupos distintos no mesmo batch e quebrar a expectativa de sequência",
      "O throughput de filas FIFO é 300 TPS sem batching e 3000 TPS com batching — para volumes maiores o High Throughput Mode precisa de configuração extra no CloudFormation que o iacmp ainda não expõe",
      "MessageGroupId controla o paralelismo: grupos diferentes são processados em paralelo; mesmo grupo é sequencial — usar accountId como groupId garante que pagamentos do mesmo cliente nunca se cruzam",
      "O synth adiciona o sufixo .fifo ao nome da fila automaticamente quando fifo: true — nunca incluir .fifo no id do construct, causaria duplicação no nome final"
    ]
  },
  {
    "id": "aws-messaging-queue-3",
    "title": "SQS com Dead Letter Queue (DLQ) e bisect on error",
    "provider": "aws",
    "constructs": [
      "Messaging.Queue",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "sqs",
      "messaging.queue",
      "fn.lambda",
      "policy.iam",
      "dlq",
      "dead-letter-queue",
      "redrive"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/notifications-queue-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\nconst stack = new Stack('notifications-queue');\n\nconst dlq = new Messaging.Queue(stack, 'NotificationsDlq', {\n  messageRetentionSeconds: 1209600,\n  encrypted: true,\n});\n\nnew Messaging.Queue(stack, 'NotificationsQueue', {\n  visibilityTimeoutSeconds: 30,\n  messageRetentionSeconds: 86400,\n  encrypted: true,\n  dlqArn: dlq.arn,\n  maxReceiveCount: 3,\n});\n\nexport default stack;",
      "stacks/compute/notifications-producer-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\nconst stack = new Stack('notifications-producer');\nnew Fn.Lambda(stack, 'NotificationsProducerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/notificationsProducer.handler',\n  code: '.',\n  timeout: 30,\n  environment: {\n    QUEUE_URL: ref('NotificationsQueue', 'QueueUrl'),\n  },\n});\nexport default stack;",
      "stacks/compute/notifications-consumer-stack.ts": "import { Stack, Fn } from '@iacmp/core';\nconst stack = new Stack('notifications-consumer');\nnew Fn.Lambda(stack, 'NotificationsConsumerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/notificationsConsumer.handler',\n  code: '.',\n  timeout: 30,\n  eventSources: [\n    {\n      queueId: 'NotificationsQueue',\n      batchSize: 5,\n      bisectBatchOnFunctionError: true,\n    },\n  ],\n});\nexport default stack;",
      "stacks/policy/notifications-producer-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\nconst stack = new Stack('notifications-producer-policy');\nnew Policy.IAM(stack, 'NotificationsProducerPolicy', {\n  attachTo: 'NotificationsProducerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['sqs:SendMessage'],\n      resources: [ref('NotificationsQueue', 'Arn')],\n    },\n  ],\n});\nexport default stack;",
      "stacks/policy/notifications-consumer-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\nconst stack = new Stack('notifications-consumer-policy');\nnew Policy.IAM(stack, 'NotificationsConsumerPolicy', {\n  attachTo: 'NotificationsConsumerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],\n      resources: [ref('NotificationsQueue', 'Arn'), ref('NotificationsDlq', 'Arn')],\n    },\n  ],\n});\nexport default stack;"
    },
    "handlers": {
      "src/notificationsProducer.ts": "import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';\n\nconst sqs = new SQSClient({});\n\nexport async function handler(event: { userId: string; message: string; channel: string }) {\n  await sqs.send(new SendMessageCommand({\n    QueueUrl: process.env.QUEUE_URL,\n    MessageBody: JSON.stringify({\n      userId: event.userId,\n      message: event.message,\n      channel: event.channel,\n    }),\n  }));\n  return { statusCode: 200 };\n}",
      "src/notificationsConsumer.ts": "import type { SQSEvent } from 'aws-lambda';\n\nexport async function handler(event: SQSEvent) {\n  for (const record of event.Records) {\n    const body = JSON.parse(record.body);\n    if (!body.channel || !body.userId) {\n      throw new Error(`Mensagem invalida: ${record.messageId}`);\n    }\n    console.log('Enviando notificacao para usuario:', body.userId, 'canal:', body.channel);\n  }\n}"
    },
    "notes": [
      "dlqArn aceita o getter dlq.arn (que retorna Ref<'Arn'>) quando DLQ e fila principal estao na mesma Stack — o synth resolve para Fn::GetAtt; nunca passar string com ARN hardcoded",
      "maxReceiveCount: 3 significa que a mensagem e tentada 3 vezes antes de ir para a DLQ; valor 1 manda para DLQ na primeira falha — usar >= 3 para erros transientes como timeouts de rede",
      "messageRetentionSeconds da DLQ deve ser >= da fila principal (aqui 14 dias vs 1 dia) para garantir que a mensagem nao expire na DLQ antes de ser inspecionada",
      "bisectBatchOnFunctionError: true faz o ESM dividir o batch ao meio em caso de erro e retentar cada metade separadamente, isolando a mensagem com problema sem reprocessar todo o batch",
      "A policy do consumer inclui o ARN da DLQ alem da fila principal — sem isso o ESM nao consegue mover mensagens para a DLQ e a fila fica travada no receiveCount maximo"
    ]
  },
  {
    "id": "aws-messaging-stream-1",
    "title": "Kinesis Stream com Lambda consumer (1 shard)",
    "provider": "aws",
    "constructs": [
      "Messaging.Stream",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "kinesis",
      "messaging.stream",
      "fn.lambda",
      "policy.iam",
      "event-source-mapping",
      "streaming"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/events-stream-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('events-stream');\n\nnew Messaging.Stream(stack, 'EventsStream', {\n  shards: 1,\n  retentionHours: 24,\n});\n\nexport default stack;\n",
      "stacks/compute/events-producer-lambda-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('events-producer-lambda');\n\nnew Fn.Lambda(stack, 'EventsProducerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/events-producer.handler',\n  code: '.',\n  environment: {\n    STREAM_NAME: ref('EventsStream', 'Name'),\n  },\n});\n\nexport default stack;\n",
      "stacks/compute/events-consumer-lambda-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('events-consumer-lambda');\n\nnew Fn.Lambda(stack, 'EventsConsumerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/events-consumer.handler',\n  code: '.',\n  eventSources: [\n    {\n      streamId: 'EventsStream',\n      batchSize: 100,\n      startingPosition: 'TRIM_HORIZON',\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/policy/events-producer-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('events-producer-policy');\n\nnew Policy.IAM(stack, 'EventsProducerPolicy', {\n  attachTo: 'EventsProducerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['kinesis:PutRecord'],\n      resources: [ref('EventsStream', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/policy/events-consumer-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('events-consumer-policy');\n\nnew Policy.IAM(stack, 'EventsConsumerPolicy', {\n  attachTo: 'EventsConsumerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['kinesis:GetRecords', 'kinesis:GetShardIterator'],\n      resources: [ref('EventsStream', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/events-producer.ts": "import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';\nimport type { APIGatewayProxyHandlerV2 } from 'aws-lambda';\n\nconst kinesis = new KinesisClient({});\n\nexport const handler: APIGatewayProxyHandlerV2 = async (event) => {\n  const body = JSON.parse(event.body ?? '{}');\n\n  const payload = {\n    eventType: body.type ?? 'generic',\n    timestamp: new Date().toISOString(),\n    data: body,\n  };\n\n  await kinesis.send(\n    new PutRecordCommand({\n      StreamName: process.env.STREAM_NAME!,\n      Data: Buffer.from(JSON.stringify(payload)),\n      PartitionKey: payload.eventType,\n    }),\n  );\n\n  return { statusCode: 200, body: JSON.stringify({ ok: true }) };\n};\n",
      "src/events-consumer.ts": "import type { KinesisStreamHandler } from 'aws-lambda';\n\nexport const handler: KinesisStreamHandler = async (event) => {\n  for (const record of event.Records) {\n    const raw = Buffer.from(record.kinesis.data, 'base64').toString();\n    const payload = JSON.parse(raw) as { eventType: string; timestamp: string; data: unknown };\n\n    console.log('Received event', {\n      eventType: payload.eventType,\n      timestamp: payload.timestamp,\n      sequenceNumber: record.kinesis.sequenceNumber,\n      shardId: record.eventID,\n    });\n\n    // processar payload.data conforme o tipo de evento\n  }\n};\n"
    },
    "notes": [
      "streamId em eventSources aceita o id do construct como string — o synth resolve para o ARN do Kinesis stream via cross-stack ImportValue automaticamente.",
      "Quando o Fn.Lambda tem eventSources[].streamId, o synth adiciona AWSLambdaKinesisExecutionRole automaticamente ao role gerado pelo Policy.IAM (os statements explícitos de GetRecords/GetShardIterator ficam no inline policy, que escopa pelo ARN específico do stream).",
      "ref('EventsStream', 'Arn') em Policy.IAM resources é obrigatório — nunca use a string 'EventsStream' nem 'EventsStream/*' diretamente; IAM rejeita nomes no campo Resource.",
      "startingPosition: 'TRIM_HORIZON' processa todos os registros existentes desde o início; use 'LATEST' para processar apenas registros novos a partir do deploy.",
      "O KinesisStreamHandler do pacote aws-lambda recebe event.Records[].kinesis.data como base64 — sempre fazer Buffer.from(r.kinesis.data, 'base64').toString() antes do JSON.parse.",
      "Policy separada por Lambda — nunca reutilize um Policy.IAM para mais de uma função."
    ]
  },
  {
    "id": "aws-messaging-stream-2",
    "title": "Kinesis Stream com múltiplos shards (alta vazão)",
    "provider": "aws",
    "constructs": [
      "Messaging.Stream",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "kinesis",
      "messaging.stream",
      "fn.lambda",
      "policy.iam",
      "shards",
      "throughput",
      "high-volume"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/analytics-stream-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('analytics-stream');\n\nnew Messaging.Stream(stack, 'AnalyticsStream', {\n  shards: 4,\n  retentionHours: 48,\n  encrypted: true,\n});\n\nexport default stack;\n",
      "stacks/compute/analytics-ingester-lambda-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('analytics-ingester-lambda');\n\nnew Fn.Lambda(stack, 'AnalyticsIngesterFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/analytics-ingester.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  environment: {\n    STREAM_NAME: ref('AnalyticsStream', 'Name'),\n  },\n});\n\nexport default stack;\n",
      "stacks/compute/analytics-processor-lambda-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('analytics-processor-lambda');\n\nnew Fn.Lambda(stack, 'AnalyticsProcessorFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/analytics-processor.handler',\n  code: '.',\n  memory: 512,\n  timeout: 60,\n  eventSources: [\n    {\n      streamId: 'AnalyticsStream',\n      batchSize: 200,\n      startingPosition: 'TRIM_HORIZON',\n      bisectBatchOnFunctionError: true,\n      maxBatchingWindowSeconds: 5,\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/policy/analytics-ingester-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('analytics-ingester-policy');\n\nnew Policy.IAM(stack, 'AnalyticsIngesterPolicy', {\n  attachTo: 'AnalyticsIngesterFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['kinesis:PutRecord'],\n      resources: [ref('AnalyticsStream', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/policy/analytics-processor-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('analytics-processor-policy');\n\nnew Policy.IAM(stack, 'AnalyticsProcessorPolicy', {\n  attachTo: 'AnalyticsProcessorFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['kinesis:GetRecords', 'kinesis:GetShardIterator'],\n      resources: [ref('AnalyticsStream', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/analytics-ingester.ts": "import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';\nimport type { APIGatewayProxyHandlerV2 } from 'aws-lambda';\n\nconst kinesis = new KinesisClient({});\n\ntype AnalyticsEvent = {\n  userId: string;\n  action: string;\n  properties: Record<string, unknown>;\n};\n\nexport const handler: APIGatewayProxyHandlerV2 = async (event) => {\n  const evt = JSON.parse(event.body ?? '{}') as AnalyticsEvent;\n\n  if (!evt.userId || !evt.action) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'userId e action são obrigatórios' }) };\n  }\n\n  const payload = {\n    ...evt,\n    timestamp: new Date().toISOString(),\n  };\n\n  await kinesis.send(\n    new PutRecordCommand({\n      StreamName: process.env.STREAM_NAME!,\n      Data: Buffer.from(JSON.stringify(payload)),\n      // Distribuir entre shards pelo userId garante ordem por usuário\n      PartitionKey: evt.userId,\n    }),\n  );\n\n  return { statusCode: 202, body: JSON.stringify({ ok: true }) };\n};\n",
      "src/analytics-processor.ts": "import type { KinesisStreamHandler } from 'aws-lambda';\n\ntype AnalyticsEvent = {\n  userId: string;\n  action: string;\n  properties: Record<string, unknown>;\n  timestamp: string;\n};\n\nexport const handler: KinesisStreamHandler = async (event) => {\n  // Com 4 shards, Lambda recebe até 4 invocações paralelas (uma por shard).\n  // O campo eventID contém 'shardId:sequenceNumber' — útil para logging.\n  const byShard = new Map<string, AnalyticsEvent[]>();\n\n  for (const record of event.Records) {\n    const shardId = record.eventID.split(':')[0];\n    const payload = JSON.parse(\n      Buffer.from(record.kinesis.data, 'base64').toString(),\n    ) as AnalyticsEvent;\n\n    const bucket = byShard.get(shardId) ?? [];\n    bucket.push(payload);\n    byShard.set(shardId, bucket);\n  }\n\n  for (const [shardId, records] of byShard) {\n    console.log(`Processando shard ${shardId}: ${records.length} eventos`);\n    for (const r of records) {\n      console.log('Evento', { userId: r.userId, action: r.action, timestamp: r.timestamp });\n      // persistir / agregar conforme necessário\n    }\n  }\n};\n"
    },
    "notes": [
      "Com 4 shards, o throughput de escrita sobe para 4 MB/s e 4.000 registros/s (1 MB/s e 1.000 registros/s por shard). Ajuste shards conforme o volume esperado.",
      "bisectBatchOnFunctionError: true instrui o EventSourceMapping a dividir o batch ao meio em caso de erro, isolando o registro problemático sem reprocessar o batch inteiro.",
      "maxBatchingWindowSeconds: 5 acumula registros por até 5 s antes de invocar a Lambda, aumentando o tamanho médio do batch e reduzindo o custo de invocações.",
      "Com múltiplos shards, a Lambda pode ser invocada em paralelo (uma instância por shard) — handlers devem ser stateless; estado compartilhado exige DynamoDB ou ElastiCache.",
      "PartitionKey define em qual shard o registro cai — use um campo de alta cardinalidade (userId, deviceId) para distribuir uniformemente e evitar hot shards.",
      "encrypted: true usa KMS alias/aws/kinesis (chave gerenciada pela AWS) sem custo adicional de CMK; para auditorias de chave própria, substitua por uma CMK explícita via Custom resource."
    ]
  },
  {
    "id": "aws-messaging-stream-3",
    "title": "Kinesis Stream com múltiplos consumers independentes (fan-out)",
    "provider": "aws",
    "constructs": [
      "Messaging.Stream",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "kinesis",
      "messaging.stream",
      "fn.lambda",
      "policy.iam",
      "fan-out",
      "multiple-consumers",
      "event-driven"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/orders-stream-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('orders-stream');\n\nnew Messaging.Stream(stack, 'OrdersStream', {\n  shards: 2,\n  retentionHours: 72,\n  encrypted: true,\n});\n\nexport default stack;\n",
      "stacks/compute/orders-producer-lambda-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('orders-producer-lambda');\n\nnew Fn.Lambda(stack, 'OrdersProducerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/orders-producer.handler',\n  code: '.',\n  environment: {\n    STREAM_NAME: ref('OrdersStream', 'Name'),\n  },\n});\n\nexport default stack;\n",
      "stacks/compute/orders-billing-lambda-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('orders-billing-lambda');\n\nnew Fn.Lambda(stack, 'OrdersBillingFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/orders-billing.handler',\n  code: '.',\n  timeout: 60,\n  eventSources: [\n    {\n      streamId: 'OrdersStream',\n      batchSize: 50,\n      startingPosition: 'TRIM_HORIZON',\n      bisectBatchOnFunctionError: true,\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/compute/orders-audit-lambda-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('orders-audit-lambda');\n\nnew Fn.Lambda(stack, 'OrdersAuditFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/orders-audit.handler',\n  code: '.',\n  timeout: 30,\n  eventSources: [\n    {\n      streamId: 'OrdersStream',\n      batchSize: 100,\n      startingPosition: 'TRIM_HORIZON',\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/policy/orders-producer-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('orders-producer-policy');\n\nnew Policy.IAM(stack, 'OrdersProducerPolicy', {\n  attachTo: 'OrdersProducerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['kinesis:PutRecord'],\n      resources: [ref('OrdersStream', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/policy/orders-billing-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('orders-billing-policy');\n\nnew Policy.IAM(stack, 'OrdersBillingPolicy', {\n  attachTo: 'OrdersBillingFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['kinesis:GetRecords', 'kinesis:GetShardIterator'],\n      resources: [ref('OrdersStream', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/policy/orders-audit-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('orders-audit-policy');\n\nnew Policy.IAM(stack, 'OrdersAuditPolicy', {\n  attachTo: 'OrdersAuditFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['kinesis:GetRecords', 'kinesis:GetShardIterator'],\n      resources: [ref('OrdersStream', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/orders-producer.ts": "import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';\nimport type { APIGatewayProxyHandlerV2 } from 'aws-lambda';\n\nconst kinesis = new KinesisClient({});\n\ntype Order = {\n  orderId: string;\n  customerId: string;\n  amount: number;\n  items: Array<{ sku: string; qty: number; price: number }>;\n};\n\nexport const handler: APIGatewayProxyHandlerV2 = async (event) => {\n  const order = JSON.parse(event.body ?? '{}') as Order;\n\n  if (!order.orderId || !order.customerId) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'orderId e customerId são obrigatórios' }) };\n  }\n\n  const payload = {\n    ...order,\n    eventType: 'ORDER_CREATED',\n    timestamp: new Date().toISOString(),\n  };\n\n  await kinesis.send(\n    new PutRecordCommand({\n      StreamName: process.env.STREAM_NAME!,\n      Data: Buffer.from(JSON.stringify(payload)),\n      PartitionKey: order.customerId,\n    }),\n  );\n\n  return { statusCode: 202, body: JSON.stringify({ orderId: order.orderId }) };\n};\n",
      "src/orders-billing.ts": "import type { KinesisStreamHandler } from 'aws-lambda';\n\ntype OrderEvent = {\n  orderId: string;\n  customerId: string;\n  amount: number;\n  items: Array<{ sku: string; qty: number; price: number }>;\n  eventType: string;\n  timestamp: string;\n};\n\nexport const handler: KinesisStreamHandler = async (event) => {\n  for (const record of event.Records) {\n    const order = JSON.parse(\n      Buffer.from(record.kinesis.data, 'base64').toString(),\n    ) as OrderEvent;\n\n    if (order.eventType !== 'ORDER_CREATED') continue;\n\n    console.log('Billing: processando cobrança', {\n      orderId: order.orderId,\n      customerId: order.customerId,\n      amount: order.amount,\n    });\n\n    // chamar gateway de pagamento, emitir nota fiscal, etc.\n  }\n};\n",
      "src/orders-audit.ts": "import type { KinesisStreamHandler } from 'aws-lambda';\n\ntype OrderEvent = {\n  orderId: string;\n  customerId: string;\n  amount: number;\n  eventType: string;\n  timestamp: string;\n};\n\nexport const handler: KinesisStreamHandler = async (event) => {\n  for (const record of event.Records) {\n    const order = JSON.parse(\n      Buffer.from(record.kinesis.data, 'base64').toString(),\n    ) as OrderEvent;\n\n    console.log('Audit: registrando evento', {\n      orderId: order.orderId,\n      eventType: order.eventType,\n      timestamp: order.timestamp,\n      sequenceNumber: record.kinesis.sequenceNumber,\n    });\n\n    // persistir em S3, DynamoDB ou sistema de auditoria\n  }\n};\n"
    },
    "notes": [
      "Cada Fn.Lambda com eventSources[].streamId cria um EventSourceMapping independente no mesmo Kinesis stream — todos os consumers leem o stream completo de forma independente (fan-out via shared throughput, não Enhanced Fan-Out).",
      "Com shared throughput, todos os EventSourceMappings de um shard competem pelo limite de 2 MB/s e 5 GetRecords/s por shard — com 2 consumers e 2 shards, cada consumer recebe até 1 MB/s por shard na prática.",
      "Enhanced Fan-Out nativo (RegisterStreamConsumer — 2 MB/s dedicado por consumer por shard via HTTP/2 push) não está disponível como prop de Messaging.Stream; requer um Custom resource com AWS::Kinesis::StreamConsumer e alteração do EventSourceMapping para usar ConsumerARN.",
      "Policy.IAM separada por Lambda é inegociável — uma única Policy.IAM com múltiplos attachTo causaria erro de construção; o campo attachTo é singular.",
      "O synth adiciona AWSLambdaKinesisExecutionRole automaticamente quando a Lambda tem eventSources.streamId — os statements explícitos de GetRecords/GetShardIterator na Policy.IAM restringem ao ARN específico do stream, o que é mais seguro que o Resource:'*' da managed policy.",
      "bisectBatchOnFunctionError no consumer de billing isola registros inválidos sem bloquear o shard inteiro — útil em pipelines financeiros onde um pedido malformado não pode travar o processamento dos demais."
    ]
  },
  {
    "id": "aws-messaging-topic-2",
    "title": "SNS Topic com filtro por atributo de mensagem (fan-out seletivo)",
    "provider": "aws",
    "constructs": [
      "Messaging.Topic",
      "Messaging.Queue",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "sns",
      "sqs",
      "filter",
      "filterpolicy",
      "attribute-filter",
      "messaging",
      "messaging.topic",
      "messaging.queue",
      "fn.lambda",
      "policy.iam"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/messaging-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('MessagingStack');\n\nconst createdQ = new Messaging.Queue(stack, 'OrderCreatedQ', {\n  visibilityTimeoutSeconds: 30,\n  messageRetentionSeconds: 345600,\n});\n\nconst cancelledQ = new Messaging.Queue(stack, 'OrderCancelledQ', {\n  visibilityTimeoutSeconds: 30,\n  messageRetentionSeconds: 345600,\n});\n\nnew Messaging.Topic(stack, 'OrdersTopic', {\n  displayName: 'Orders Events',\n  subscriptions: [\n    {\n      protocol: 'sqs',\n      endpoint: createdQ.arn,\n      filterPolicy: { eventType: ['order.created'] },\n    },\n    {\n      protocol: 'sqs',\n      endpoint: cancelledQ.arn,\n      filterPolicy: { eventType: ['order.cancelled'] },\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/compute/compute-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('ComputeStack');\n\nnew Fn.Lambda(stack, 'PublishEventFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/publishEvent.handler',\n  code: '.',\n  timeout: 15,\n  environment: {\n    TOPIC_ARN: ref('OrdersTopic', 'Arn'),\n  },\n});\n\nnew Fn.Lambda(stack, 'ProcessCreatedFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/processCreated.handler',\n  code: '.',\n  timeout: 30,\n  eventSources: [{ queueId: 'OrderCreatedQ', batchSize: 10 }],\n});\n\nnew Fn.Lambda(stack, 'ProcessCancelledFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/processCancelled.handler',\n  code: '.',\n  timeout: 30,\n  eventSources: [{ queueId: 'OrderCancelledQ', batchSize: 10 }],\n});\n\nexport default stack;\n",
      "stacks/policy/policy-producer.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('PolicyProducerStack');\n\nnew Policy.IAM(stack, 'PublishEventPolicy', {\n  attachTo: 'PublishEventFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['sns:Publish'],\n      resources: [ref('OrdersTopic', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/publishEvent.ts": "import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';\n\nconst sns = new SNSClient({});\n\nexport async function handler(event: any) {\n  const body = JSON.parse(event.body ?? '{}');\n  const { eventType, orderId, ...payload } = body;\n\n  if (!eventType || !orderId) {\n    return {\n      statusCode: 400,\n      headers: { 'Access-Control-Allow-Origin': '*' },\n      body: JSON.stringify({ error: 'eventType e orderId sao obrigatorios' }),\n    };\n  }\n\n  await sns.send(new PublishCommand({\n    TopicArn: process.env.TOPIC_ARN,\n    Message: JSON.stringify({ orderId, ...payload }),\n    MessageAttributes: {\n      eventType: {\n        DataType: 'String',\n        StringValue: eventType,\n      },\n    },\n  }));\n\n  return {\n    statusCode: 200,\n    headers: { 'Access-Control-Allow-Origin': '*' },\n    body: JSON.stringify({ message: 'Event published', eventType, orderId }),\n  };\n}\n",
      "src/processCreated.ts": "export async function handler(event: any) {\n  for (const record of event.Records) {\n    const snsEnvelope = JSON.parse(record.body);\n    const order = JSON.parse(snsEnvelope.Message);\n    console.log('Processing new order:', JSON.stringify(order));\n  }\n}\n",
      "src/processCancelled.ts": "export async function handler(event: any) {\n  for (const record of event.Records) {\n    const snsEnvelope = JSON.parse(record.body);\n    const order = JSON.parse(snsEnvelope.Message);\n    console.log('Processing cancelled order:', JSON.stringify(order));\n  }\n}\n"
    },
    "notes": [
      "filterPolicy filtra por MessageAttribute — o producer DEVE publicar com MessageAttributes no PublishCommand; mensagens publicadas SEM o atributo eventType não chegam a nenhuma das filas filtradas (são descartadas pelo SNS).",
      "O valor de filterPolicy é { attributeName: ['valor1', 'valor2'] } — lista de strings aceitas; SNS suporta também filtros numéricos como { numeric: ['>', 100] } e prefix matching com { prefix: 'order.' }.",
      "Cada mensagem SNS chega apenas às filas cujo filterPolicy bate — fan-out seletivo real; se nenhum filtro bate, a mensagem é silenciosamente descartada sem erro no producer.",
      "O atributo DataType no MessageAttributes deve ser exatamente 'String' (com S maiúsculo) para bater com filterPolicy de strings; 'Number' para numérico.",
      "O handler SQS recebe o envelope SNS em record.body (string JSON com campos Message, Subject, MessageAttributes) — sempre JSON.parse duas vezes: envelope e depois Message."
    ]
  },
  {
    "id": "aws-messaging-topic-3",
    "title": "SNS Topic para notificações por email com Lambda producer",
    "provider": "aws",
    "constructs": [
      "Messaging.Topic",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "sns",
      "email",
      "notification",
      "alert",
      "messaging",
      "messaging.topic",
      "fn.lambda",
      "policy.iam"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/messaging-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('MessagingStack');\n\nnew Messaging.Topic(stack, 'AlertsTopic', {\n  displayName: 'System Alerts',\n  subscriptions: [\n    { protocol: 'email', endpoint: 'ops-team@example.com' },\n  ],\n});\n\nexport default stack;\n",
      "stacks/compute/compute-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('ComputeStack');\n\nnew Fn.Lambda(stack, 'SendAlertFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/sendAlert.handler',\n  code: '.',\n  timeout: 15,\n  environment: {\n    TOPIC_ARN: ref('AlertsTopic', 'Arn'),\n  },\n});\n\nexport default stack;\n",
      "stacks/policy/policy-alert.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('PolicyAlertStack');\n\nnew Policy.IAM(stack, 'SendAlertPolicy', {\n  attachTo: 'SendAlertFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['sns:Publish'],\n      resources: [ref('AlertsTopic', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/sendAlert.ts": "import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';\n\nconst sns = new SNSClient({});\n\nexport async function handler(event: any) {\n  const body = JSON.parse(event.body ?? '{}');\n  const subject = (body.subject as string) ?? 'System Alert';\n  const message = (body.message as string) ?? 'An alert was triggered.';\n\n  await sns.send(new PublishCommand({\n    TopicArn: process.env.TOPIC_ARN,\n    Subject: subject.slice(0, 100),\n    Message: message,\n  }));\n\n  return {\n    statusCode: 200,\n    headers: { 'Access-Control-Allow-Origin': '*' },\n    body: JSON.stringify({ message: 'Alert sent' }),\n  };\n}\n"
    },
    "notes": [
      "Email subscription exige confirmação manual — após o deploy (CREATE_COMPLETE), o destinatário recebe um e-mail da AWS com link de confirmação; até confirmar, nenhuma mensagem é entregue.",
      "O StackStatus fica CREATE_COMPLETE mesmo com a subscription de e-mail pendente de confirmação — não há como detectar programaticamente via CloudFormation se foi confirmada.",
      "Subject no SNS tem limite de 100 caracteres — truncar antes do PublishCommand evita erro 'InvalidParameter: Subject' em runtime.",
      "SNS email envia texto puro — não suporta HTML nativo; para e-mails formatados use Amazon SES em vez de SNS email subscription.",
      "Para environments de staging, prefira protocol: 'sqs' ou 'lambda' em vez de 'email' para evitar confirmação manual a cada destroy/redeploy que recria a subscription."
    ]
  },
  {
    "id": "aws-monitoring-alarm-1",
    "title": "Lambda Errors com notificação SNS via CloudWatch Alarm",
    "provider": "aws",
    "constructs": [
      "Monitoring.Alarm",
      "Messaging.Topic",
      "Fn.Lambda"
    ],
    "tags": [
      "aws",
      "monitoring.alarm",
      "messaging.topic",
      "fn.lambda",
      "cloudwatch",
      "lambda-errors",
      "sns"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/api-handler-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('api-handler');\n\nnew Fn.Lambda(stack, 'ApiHandlerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/api-handler.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n});\n\nexport default stack;",
      "stacks/monitoring/lambda-errors-alarm-stack.ts": "import { Stack, Monitoring, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('lambda-errors-alarm');\n\nconst topic = new Messaging.Topic(stack, 'ApiAlertsTopic', {\n  displayName: 'API Lambda Error Alerts',\n  subscriptions: [\n    { protocol: 'email', endpoint: 'ops@example.com' },\n  ],\n});\n\nnew Monitoring.Alarm(stack, 'ApiLambdaErrorsAlarm', {\n  metricName: 'Errors',\n  namespace: 'AWS/Lambda',\n  threshold: 1,\n  evaluationPeriods: 1,\n  periodSeconds: 60,\n  statistic: 'Sum',\n  comparisonOperator: 'GreaterThanOrEqualToThreshold',\n  treatMissingData: 'notBreaching',\n  alarmActions: [topic.arn],\n  okActions: [topic.arn],\n  dimensions: { FunctionName: 'ApiHandlerFn' },\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/api-handler.ts": "import { APIGatewayProxyHandler } from 'aws-lambda';\n\nexport const handler: APIGatewayProxyHandler = async (event) => {\n  const id = event.pathParameters?.id ?? '';\n\n  if (!id) {\n    return {\n      statusCode: 400,\n      body: JSON.stringify({ error: 'id is required' }),\n    };\n  }\n\n  return {\n    statusCode: 200,\n    body: JSON.stringify({ id, timestamp: Date.now() }),\n  };\n};"
    },
    "notes": [
      "dimensions.FunctionName deve ser a string exata do construct.id da Lambda — o synth gera FunctionName: construct.id, que coincide com o nome real da função na AWS",
      "statistic: 'Sum' é obrigatório para métricas de contagem como Errors — 'Average' retornaria 0.x mesmo havendo erros reais e o alarm não dispararia",
      "namespace: 'AWS/Lambda' deve ser explicitado — o default do synth é 'AWS/Lambda', mas omiti-lo é perigoso se o construct mudar de namespace padrão",
      "SNS topic na mesma stack do alarm permite usar o getter topic.arn em vez de ref() cross-stack, evitando a necessidade de export/import entre stacks",
      "okActions: [topic.arn] envia notificação de recuperação quando o alarm retorna ao estado OK — omitir significa receber alertas apenas na degradação, sem confirmação de resolução",
      "evaluationPeriods: 1 com periodSeconds: 60 dispara no primeiro minuto com erro; aumente evaluationPeriods para 2 ou 3 em produção para reduzir falsos positivos de erros transitórios"
    ]
  },
  {
    "id": "aws-monitoring-alarm-2",
    "title": "DynamoDB ReadThrottleEvents e WriteThrottleEvents com CloudWatch Alarm",
    "provider": "aws",
    "constructs": [
      "Monitoring.Alarm",
      "Database.DynamoDB",
      "Messaging.Topic"
    ],
    "tags": [
      "aws",
      "monitoring.alarm",
      "database.dynamodb",
      "messaging.topic",
      "cloudwatch",
      "dynamodb-throttle"
    ],
    "validated": false,
    "stacks": {
      "stacks/database/orders-table-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('orders-table');\n\nnew Database.DynamoDB(stack, 'OrdersTable', {\n  partitionKey: 'orderId',\n  billingMode: 'PROVISIONED',\n  readCapacity: 5,\n  writeCapacity: 5,\n  pointInTimeRecovery: true,\n});\n\nexport default stack;",
      "stacks/monitoring/dynamo-throttle-alarm-stack.ts": "import { Stack, Monitoring, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('dynamo-throttle-alarm');\n\nconst topic = new Messaging.Topic(stack, 'DynamoAlertsTopic', {\n  displayName: 'DynamoDB Throttle Alerts',\n  subscriptions: [\n    { protocol: 'email', endpoint: 'ops@example.com' },\n  ],\n});\n\nnew Monitoring.Alarm(stack, 'OrdersTableReadThrottleAlarm', {\n  metricName: 'ReadThrottleEvents',\n  namespace: 'AWS/DynamoDB',\n  threshold: 5,\n  evaluationPeriods: 2,\n  periodSeconds: 300,\n  statistic: 'Sum',\n  comparisonOperator: 'GreaterThanOrEqualToThreshold',\n  treatMissingData: 'notBreaching',\n  alarmActions: [topic.arn],\n  dimensions: { TableName: 'OrdersTable' },\n});\n\nnew Monitoring.Alarm(stack, 'OrdersTableWriteThrottleAlarm', {\n  metricName: 'WriteThrottleEvents',\n  namespace: 'AWS/DynamoDB',\n  threshold: 5,\n  evaluationPeriods: 2,\n  periodSeconds: 300,\n  statistic: 'Sum',\n  comparisonOperator: 'GreaterThanOrEqualToThreshold',\n  treatMissingData: 'notBreaching',\n  alarmActions: [topic.arn],\n  dimensions: { TableName: 'OrdersTable' },\n});\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "dimensions.TableName deve ser a string exata do construct.id da tabela — o synth gera TableName: construct.id como nome real da tabela na AWS",
      "namespace: 'AWS/DynamoDB' é obrigatório e deve ser explícito — o default do synth é 'AWS/Lambda', o alarm ficaria monitorando namespace errado em silêncio",
      "treatMissingData: 'notBreaching' evita alarmes falsos quando a tabela está ociosa — ausência de dados de throttle significa zero throttles, não problema",
      "Dois Monitoring.Alarm separados (Read + Write) permitem distinguir qual direção sofreu throttle; um único alarm de SystemErrors não detecta throttle de capacidade provisionada",
      "Em billingMode: 'PAY_PER_REQUEST' throttling é raro mas possível em burst extremo — monitore ConsumedReadCapacityUnits e ConsumedWriteCapacityUnits nesse modo para detectar hotspots antes do throttle",
      "periodSeconds: 300 (5 min) com evaluationPeriods: 2 dá 10 min de janela antes de disparar — reduzir para 60/1 aumenta sensibilidade mas gera mais ruído em cargas intermitentes"
    ]
  },
  {
    "id": "aws-monitoring-alarm-3",
    "title": "Alarm composto (AND) combinando alta taxa de erros e alta latência em Lambda",
    "provider": "aws",
    "constructs": [
      "Monitoring.Alarm",
      "Custom.Resource",
      "Messaging.Topic",
      "Fn.Lambda"
    ],
    "tags": [
      "aws",
      "monitoring.alarm",
      "custom.resource",
      "messaging.topic",
      "fn.lambda",
      "cloudwatch",
      "composite-alarm"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/checkout-api-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('checkout-api');\n\nnew Fn.Lambda(stack, 'CheckoutApiFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/checkout-api.handler',\n  code: '.',\n  memory: 512,\n  timeout: 29,\n});\n\nexport default stack;",
      "stacks/monitoring/checkout-composite-alarm-stack.ts": "import { Stack, Monitoring, Messaging, Custom } from '@iacmp/core';\n\nconst stack = new Stack('checkout-composite-alarm');\n\n// SNS topic para notificações de alta severidade\nconst topic = new Messaging.Topic(stack, 'HighSeverityAlerts', {\n  displayName: 'Checkout High Severity Alerts',\n  subscriptions: [\n    { protocol: 'email', endpoint: 'oncall@example.com' },\n  ],\n});\n\n// Alarm filho 1: erros acima de 3 por janela de 5 minutos\n// Sem alarmActions — notificação é responsabilidade do alarm composto\nnew Monitoring.Alarm(stack, 'CheckoutErrorRateAlarm', {\n  metricName: 'Errors',\n  namespace: 'AWS/Lambda',\n  threshold: 3,\n  evaluationPeriods: 2,\n  periodSeconds: 300,\n  statistic: 'Sum',\n  comparisonOperator: 'GreaterThanOrEqualToThreshold',\n  treatMissingData: 'notBreaching',\n  dimensions: { FunctionName: 'CheckoutApiFn' },\n});\n\n// Alarm filho 2: latência média acima de 5000ms (5s) por janela de 5 minutos\n// Sem alarmActions — notificação é responsabilidade do alarm composto\nnew Monitoring.Alarm(stack, 'CheckoutHighLatencyAlarm', {\n  metricName: 'Duration',\n  namespace: 'AWS/Lambda',\n  threshold: 5000,\n  evaluationPeriods: 2,\n  periodSeconds: 300,\n  statistic: 'Average',\n  comparisonOperator: 'GreaterThanOrEqualToThreshold',\n  treatMissingData: 'notBreaching',\n  dimensions: { FunctionName: 'CheckoutApiFn' },\n});\n\n// Alarm composto: dispara apenas quando AMBOS os alarms filhos estão em ALARM\n// AWS::CloudWatch::CompositeAlarm não existe como construct nativo — usa Custom.Resource\n// AlarmActions em properties bypass os resolvers iacmp: usa Fn::Sub para montar o ARN do SNS\nnew Custom.Resource(stack, 'CheckoutCompositeAlarm', {\n  cloudformation: {\n    type: 'AWS::CloudWatch::CompositeAlarm',\n    properties: {\n      AlarmName: 'CheckoutCompositeAlarm',\n      AlarmDescription: 'Dispara quando erros E latência estão elevados simultaneamente',\n      AlarmRule: 'ALARM(\"CheckoutErrorRateAlarm\") AND ALARM(\"CheckoutHighLatencyAlarm\")',\n      AlarmActions: [\n        { 'Fn::Sub': 'arn:aws:sns:${AWS::Region}:${AWS::AccountId}:HighSeverityAlerts' },\n      ],\n      OKActions: [\n        { 'Fn::Sub': 'arn:aws:sns:${AWS::Region}:${AWS::AccountId}:HighSeverityAlerts' },\n      ],\n      TreatMissingData: 'notBreaching',\n    },\n  },\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/checkout-api.ts": "import { APIGatewayProxyHandler } from 'aws-lambda';\n\nexport const handler: APIGatewayProxyHandler = async (event) => {\n  const body = event.body ? JSON.parse(event.body) : {};\n  const cartId = event.pathParameters?.id ?? '';\n\n  if (!cartId) {\n    return {\n      statusCode: 400,\n      body: JSON.stringify({ error: 'cartId is required' }),\n    };\n  }\n\n  if (!body.paymentMethod) {\n    return {\n      statusCode: 422,\n      body: JSON.stringify({ error: 'paymentMethod is required' }),\n    };\n  }\n\n  const orderId = `ord_${Date.now()}`;\n\n  return {\n    statusCode: 201,\n    body: JSON.stringify({ orderId, cartId, status: 'PENDING' }),\n  };\n};"
    },
    "notes": [
      "AWS::CloudWatch::CompositeAlarm não existe como construct nativo no iacmp — use Custom.Resource com cloudformation.type para emitir o recurso diretamente no template CloudFormation",
      "AlarmRule usa nomes literais dos alarms filho entre aspas: ALARM(\"AlarmName\") — os nomes coincidem com construct.id dos Monitoring.Alarm porque o synth gera AlarmName: construct.id",
      "AlarmActions dentro de Custom.Resource.cloudformation.properties bypass os resolvers iacmp — ref() e topic.arn não são resolvidos; use Fn::Sub com ${AWS::Region} e ${AWS::AccountId} para compor o ARN do SNS cujo nome é o construct.id do Messaging.Topic",
      "Alarms filho não devem ter alarmActions — o alarm composto é o único responsável pela notificação; alarmActions nos filhos causaria notificações duplicadas e independentes a cada filho que alarmar",
      "O alarm composto tem delay de até 30s para propagar mudanças de estado dos filhos — não é adequado para cenários que exigem resposta em menos de 1 minuto",
      "A combinação Errors (Sum) AND Duration (Average) filtra falsos positivos: erros isolados sem degradação de latência são ruído; erros + latência alta indicam degradação real de serviço"
    ]
  },
  {
    "id": "aws-monitoring-dashboard-1",
    "title": "Dashboard CloudWatch — Lambda + DynamoDB",
    "provider": "aws",
    "constructs": [
      "Fn.Lambda",
      "Database.DynamoDB",
      "Policy.IAM",
      "Monitoring.Dashboard"
    ],
    "tags": [
      "aws",
      "monitoring",
      "cloudwatch",
      "lambda",
      "dynamodb",
      "dashboard",
      "fn.lambda",
      "database.dynamodb",
      "monitoring.dashboard"
    ],
    "validated": false,
    "stacks": {
      "stacks/database/dynamo-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('items-database');\n\nnew Database.DynamoDB(stack, 'ItemsTable', {\n  partitionKey: 'id',\n  partitionKeyType: 'S',\n  billingMode: 'PAY_PER_REQUEST',\n  pointInTimeRecovery: true,\n});\n\nexport default stack;\n",
      "stacks/compute/lambda-stack.ts": "import { Stack, Fn, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('items-compute');\n\nnew Fn.Lambda(stack, 'ProcessorFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/processor.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  environment: {\n    TABLE_NAME: ref('ItemsTable', 'Name'),\n  },\n});\n\nnew Policy.IAM(stack, 'ProcessorFnPolicy', {\n  attachTo: 'ProcessorFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'dynamodb:PutItem',\n        'dynamodb:GetItem',\n        'dynamodb:Query',\n        'dynamodb:UpdateItem',\n        'dynamodb:DeleteItem',\n      ],\n      resources: [ref('ItemsTable', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/monitoring/dashboard-stack.ts": "import { Stack, Monitoring } from '@iacmp/core';\n\nconst stack = new Stack('items-dashboard');\n\nnew Monitoring.Dashboard(stack, 'ItemsDash', {\n  widgets: [\n    {\n      type: 'text',\n      title: 'Visão Geral',\n      markdown: '# Lambda + DynamoDB — Métricas Operacionais',\n    },\n    {\n      type: 'metric',\n      title: 'Lambda — Invocações',\n      namespace: 'AWS/Lambda',\n      metricName: 'Invocations',\n      dimensions: { FunctionName: 'ProcessorFn' },\n      period: 60,\n      stat: 'Sum',\n    },\n    {\n      type: 'metric',\n      title: 'Lambda — Erros',\n      namespace: 'AWS/Lambda',\n      metricName: 'Errors',\n      dimensions: { FunctionName: 'ProcessorFn' },\n      period: 60,\n      stat: 'Sum',\n    },\n    {\n      type: 'metric',\n      title: 'Lambda — Duração P99',\n      namespace: 'AWS/Lambda',\n      metricName: 'Duration',\n      dimensions: { FunctionName: 'ProcessorFn' },\n      period: 60,\n      stat: 'p99',\n    },\n    {\n      type: 'metric',\n      title: 'DynamoDB — Latência de Leitura',\n      namespace: 'AWS/DynamoDB',\n      metricName: 'SuccessfulRequestLatency',\n      dimensions: { TableName: 'ItemsTable', Operation: 'GetItem' },\n      period: 60,\n      stat: 'Average',\n    },\n    {\n      type: 'metric',\n      title: 'DynamoDB — Latência de Escrita',\n      namespace: 'AWS/DynamoDB',\n      metricName: 'SuccessfulRequestLatency',\n      dimensions: { TableName: 'ItemsTable', Operation: 'PutItem' },\n      period: 60,\n      stat: 'Average',\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/processor.ts": "import { table } from '@iacmp/runtime';\nimport type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';\n\nconst t = table(process.env.TABLE_NAME!);\n\nexport async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {\n  const id = event.pathParameters?.id ?? '';\n  const method = event.requestContext.http.method;\n\n  if (method === 'POST') {\n    const body = JSON.parse(event.body ?? '{}');\n    const newId = crypto.randomUUID();\n    await t.put({ id: newId, ...body });\n    return { statusCode: 201, body: JSON.stringify({ id: newId }) };\n  }\n\n  if (method === 'DELETE' && id) {\n    await t.delete(id);\n    return { statusCode: 204, body: '' };\n  }\n\n  if (id) {\n    const item = await t.get(id);\n    if (!item) {\n      return { statusCode: 404, body: JSON.stringify({ error: 'not found' }) };\n    }\n    return { statusCode: 200, body: JSON.stringify(item) };\n  }\n\n  return { statusCode: 400, body: JSON.stringify({ error: 'id obrigatório para GET e DELETE' }) };\n}\n"
    },
    "notes": [
      "Handler usa o facade @iacmp/runtime (table()) — NUNCA @aws-sdk/client-dynamodb nem @aws-sdk/lib-dynamodb diretamente.",
      "Monitoring.Dashboard lança erro na construção do objeto (antes do synth) se widgets for array vazio — não chega ao CloudFormation.",
      "O dimension FunctionName deve ser idêntico ao construct.id da Fn.Lambda — o synth seta FunctionName: construct.id no CloudFormation.",
      "DynamoDB SuccessfulRequestLatency exige o dimension Operation (GetItem, PutItem, Query etc.) — sem ele o CloudWatch não retorna dados.",
      "stat 'p99' é aceito pelo synth e pelo CloudWatch para Lambda Duration; percentis requerem period >= 60.",
      "O dashboard é implantável de forma completamente independente das outras stacks — não cria dependência CloudFormation entre elas.",
      "O DashboardBody é serializado via Fn::Sub — se adicionar ${algo} manualmente no markdown, o CloudFormation tenta resolver como variável e falha."
    ]
  },
  {
    "id": "aws-monitoring-dashboard-2",
    "title": "Dashboard CloudWatch — API Gateway com Latência",
    "provider": "aws",
    "constructs": [
      "Fn.Lambda",
      "Fn.ApiGateway",
      "Policy.IAM",
      "Monitoring.Dashboard"
    ],
    "tags": [
      "aws",
      "monitoring",
      "cloudwatch",
      "apigateway",
      "latency",
      "dashboard",
      "fn.lambda",
      "fn.apigateway",
      "monitoring.dashboard"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/api-stack.ts": "import { Stack, Fn, Policy } from '@iacmp/core';\n\nconst stack = new Stack('items-api');\n\nnew Fn.Lambda(stack, 'ItemsHandlerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/items-handler.handler',\n  code: '.',\n  memory: 128,\n  timeout: 10,\n});\n\nnew Policy.IAM(stack, 'ItemsHandlerFnPolicy', {\n  attachTo: 'ItemsHandlerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],\n      resources: ['*'],\n    },\n  ],\n});\n\nnew Fn.ApiGateway(stack, 'ItemsApi', {\n  name: 'items-rest-api',\n  type: 'REST',\n  stageName: 'prod',\n  routes: [\n    { method: 'GET',    path: '/items',     lambdaId: 'ItemsHandlerFn' },\n    { method: 'GET',    path: '/items/{id}', lambdaId: 'ItemsHandlerFn' },\n    { method: 'POST',   path: '/items',     lambdaId: 'ItemsHandlerFn' },\n    { method: 'DELETE', path: '/items/{id}', lambdaId: 'ItemsHandlerFn' },\n  ],\n});\n\nexport default stack;\n",
      "stacks/monitoring/dashboard-stack.ts": "import { Stack, Monitoring } from '@iacmp/core';\n\nconst stack = new Stack('api-latency-dashboard');\n\nnew Monitoring.Dashboard(stack, 'ApiLatencyDash', {\n  widgets: [\n    {\n      type: 'text',\n      title: 'API Gateway',\n      markdown: '# API Gateway — Latência e Saúde',\n    },\n    {\n      type: 'metric',\n      title: 'Latência P99',\n      namespace: 'AWS/ApiGateway',\n      metricName: 'Latency',\n      dimensions: { ApiName: 'items-rest-api', Stage: 'prod' },\n      period: 60,\n      stat: 'p99',\n    },\n    {\n      type: 'metric',\n      title: 'Latência Média',\n      namespace: 'AWS/ApiGateway',\n      metricName: 'Latency',\n      dimensions: { ApiName: 'items-rest-api', Stage: 'prod' },\n      period: 60,\n      stat: 'Average',\n    },\n    {\n      type: 'metric',\n      title: 'Latência de Integração',\n      namespace: 'AWS/ApiGateway',\n      metricName: 'IntegrationLatency',\n      dimensions: { ApiName: 'items-rest-api', Stage: 'prod' },\n      period: 60,\n      stat: 'Average',\n    },\n    {\n      type: 'metric',\n      title: 'Erros 4XX',\n      namespace: 'AWS/ApiGateway',\n      metricName: '4XXError',\n      dimensions: { ApiName: 'items-rest-api', Stage: 'prod' },\n      period: 60,\n      stat: 'Sum',\n    },\n    {\n      type: 'metric',\n      title: 'Erros 5XX',\n      namespace: 'AWS/ApiGateway',\n      metricName: '5XXError',\n      dimensions: { ApiName: 'items-rest-api', Stage: 'prod' },\n      period: 60,\n      stat: 'Sum',\n    },\n    {\n      type: 'metric',\n      title: 'Total de Requisições',\n      namespace: 'AWS/ApiGateway',\n      metricName: 'Count',\n      dimensions: { ApiName: 'items-rest-api', Stage: 'prod' },\n      period: 60,\n      stat: 'Sum',\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/items-handler.ts": "import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';\n\nconst store: Record<string, Record<string, unknown>> = {};\n\nexport async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {\n  const id = event.pathParameters?.id ?? '';\n  const method = event.httpMethod;\n\n  if (method === 'POST') {\n    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;\n    const newId = Date.now().toString();\n    store[newId] = { id: newId, ...body };\n    return { statusCode: 201, body: JSON.stringify(store[newId]) };\n  }\n\n  if (method === 'DELETE' && id) {\n    if (!store[id]) return { statusCode: 404, body: JSON.stringify({ error: 'not found' }) };\n    delete store[id];\n    return { statusCode: 204, body: '' };\n  }\n\n  if (id) {\n    const item = store[id];\n    if (!item) return { statusCode: 404, body: JSON.stringify({ error: 'not found' }) };\n    return { statusCode: 200, body: JSON.stringify(item) };\n  }\n\n  return { statusCode: 200, body: JSON.stringify(Object.values(store)) };\n}\n"
    },
    "notes": [
      "O dimension ApiName deve ser idêntico a props.name do Fn.ApiGateway — não é o construct.id. O synth seta Name: props.name no CloudFormation.",
      "O dimension Stage deve coincidir com stageName — para REST o default é 'prod'; para HTTP/WEBSOCKET é '$default'.",
      "Os metricNames '4XXError' e '5XXError' no namespace AWS/ApiGateway usam maiúsculos exatos — erro de capitalização não quebra o deploy mas o widget fica sem dados.",
      "Latência P99 no namespace AWS/ApiGateway exige period >= 60 — abaixo disso o CloudWatch retorna série vazia mesmo com tráfego.",
      "IntegrationLatency mede só o tempo dentro da Lambda (sem overhead do API Gateway) — útil para isolar gargalos de integração vs roteamento.",
      "O widget tipo 'text' não aceita metricName/namespace/dimensions — qualquer campo além de title e markdown é ignorado silenciosamente pelo synth."
    ]
  },
  {
    "id": "aws-network-dns-3",
    "title": "Hosted Zone com multiplos records (A, CNAME, MX, TXT)",
    "provider": "aws",
    "constructs": [
      "Network.Dns"
    ],
    "tags": [
      "aws",
      "network.dns",
      "route53",
      "hosted-zone",
      "multi-record",
      "mx",
      "txt",
      "spf"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/dns-multi-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('dns-multi');\n\nnew Network.Dns(stack, 'ZoneDns', {\n  zoneName: 'example.com',\n  records: [\n    // Apex A alias para ALB (prioridade maxima — naked domain)\n    {\n      name: 'example.com',\n      type: 'A',\n      aliasTarget: 'AppAlb-1234567890.us-east-1.elb.amazonaws.com',\n      values: [],\n    },\n    // www CNAME para CloudFront\n    {\n      name: 'www.example.com',\n      type: 'CNAME',\n      ttl: 300,\n      values: ['d1a2b3c4d5e6f7gh.cloudfront.net'],\n    },\n    // MX para servico de email gerenciado\n    {\n      name: 'example.com',\n      type: 'MX',\n      ttl: 3600,\n      values: [\n        '10 aspmx.l.google.com.',\n        '20 alt1.aspmx.l.google.com.',\n        '30 alt2.aspmx.l.google.com.',\n      ],\n    },\n    // TXT para SPF e verificacao de dominio\n    {\n      name: 'example.com',\n      type: 'TXT',\n      ttl: 3600,\n      values: [\n        'v=spf1 include:_spf.google.com ~all',\n        'google-site-verification=AbCdEfGhIjKlMnOpQrStUvWxYz1234567890',\n      ],\n    },\n    // Subdominio de api como CNAME para outro ALB\n    {\n      name: 'api.example.com',\n      type: 'CNAME',\n      ttl: 60,\n      values: ['ApiAlb-9876543210.us-east-1.elb.amazonaws.com'],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "Cada record gera um AWS::Route53::RecordSet separado. O logical ID e composto como '{constructId}{name_sanitizado}{type}' — ex: 'ZoneDnsexamplecomA', 'ZoneDnsexamplecomMX'. Records com nomes que se diferenciam apenas por caracteres especiais (hifens, pontos) produzem o mesmo logical ID apos sanitizacao e o segundo sobrescreve o primeiro silenciosamente no template JSON.",
      "MX records: o valor em values[] deve incluir a prioridade como prefixo numerico separado por espaco ('10 mail.example.com.'). O ponto final no hostname e obrigatório — Route53 trata hostnames sem ponto final como relativos a zona e adiciona o sufixo automaticamente, resultando em 'mail.example.com.example.com'.",
      "TXT records com multiplos valores: o synth passa o array de values[] diretamente como ResourceRecords. Route53/CloudFormation aceita multiplas strings no mesmo RecordSet sem quotes extras — nao e necessario escapar as aspas no nivel do iacmp.",
      "Dois records com o mesmo name mas types diferentes (A e MX para 'example.com' no exemplo) geram logical IDs distintos e coexistem corretamente no template. Records com mesmo name E mesmo type resultariam em logical IDs identicos e o segundo substituiria o primeiro.",
      "O record A de apex com aliasTarget sofre a mesma limitacao dos outros cenarios: aliasTarget nao e resolvido como Ref pelo synth — apenas strings literais funcionam. O HostedZoneId Z35SXDOTRQ7X7K e valido apenas para ELB us-east-1.",
      "TTL alto (3600s) em MX e TXT e recomendado para reducao de queries recursivas. TTL baixo (60s) em registros de API facilita rollouts sem downtime prolongado de DNS."
    ]
  },
  {
    "id": "aws-network-loadbalancer-1",
    "title": "ALB internet-facing na frente de ECS Fargate (mesma stack)",
    "provider": "aws",
    "constructs": [
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup",
      "Network.LoadBalancer",
      "Compute.Container"
    ],
    "tags": [
      "aws",
      "alb",
      "ecs",
      "fargate",
      "network.loadbalancer",
      "compute.container",
      "network.securitygroup",
      "network.subnet",
      "network.vpc",
      "application-load-balancer",
      "target-group",
      "same-stack"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/alb-ecs-stack.ts": "import { Stack, Network, Compute } from '@iacmp/core';\n\nconst stack = new Stack('alb-ecs');\n\nnew Network.VPC(stack, 'AppVpc', {\n  cidr: '10.0.0.0/16',\n});\n\nnew Network.Subnet(stack, 'PubSubnetA', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.1.0/24',\n  availabilityZone: 'us-east-1a',\n  public: true,\n});\n\nnew Network.Subnet(stack, 'PubSubnetB', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.2.0/24',\n  availabilityZone: 'us-east-1b',\n  public: true,\n});\n\nnew Network.Subnet(stack, 'PrivSubnetA', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.3.0/24',\n  availabilityZone: 'us-east-1a',\n});\n\nnew Network.Subnet(stack, 'PrivSubnetB', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.4.0/24',\n  availabilityZone: 'us-east-1b',\n});\n\nnew Network.SecurityGroup(stack, 'AlbSg', {\n  vpcId: 'AppVpc',\n  description: 'Security group do ALB',\n  ingressRules: [\n    { protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '0.0.0.0/0', description: 'HTTP publico' },\n  ],\n});\n\nnew Network.SecurityGroup(stack, 'AppSg', {\n  vpcId: 'AppVpc',\n  description: 'Security group das tasks ECS',\n  ingressRules: [\n    {\n      protocol: 'tcp',\n      fromPort: 3000,\n      toPort: 3000,\n      sourceSecurityGroupId: 'AlbSg',\n      description: 'Trafego do ALB',\n    },\n  ],\n});\n\nconst lb = new Network.LoadBalancer(stack, 'AppAlb', {\n  type: 'application',\n  scheme: 'internet-facing',\n  vpcId: 'AppVpc',\n  subnetIds: ['PubSubnetA', 'PubSubnetB'],\n  securityGroupIds: ['AlbSg'],\n  listeners: [\n    { port: 80, protocol: 'HTTP' },\n  ],\n  targetGroups: [\n    { name: 'app-tg', port: 3000, protocol: 'HTTP', healthCheckPath: '/health' },\n  ],\n});\n\nnew Compute.Container(stack, 'AppService', {\n  image: 'nginx:alpine',\n  cpu: 256,\n  memory: 512,\n  port: 3000,\n  desiredCount: 2,\n  publicIp: false,\n  subnetIds: ['PrivSubnetA', 'PrivSubnetB'],\n  securityGroupIds: ['AppSg'],\n  targetGroupArn: lb.targetGroupArn,\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "targetGroupArn: lb.targetGroupArn usa o getter Ref — nunca passar lb.targetGroupArn.toString() nem String(lb.targetGroupArn); produz \"[object Object]\" em runtime",
      "Network.Subnet com public: true na mesma stack do VPC faz o synth gerar IGW + route table automaticamente via publicSubnetsByVpc; omitir public: true em subnets de ALB internet-facing causa erro de deploy \"No internet gateway found\"",
      "securityGroupIds passam o construct ID como string (ex: 'AlbSg'); o synth resolve via Fn::GetAtt GroupId para mesma stack — nunca usar o ARN nem o ID lógico com sufixo",
      "ALB exige no mínimo 2 subnets em AZs distintas; uma subnet única causa erro de deploy \"ALBs require subnets in at least 2 Availability Zones\"",
      "targetType não é prop de NetworkLoadBalancerProps; o synth sempre emite TargetType: 'ip' nos TargetGroups — compatível com Fargate (awsvpc, task por IP)",
      "ECS Service na mesma stack do ALB ganha DependsOn automático no listener via ctx.albDefaultTg — garante que o listener existe antes do Service tentar registrar tasks no target group"
    ]
  },
  {
    "id": "aws-network-loadbalancer-3",
    "title": "NLB (Network Load Balancer) para serviços TCP de baixa latência",
    "provider": "aws",
    "constructs": [
      "Network.VPC",
      "Network.Subnet",
      "Network.LoadBalancer"
    ],
    "tags": [
      "aws",
      "nlb",
      "tcp",
      "network.loadbalancer",
      "network.subnet",
      "network.vpc",
      "network-load-balancer",
      "target-group",
      "cross-stack",
      "low-latency"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/vpc-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('vpc');\n\nnew Network.VPC(stack, 'TcpVpc', {\n  cidr: '10.0.0.0/16',\n});\n\nnew Network.Subnet(stack, 'PubSubnetA', {\n  vpcId: 'TcpVpc',\n  cidr: '10.0.1.0/24',\n  availabilityZone: 'us-east-1a',\n  public: true,\n});\n\nnew Network.Subnet(stack, 'PubSubnetB', {\n  vpcId: 'TcpVpc',\n  cidr: '10.0.2.0/24',\n  availabilityZone: 'us-east-1b',\n  public: true,\n});\n\nexport default stack;\n",
      "stacks/network/nlb-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('nlb');\n\nnew Network.LoadBalancer(stack, 'TcpNlb', {\n  type: 'network',\n  scheme: 'internet-facing',\n  vpcId: 'TcpVpc',\n  subnetIds: ['PubSubnetA', 'PubSubnetB'],\n  listeners: [\n    { port: 5432, protocol: 'TCP' },\n  ],\n  targetGroups: [\n    { name: 'tcp-tg', port: 5432, protocol: 'TCP', healthCheckPort: 5432 },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "NLB (type: 'network') não suporta security groups — omitir securityGroupIds por completo; o synth só inclui a chave SecurityGroups no recurso CloudFormation quando type === 'application'",
      "Target group de NLB deve usar protocol: 'TCP'; healthCheckPath não se aplica a TCP e é ignorado — usar healthCheckPort para verificar disponibilidade da porta diretamente",
      "NLB não reescreve cabeçalhos HTTP nem termina SSL por padrão; para TLS offload usar protocol: 'TLS' no listener com certificateArn do ACM",
      "targetType não é prop de NetworkLoadBalancerProps; o synth hardcoda TargetType: 'ip' — compatível com Fargate/ECS tasks registradas por IP",
      "NLB com cross-AZ desabilitado (default) pode distribuir tráfego de forma assimétrica entre AZs com Fargate; se necessário, habilitar via LoadBalancerAttributes (prop não exposta ainda — requer workaround manual no template)",
      "VPC e subnets na stack stacks/network/vpc-stack.ts; NLB referencia por string ID ('TcpVpc', 'PubSubnetA', 'PubSubnetB') — o synth emite Fn::ImportValue cross-stack via resolveVpcId/resolveSubnetId"
    ]
  },
  {
    "id": "aws-network-vpc-2",
    "title": "VPC com subnet publica e privada (camadas de rede distintas)",
    "provider": "aws",
    "constructs": [
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "network.vpc",
      "network.subnet",
      "network.securitygroup",
      "vpc-hibrida",
      "subnet-publica",
      "subnet-privada",
      "lambda"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/vpc-hibrida-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('vpc-hibrida');\n\nnew Network.VPC(stack, 'HybridVpc', { cidr: '10.1.0.0/16', maxAzs: 0 });\n\nnew Network.Subnet(stack, 'PublicSubnet', {\n  vpcId: 'HybridVpc',\n  cidr: '10.1.0.0/24',\n  public: true,\n  availabilityZone: 'us-east-1a',\n});\n\nnew Network.Subnet(stack, 'PrivateSubnet', {\n  vpcId: 'HybridVpc',\n  cidr: '10.1.1.0/24',\n  public: false,\n  availabilityZone: 'us-east-1a',\n});\n\nnew Network.SecurityGroup(stack, 'PublicSg', {\n  vpcId: 'HybridVpc',\n  description: 'Trafego HTTPS externo na subnet publica',\n  ingressRules: [\n    {\n      protocol: 'tcp',\n      fromPort: 443,\n      toPort: 443,\n      cidr: '0.0.0.0/0',\n      description: 'HTTPS publico',\n    },\n  ],\n  egressRules: [{ protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0' }],\n});\n\nnew Network.SecurityGroup(stack, 'PrivateSg', {\n  vpcId: 'HybridVpc',\n  description: 'Worker interno — ingresso somente via PublicSg',\n  ingressRules: [\n    {\n      protocol: 'tcp',\n      fromPort: 8080,\n      toPort: 8080,\n      sourceSecurityGroupId: 'PublicSg',\n      description: 'Trafego encaminhado da camada publica',\n    },\n  ],\n  egressRules: [{ protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0' }],\n});\n\nexport default stack;\n",
      "stacks/compute/worker-lambda-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('worker-lambda');\n\nnew Fn.Lambda(stack, 'WorkerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/worker.handler',\n  code: '.',\n  memory: 128,\n  timeout: 60,\n  vpcId: 'HybridVpc',\n  subnetIds: ['PrivateSubnet'],\n  securityGroupIds: ['PrivateSg'],\n  environment: {\n    STAGE: 'prod',\n  },\n});\n\nexport default stack;\n",
      "stacks/policy/worker-policy-stack.ts": "import { Stack, Policy } from '@iacmp/core';\n\nconst stack = new Stack('worker-policy');\n\nnew Policy.IAM(stack, 'WorkerFnPolicy', {\n  attachTo: 'WorkerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],\n      resources: ['arn:aws:logs:*:*:*'],\n    },\n    {\n      effect: 'Allow',\n      actions: [\n        'ec2:CreateNetworkInterface',\n        'ec2:DescribeNetworkInterfaces',\n        'ec2:DeleteNetworkInterface',\n      ],\n      resources: ['*'],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/worker.ts": "export async function handler(event: unknown): Promise<{ statusCode: number; body: string }> {\n  console.log('WorkerFn invocado', JSON.stringify(event));\n  return {\n    statusCode: 200,\n    body: JSON.stringify({ ok: true, received: event }),\n  };\n}\n"
    },
    "notes": [
      "PublicSubnet e PrivateSubnet estao na mesma AZ (us-east-1a) neste cenario porque o objetivo e demonstrar camadas de rede, nao alta disponibilidade. Para producao, adicione PrivateSubnet2 em us-east-1b.",
      "sourceSecurityGroupId aceita apenas o ID logico do construct (string), nunca ref(). A dependencia entre SGs na mesma stack e resolvida pelo synth via CloudFormation DependsOn automaticamente.",
      "Lambda com subnetIds apontando para subnet privada sem NAT Gateway nao consegue acessar endpoints AWS publicos (S3, DynamoDB via API publica). Adicione Network.VpcEndpoint ou um NAT Gateway na subnet publica.",
      "maxAzs: 0 com subnets explícitas: o synth nao cria Internet Gateway automatico para a subnet publica quando maxAzs: 0. A IGW e criada apenas quando public: true esta presente em pelo menos um Network.Subnet — validado em deploy real.",
      "Policy separada por Lambda e inegociavel. Nunca coloque attachTo com dois IDs nem crie uma policy para WorkerFn e ApiHandler juntos — o synth rejeita e o IAM nao aceita."
    ]
  },
  {
    "id": "aws-network-vpc-3",
    "title": "VPC minimalista com SG e subnets auto-geradas (maxAzs > 0)",
    "provider": "aws",
    "constructs": [
      "Network.VPC",
      "Network.SecurityGroup"
    ],
    "tags": [
      "aws",
      "network.vpc",
      "network.securitygroup",
      "vpc-minimalista",
      "maxazs",
      "auto-subnet"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/vpc-sg-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('vpc-sg');\n\nnew Network.VPC(stack, 'MinVpc', { cidr: '10.2.0.0/16', maxAzs: 2 });\n\nnew Network.SecurityGroup(stack, 'AppSg', {\n  vpcId: 'MinVpc',\n  description: 'SG para workloads nas subnets auto-geradas pela VPC',\n  ingressRules: [\n    {\n      protocol: 'tcp',\n      fromPort: 443,\n      toPort: 443,\n      cidr: '0.0.0.0/0',\n      description: 'HTTPS externo',\n    },\n  ],\n  egressRules: [\n    {\n      protocol: '-1',\n      fromPort: 0,\n      toPort: 0,\n      cidr: '0.0.0.0/0',\n      description: 'Saida irrestrita',\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {},
    "notes": [
      "maxAzs: 2 instrui o synth a criar subnets publicas automaticamente com IDs logicos no formato {VpcId}PublicSubnetA e {VpcId}PublicSubnetB (ex: MinVpcPublicSubnetA, MinVpcPublicSubnetB). Nao declare Network.Subnet manualmente na mesma stack — o synth geraria recursos duplicados e o deploy falharia com SubnetAlreadyInUse.",
      "Quando uma Lambda precisa referenciar as subnets auto-geradas, use os IDs logicos inferidos pelo padrao: subnetIds: ['MinVpcPublicSubnetA', 'MinVpcPublicSubnetB']. Esses IDs sao determinísticos e validados em deploy real no ciclo e2e-06.",
      "NUNCA declare Network.Subnet explícita na mesma stack que tem maxAzs > 0. O validador detecta esse conflito e o synth falha antes de gerar qualquer template.",
      "Network.SecurityGroup com vpcId: 'MinVpc' e valido mesmo sem Network.Subnet explicita na stack, pois o SG referencia a VPC, nao subnets. O synth resolve o vpcId para o VpcId exportado pelo CloudFormation.",
      "Para adicionar subnets privadas a este cenario sem perder o auto-provisionamento das publicas, migre para maxAzs: 0 e declare todas as subnets (publicas e privadas) como Network.Subnet explícitas — nao existe modo misto."
    ]
  },
  {
    "id": "aws-network-vpcendpoint-1",
    "title": "Lambda em VPC acessa DynamoDB via Gateway VPC Endpoint (sem NAT)",
    "provider": "aws",
    "constructs": [
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup",
      "Network.VpcEndpoint",
      "Database.DynamoDB",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "network.vpcendpoint",
      "network.vpc",
      "database.dynamodb",
      "fn.lambda",
      "vpc",
      "gateway-endpoint",
      "sem-nat",
      "subnet-privada"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/vpc-dynamo-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('vpc-dynamo');\n\nnew Network.VPC(stack, 'AppVpc', {\n  cidr: '10.0.0.0/16',\n  maxAzs: 0,\n});\n\nnew Network.Subnet(stack, 'PrivateSubnet1', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.1.0/24',\n});\n\nnew Network.SecurityGroup(stack, 'LambdaSG', {\n  vpcId: 'AppVpc',\n  description: 'Security group para Lambda que acessa DynamoDB',\n});\n\nnew Network.VpcEndpoint(stack, 'DynamoGateway', {\n  vpcId: 'AppVpc',\n  services: ['dynamodb'],\n  subnetIds: ['PrivateSubnet1'],\n});\n\nexport default stack;",
      "stacks/database/pedidos-table-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('pedidos-table');\n\nnew Database.DynamoDB(stack, 'PedidosTable', {\n  partitionKey: 'pedidoId',\n  partitionKeyType: 'S',\n  billingMode: 'PAY_PER_REQUEST',\n});\n\nexport default stack;",
      "stacks/compute/registrar-pedido-lambda-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('registrar-pedido-lambda');\n\nnew Fn.Lambda(stack, 'RegistrarPedidoFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/registrarPedido.handler',\n  code: '.',\n  timeout: 30,\n  vpcId: 'AppVpc',\n  subnetIds: ['PrivateSubnet1'],\n  securityGroupIds: ['LambdaSG'],\n  environment: {\n    TABLE_NAME: ref('PedidosTable', 'Name'),\n  },\n});\n\nexport default stack;",
      "stacks/policy/registrar-pedido-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('registrar-pedido-policy');\n\nnew Policy.IAM(stack, 'RegistrarPedidoPolicy', {\n  attachTo: 'RegistrarPedidoFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],\n      resources: [ref('PedidosTable', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/registrarPedido.ts": "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nimport { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';\n\nconst client = DynamoDBDocumentClient.from(new DynamoDBClient({}));\n\nexport async function handler(event: { pathParameters?: { pedidoId?: string } | null; body: string }) {\n  const body = JSON.parse(event.body ?? '{}');\n  const pedidoId = event.pathParameters?.pedidoId ?? crypto.randomUUID();\n\n  await client.send(new PutCommand({\n    TableName: process.env.TABLE_NAME!,\n    Item: {\n      pedidoId,\n      descricao: body.descricao ?? '',\n      status: 'pendente',\n      criadoEm: new Date().toISOString(),\n    },\n  }));\n\n  const result = await client.send(new GetCommand({\n    TableName: process.env.TABLE_NAME!,\n    Key: { pedidoId },\n  }));\n\n  return {\n    statusCode: 201,\n    body: JSON.stringify(result.Item),\n  };\n}"
    },
    "notes": [
      "Network.VpcEndpoint DEVE estar na mesma stack da VPC e das subnets — o synth cria RouteTable + SubnetRouteTableAssociation automaticamente nessa stack; não declare RouteTable à mão.",
      "O synth bloqueia a fase de synth se detectar Lambda em VPC + handler com import de @aws-sdk/lib-dynamodb sem Network.VpcEndpoint (services: ['dynamodb']) na mesma subnet — erro explícito: 'Gateway VPC Endpoint'.",
      "maxAzs: 0 é obrigatório quando Network.Subnet explícitos são declarados na mesma stack. maxAzs > 0 com Network.Subnet na mesma stack provoca conflito no synth.",
      "subnetIds no VpcEndpoint devem ser os mesmos IDs de subnet usados na Lambda — o synth associa a route table exatamente a essas subnets; subnets omitidas não roteiam pelo endpoint.",
      "DynamoDB handler: SEMPRE DynamoDBDocumentClient de @aws-sdk/lib-dynamodb (não DynamoDBClient low-level direto). O synth valida o import do handler para detectar o padrão de acesso.",
      "TABLE_NAME no environment usa ref('PedidosTable', 'Name') — nunca a string literal 'PedidosTable'; o synth gera o nome real da tabela e o resolve via CloudFormation outputs.",
      "Policy.IAM resources: SEMPRE ref('PedidosTable', 'Arn') — NUNCA 'PedidosTable' nem 'PedidosTable/*' como string; o IAM rejeita strings onde espera ARN.",
      "Uma Policy.IAM por Lambda — nunca uma policy compartilhada entre funções distintas."
    ]
  },
  {
    "id": "aws-network-vpcendpoint-2",
    "title": "Lambda em VPC acessa S3 via Gateway VPC Endpoint (sem NAT)",
    "provider": "aws",
    "constructs": [
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup",
      "Network.VpcEndpoint",
      "Storage.Bucket",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "network.vpcendpoint",
      "network.vpc",
      "storage.bucket",
      "fn.lambda",
      "vpc",
      "gateway-endpoint",
      "s3",
      "sem-nat",
      "subnet-privada"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/vpc-s3-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('vpc-s3');\n\nnew Network.VPC(stack, 'AppVpc', {\n  cidr: '10.1.0.0/16',\n  maxAzs: 0,\n});\n\nnew Network.Subnet(stack, 'PrivateSubnet1', {\n  vpcId: 'AppVpc',\n  cidr: '10.1.1.0/24',\n});\n\nnew Network.SecurityGroup(stack, 'LambdaSG', {\n  vpcId: 'AppVpc',\n  description: 'Security group para Lambda que acessa S3',\n});\n\nnew Network.VpcEndpoint(stack, 'S3Gateway', {\n  vpcId: 'AppVpc',\n  services: ['s3'],\n  subnetIds: ['PrivateSubnet1'],\n});\n\nexport default stack;",
      "stacks/storage/relatorios-bucket-stack.ts": "import { Stack, Storage } from '@iacmp/core';\n\nconst stack = new Stack('relatorios-bucket');\n\nnew Storage.Bucket(stack, 'RelatoriosBucket', {\n  versioning: true,\n});\n\nexport default stack;",
      "stacks/compute/exportar-relatorio-lambda-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('exportar-relatorio-lambda');\n\nnew Fn.Lambda(stack, 'ExportarRelatorioFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/exportarRelatorio.handler',\n  code: '.',\n  timeout: 60,\n  memory: 512,\n  vpcId: 'AppVpc',\n  subnetIds: ['PrivateSubnet1'],\n  securityGroupIds: ['LambdaSG'],\n  environment: {\n    BUCKET_NAME: ref('RelatoriosBucket', 'Name'),\n  },\n});\n\nexport default stack;",
      "stacks/policy/exportar-relatorio-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('exportar-relatorio-policy');\n\nnew Policy.IAM(stack, 'ExportarRelatorioPolicy', {\n  attachTo: 'ExportarRelatorioFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],\n      resources: [ref('RelatoriosBucket', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/exportarRelatorio.ts": "import { blob } from '@iacmp/runtime';\n\nconst b = blob(process.env.BUCKET_NAME!);\n\nexport async function handler(event: {\n  pathParameters?: { relatorioId?: string } | null;\n  body: string;\n}) {\n  const relatorioId = event.pathParameters?.relatorioId ?? crypto.randomUUID();\n  const conteudo = event.body ?? '{}';\n  const key = `relatorios/${relatorioId}.json`;\n\n  await b.put(key, conteudo, { contentType: 'application/json' });\n\n  return {\n    statusCode: 200,\n    body: JSON.stringify({ relatorioId, key }),\n  };\n}"
    },
    "notes": [
      "Handler usa o facade @iacmp/runtime (blob().put) — NUNCA @aws-sdk/client-s3 diretamente.",
      "Network.VpcEndpoint com services: ['s3'] DEVE estar na mesma stack da VPC — o synth gera RouteTable + SubnetRouteTableAssociation + AWS::EC2::VPCEndpoint (Gateway) nessa stack.",
      "O adaptador AWS do facade usa S3Client({}) sem endpoint explícito: o SDK resolve s3.amazonaws.com para o Gateway Endpoint automaticamente via route table.",
      "O Gateway S3 Endpoint é regional: cobre apenas o bucket na mesma região da Lambda. Buckets em outras regiões NÃO são alcançados pelo endpoint — para acessar bucket cross-region de dentro da VPC é necessário NAT Gateway.",
      "Policy.IAM resources deve ser ref('RelatoriosBucket', 'Arn') — nunca a string 'meu-bucket' nem 'meu-bucket/*'; o IAM rejeita o resource se não for ARN válido.",
      "BUCKET_NAME no environment usa ref('RelatoriosBucket', 'Name') — o synth resolve o nome gerado do bucket via CloudFormation outputs; nunca passe string literal.",
      "ref() NUNCA deve ser convertido para string: ref().toString() ou String(ref()) produz '[object Object]' em runtime — passe o Ref diretamente no environment.",
      "maxAzs: 0 quando Network.Subnet explícitos estão na mesma stack — omitir maxAzs também é válido, mas maxAzs > 0 com subnets explícitas causa conflito no synth."
    ]
  },
  {
    "id": "aws-network-vpcendpoint-3",
    "title": "Lambda em VPC acessa DynamoDB e S3 combinados via VpcEndpoint (Secrets Manager requer Interface Endpoint — não suportado)",
    "provider": "aws",
    "constructs": [
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup",
      "Network.VpcEndpoint",
      "Database.DynamoDB",
      "Storage.Bucket",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "network.vpcendpoint",
      "network.vpc",
      "database.dynamodb",
      "storage.bucket",
      "fn.lambda",
      "vpc",
      "gateway-endpoint",
      "multi-service",
      "secrets-manager-limitacao"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/vpc-multi-gw-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('vpc-multi-gw');\n\nnew Network.VPC(stack, 'AppVpc', {\n  cidr: '10.2.0.0/16',\n  maxAzs: 0,\n});\n\nnew Network.Subnet(stack, 'PrivateSubnet1', {\n  vpcId: 'AppVpc',\n  cidr: '10.2.1.0/24',\n});\n\nnew Network.SecurityGroup(stack, 'LambdaSG', {\n  vpcId: 'AppVpc',\n  description: 'Security group para Lambda de processamento',\n});\n\nnew Network.VpcEndpoint(stack, 'MultiGateway', {\n  vpcId: 'AppVpc',\n  services: ['dynamodb', 's3'],\n  subnetIds: ['PrivateSubnet1'],\n});\n\nexport default stack;",
      "stacks/database/eventos-table-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('eventos-table');\n\nnew Database.DynamoDB(stack, 'EventosTable', {\n  partitionKey: 'eventoId',\n  partitionKeyType: 'S',\n  sortKey: 'criadoEm',\n  sortKeyType: 'S',\n  billingMode: 'PAY_PER_REQUEST',\n  streamEnabled: true,\n});\n\nexport default stack;",
      "stacks/storage/snapshots-bucket-stack.ts": "import { Stack, Storage } from '@iacmp/core';\n\nconst stack = new Stack('snapshots-bucket');\n\nnew Storage.Bucket(stack, 'SnapshotsBucket', {\n  versioning: true,\n  lifecycleRules: [\n    {\n      prefix: 'snapshots/',\n      expireAfterDays: 90,\n    },\n  ],\n});\n\nexport default stack;",
      "stacks/compute/processar-evento-lambda-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('processar-evento-lambda');\n\nnew Fn.Lambda(stack, 'ProcessarEventoFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/processarEvento.handler',\n  code: '.',\n  timeout: 60,\n  memory: 256,\n  vpcId: 'AppVpc',\n  subnetIds: ['PrivateSubnet1'],\n  securityGroupIds: ['LambdaSG'],\n  environment: {\n    TABLE_NAME: ref('EventosTable', 'Name'),\n    BUCKET_NAME: ref('SnapshotsBucket', 'Name'),\n  },\n});\n\nexport default stack;",
      "stacks/policy/processar-evento-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('processar-evento-policy');\n\nnew Policy.IAM(stack, 'ProcessarEventoPolicy', {\n  attachTo: 'ProcessarEventoFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:Query'],\n      resources: [ref('EventosTable', 'Arn')],\n    },\n    {\n      effect: 'Allow',\n      actions: ['s3:PutObject', 's3:GetObject'],\n      resources: [ref('SnapshotsBucket', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/processarEvento.ts": "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nimport { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';\nimport { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';\n\nconst dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));\nconst s3 = new S3Client({});\n\nexport async function handler(event: { body: string }) {\n  const body = JSON.parse(event.body ?? '{}');\n  const eventoId = crypto.randomUUID();\n  const criadoEm = new Date().toISOString();\n\n  await dynamo.send(new PutCommand({\n    TableName: process.env.TABLE_NAME!,\n    Item: {\n      eventoId,\n      criadoEm,\n      tipo: body.tipo ?? 'desconhecido',\n      payload: body,\n    },\n  }));\n\n  const historico = await dynamo.send(new QueryCommand({\n    TableName: process.env.TABLE_NAME!,\n    KeyConditionExpression: 'eventoId = :id',\n    ExpressionAttributeValues: { ':id': eventoId },\n    Limit: 1,\n  }));\n\n  const snapshot = JSON.stringify({ eventoId, criadoEm, itens: historico.Items ?? [] });\n\n  await s3.send(new PutObjectCommand({\n    Bucket: process.env.BUCKET_NAME!,\n    Key: `snapshots/${eventoId}.json`,\n    Body: snapshot,\n    ContentType: 'application/json',\n  }));\n\n  return {\n    statusCode: 201,\n    body: JSON.stringify({ eventoId }),\n  };\n}"
    },
    "notes": [
      "Network.VpcEndpoint.services aceita APENAS 'dynamodb' | 's3' (Gateway endpoints, gratuitos). Secrets Manager, SSM Parameter Store, ECR e STS exigem Interface Endpoint (PrivateLink, pago) — o construct NÃO suporta esses serviços; passar 'secretsmanager' como service causa erro de validação no synth.",
      "Lambda em subnet privada chamando @aws-sdk/client-secrets-manager sem Interface Endpoint nem NAT Gateway resulta em timeout — não existe rota de saída para o endpoint regional do Secrets Manager. Não use o SDK de Secrets Manager de dentro de Lambda em VPC sem Interface Endpoint.",
      "Para segredos com Secrets Manager: o padrão correto no iacmp é injetar o valor via env var em tempo de deploy — Database.SQL expõe ref('DB', 'Password'), ref('DB', 'Username'), ref('DB', 'Endpoint'), ref('DB', 'Port') como Ref; passe esses Refs diretamente no environment da Lambda.",
      "services: ['dynamodb', 's3'] em um único VpcEndpoint cria dois Gateway Endpoints (um por serviço) e uma RouteTable compartilhada — o synth itera sobre os serviços e gera um AWS::EC2::VPCEndpoint por entrada.",
      "O synth detecta se a Lambda em VPC acessa DynamoDB ou S3 sem o VpcEndpoint correspondente e bloqueia o synth com erro — ambos os services precisam estar declarados se o handler importar tanto @aws-sdk/lib-dynamodb quanto @aws-sdk/client-s3.",
      "S3Client({}) e DynamoDBClient({}) sem endpoint explícito: o SDK usa os hostnames padrão regionais (s3.amazonaws.com, dynamodb.<region>.amazonaws.com) que são roteados pelo Gateway Endpoint via route table — NUNCA configure endpoint customizado nesses clientes.",
      "Duas Policy.IAM separadas por Lambda são corretas, mas também é válido ter statements múltiplos em uma única Policy.IAM para a mesma Lambda — o importante é attachTo apontar para o ID correto da Lambda, não compartilhar entre Lambdas distintas."
    ]
  },
  {
    "id": "aws-network-waf-1",
    "title": "WAF com regras managed (rate limiting) na frente de API Gateway",
    "provider": "aws",
    "constructs": [
      "Network.WAF",
      "Function.Lambda",
      "Function.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "network.waf",
      "function.lambda",
      "function.apigateway",
      "rate-limiting",
      "managed-rules",
      "wafv2",
      "regional"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/waf-managed-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('waf-managed');\n\nnew Network.WAF(stack, 'WafManaged', {\n  scope: 'REGIONAL',\n  defaultAction: 'allow',\n  description: 'WAF com rate limiting e regras gerenciadas AWS para API Gateway',\n  rules: [\n    {\n      name: 'RateLimitByIp',\n      priority: 1,\n      action: 'block',\n      rateLimit: 1000,\n      description: 'Bloqueia IPs com mais de 1000 requisicoes por 5 minutos',\n    },\n    {\n      name: 'AWSCommonRules',\n      priority: 2,\n      action: 'count',\n      managedGroup: 'AWSManagedRulesCommonRuleSet',\n      description: 'Protecao contra SQLi e XSS em modo contagem para monitorar antes de bloquear',\n    },\n    {\n      name: 'AWSKnownBadInputs',\n      priority: 3,\n      managedGroup: 'AWSManagedRulesKnownBadInputsRuleSet',\n      description: 'Bloqueia inputs sabidamente maliciosos: Log4Shell, SSRF etc.',\n    },\n  ],\n});\n\nexport default stack;\n",
      "stacks/compute/api-managed-stack.ts": "import { Stack, Fn, Policy } from '@iacmp/core';\n\nconst stack = new Stack('api-managed');\n\nnew Fn.Lambda(stack, 'ApiHandlerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/api-handler.handler',\n  code: '.',\n  environment: {\n    NODE_ENV: 'production',\n  },\n});\n\nnew Fn.ApiGateway(stack, 'ApiGw', {\n  name: 'waf-managed-api',\n  type: 'REST',\n  stageName: 'prod',\n  wafAclId: 'WafManaged',\n  cors: true,\n  routes: [\n    { method: 'GET', path: '/items', lambdaId: 'ApiHandlerFn' },\n    { method: 'POST', path: '/items', lambdaId: 'ApiHandlerFn' },\n    { method: 'GET', path: '/items/{id}', lambdaId: 'ApiHandlerFn' },\n    { method: 'DELETE', path: '/items/{id}', lambdaId: 'ApiHandlerFn' },\n  ],\n});\n\nnew Policy.IAM(stack, 'ApiHandlerPolicy', {\n  attachTo: 'ApiHandlerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'logs:CreateLogGroup',\n        'logs:CreateLogStream',\n        'logs:PutLogEvents',\n      ],\n      resources: ['arn:aws:logs:*:*:*'],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/api-handler.ts": "import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';\n\nconst items: Array<{ id: string; name: string; createdAt: string }> = [];\n\nexport const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {\n  const method = event.httpMethod;\n  const itemId = event.pathParameters?.id ?? '';\n\n  const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({\n    statusCode,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify(body),\n  });\n\n  if (method === 'GET' && !itemId) {\n    return json(200, { items });\n  }\n\n  if (method === 'GET' && itemId) {\n    const item = items.find(i => i.id === itemId);\n    return item ? json(200, item) : json(404, { message: 'Item nao encontrado' });\n  }\n\n  if (method === 'POST') {\n    const body = JSON.parse(event.body ?? '{}') as { name?: string };\n    const item = { id: crypto.randomUUID(), name: body.name ?? 'sem nome', createdAt: new Date().toISOString() };\n    items.push(item);\n    return json(201, item);\n  }\n\n  if (method === 'DELETE' && itemId) {\n    const idx = items.findIndex(i => i.id === itemId);\n    if (idx === -1) return json(404, { message: 'Item nao encontrado' });\n    items.splice(idx, 1);\n    return json(200, { message: 'Item removido' });\n  }\n\n  return json(405, { message: 'Metodo nao permitido' });\n};\n"
    },
    "notes": [
      "rateLimit no WAFRule altera a action automaticamente para 'block' quando seria 'allow' — definir action: 'block' explicitamente deixa a intenção clara e evita surpresa no deploy",
      "managedGroup usa OverrideAction, não Action — action: 'count' coloca o grupo em modo monitoramento (Count); omitir action faz a ação nativa do grupo valer (OverrideAction None)",
      "Network.WAF auto-exporta ${stackName}-${constructId}-Arn no CloudFormation — wafAclId cross-stack funciona sem configuração extra porque o synth gera Fn::ImportValue automaticamente",
      "scope: 'REGIONAL' é obrigatório para API Gateway; scope: 'CLOUDFRONT' exige que a stack seja deployada na região us-east-1 e o WAF associado à distribuição CloudFront",
      "WAF cobra USD 5/mês por WebACL + USD 1/mês por managed rule group — AWSManagedRulesCommonRuleSet e AWSManagedRulesKnownBadInputsRuleSet somam USD 7/mês mínimos"
    ]
  },
  {
    "id": "aws-network-waf-2",
    "title": "WAF com IP allowlist via Custom.Resource (IPSetReferenceStatement)",
    "provider": "aws",
    "constructs": [
      "Custom.Resource",
      "Function.Lambda",
      "Function.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "custom.resource",
      "function.lambda",
      "function.apigateway",
      "ip-allowlist",
      "ipset",
      "wafv2",
      "regional"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/waf-ipset-api-stack.ts": "import { Stack, Fn, Policy, Custom } from '@iacmp/core';\n\nconst stack = new Stack('waf-ipset-api');\n\nnew Custom.Resource(stack, 'WafIpSet', {\n  cloudformation: {\n    type: 'AWS::WAFv2::IPSet',\n    properties: {\n      Name: 'AllowedIpSet',\n      Scope: 'REGIONAL',\n      IPAddressVersion: 'IPV4',\n      Addresses: [\n        '203.0.113.0/24',\n        '198.51.100.50/32',\n        '192.0.2.10/32',\n      ],\n    },\n  },\n});\n\nnew Custom.Resource(stack, 'WafIpAllowlist', {\n  cloudformation: {\n    type: 'AWS::WAFv2::WebACL',\n    properties: {\n      Name: 'WafIpAllowlist',\n      Scope: 'REGIONAL',\n      DefaultAction: { Block: {} },\n      Description: 'WAF allowlist — bloqueia tudo exceto IPs autorizados no IPSet',\n      Rules: [\n        {\n          Name: 'AllowListedIps',\n          Priority: 1,\n          Action: { Allow: {} },\n          Statement: {\n            IPSetReferenceStatement: {\n              Arn: { 'Fn::GetAtt': ['WafIpSet', 'Arn'] },\n            },\n          },\n          VisibilityConfig: {\n            SampledRequestsEnabled: true,\n            CloudWatchMetricsEnabled: true,\n            MetricName: 'AllowListedIps',\n          },\n        },\n      ],\n      VisibilityConfig: {\n        SampledRequestsEnabled: true,\n        CloudWatchMetricsEnabled: true,\n        MetricName: 'WafIpAllowlist',\n      },\n    },\n  },\n});\n\nnew Fn.Lambda(stack, 'IpApiHandlerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/ip-api-handler.handler',\n  code: '.',\n  environment: {\n    NODE_ENV: 'production',\n  },\n});\n\nnew Fn.ApiGateway(stack, 'IpApiGw', {\n  name: 'waf-ipset-api',\n  type: 'REST',\n  stageName: 'prod',\n  wafAclId: 'WafIpAllowlist',\n  routes: [\n    { method: 'GET', path: '/status', lambdaId: 'IpApiHandlerFn' },\n    { method: 'POST', path: '/data', lambdaId: 'IpApiHandlerFn' },\n  ],\n});\n\nnew Policy.IAM(stack, 'IpApiHandlerPolicy', {\n  attachTo: 'IpApiHandlerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'logs:CreateLogGroup',\n        'logs:CreateLogStream',\n        'logs:PutLogEvents',\n      ],\n      resources: ['arn:aws:logs:*:*:*'],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/ip-api-handler.ts": "import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';\n\nexport const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {\n  const method = event.httpMethod;\n  const sourceIp = event.requestContext.identity?.sourceIp ?? 'desconhecido';\n\n  const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({\n    statusCode,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify(body),\n  });\n\n  if (method === 'GET') {\n    return json(200, {\n      status: 'ok',\n      ip: sourceIp,\n      timestamp: new Date().toISOString(),\n    });\n  }\n\n  if (method === 'POST') {\n    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;\n    return json(201, {\n      received: body,\n      ip: sourceIp,\n      timestamp: new Date().toISOString(),\n    });\n  }\n\n  return json(405, { message: 'Metodo nao permitido' });\n};\n"
    },
    "notes": [
      "Custom.Resource WAF não exporta ARN automaticamente no synth — WAF (WafIpAllowlist) e ApiGateway devem estar na mesma stack para wafAclId resolver via Fn::GetAtt em vez de Fn::ImportValue",
      "DefaultAction: { Block: {} } é o padrão correto para allowlist — lógica invertida em relação a blocklist (que usa Allow como default e regras de Block)",
      "Fn::GetAtt: ['WafIpSet', 'Arn'] funciona porque o logical ID do Custom.Resource no CloudFormation é igual ao construct id (WafIpSet) — só funciona dentro do mesmo template",
      "CIDRs no IPSet devem usar notação CIDR válida: /32 para IP individual, /24 para sub-rede — AWS WAFv2 rejeita IPs sem máscara com WAFInvalidParameterException",
      "Atualizar a lista de IPs via iacmp força substituição do IPSet (Delete + Create com breve janela sem proteção) — para atualizações frequentes use aws wafv2 update-ip-set diretamente"
    ]
  },
  {
    "id": "aws-network-waf-3",
    "title": "WAF com geo-blocking via Custom.Resource (GeoMatchStatement)",
    "provider": "aws",
    "constructs": [
      "Custom.Resource",
      "Function.Lambda",
      "Function.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "custom.resource",
      "function.lambda",
      "function.apigateway",
      "geo-blocking",
      "geomatch",
      "wafv2",
      "regional"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/waf-geo-api-stack.ts": "import { Stack, Fn, Policy, Custom } from '@iacmp/core';\n\nconst stack = new Stack('waf-geo-api');\n\nnew Custom.Resource(stack, 'WafGeo', {\n  cloudformation: {\n    type: 'AWS::WAFv2::WebACL',\n    properties: {\n      Name: 'WafGeoBlocking',\n      Scope: 'REGIONAL',\n      DefaultAction: { Allow: {} },\n      Description: 'WAF com geo-blocking de paises de alto risco e rate limiting global',\n      Rules: [\n        {\n          Name: 'BlockHighRiskCountries',\n          Priority: 1,\n          Action: { Block: {} },\n          Statement: {\n            GeoMatchStatement: {\n              CountryCodes: ['CN', 'RU', 'KP', 'IR', 'SY'],\n            },\n          },\n          VisibilityConfig: {\n            SampledRequestsEnabled: true,\n            CloudWatchMetricsEnabled: true,\n            MetricName: 'BlockHighRiskCountries',\n          },\n        },\n        {\n          Name: 'GlobalRateLimit',\n          Priority: 2,\n          Action: { Block: {} },\n          Statement: {\n            RateBasedStatement: {\n              Limit: 2000,\n              AggregateKeyType: 'IP',\n            },\n          },\n          VisibilityConfig: {\n            SampledRequestsEnabled: true,\n            CloudWatchMetricsEnabled: true,\n            MetricName: 'GlobalRateLimit',\n          },\n        },\n      ],\n      VisibilityConfig: {\n        SampledRequestsEnabled: true,\n        CloudWatchMetricsEnabled: true,\n        MetricName: 'WafGeoBlocking',\n      },\n    },\n  },\n});\n\nnew Fn.Lambda(stack, 'GeoApiHandlerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/geo-api-handler.handler',\n  code: '.',\n  environment: {\n    NODE_ENV: 'production',\n  },\n});\n\nnew Fn.ApiGateway(stack, 'GeoApiGw', {\n  name: 'waf-geo-api',\n  type: 'REST',\n  stageName: 'prod',\n  wafAclId: 'WafGeo',\n  cors: true,\n  routes: [\n    { method: 'GET', path: '/health', lambdaId: 'GeoApiHandlerFn' },\n    { method: 'GET', path: '/events', lambdaId: 'GeoApiHandlerFn' },\n    { method: 'POST', path: '/events', lambdaId: 'GeoApiHandlerFn' },\n  ],\n});\n\nnew Policy.IAM(stack, 'GeoApiHandlerPolicy', {\n  attachTo: 'GeoApiHandlerFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'logs:CreateLogGroup',\n        'logs:CreateLogStream',\n        'logs:PutLogEvents',\n      ],\n      resources: ['arn:aws:logs:*:*:*'],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/geo-api-handler.ts": "import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';\n\nconst events: Array<{ id: string; type: string; timestamp: string }> = [];\n\nexport const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {\n  const method = event.httpMethod;\n  const path = event.path;\n  const sourceIp = event.requestContext.identity?.sourceIp ?? 'desconhecido';\n\n  const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({\n    statusCode,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify(body),\n  });\n\n  if (method === 'GET' && path === '/health') {\n    return json(200, { status: 'healthy', sourceIp, timestamp: new Date().toISOString() });\n  }\n\n  if (method === 'GET' && path === '/events') {\n    return json(200, { events, total: events.length });\n  }\n\n  if (method === 'POST' && path === '/events') {\n    const body = JSON.parse(event.body ?? '{}') as { type?: string };\n    const ev = { id: crypto.randomUUID(), type: body.type ?? 'generic', timestamp: new Date().toISOString() };\n    events.push(ev);\n    return json(201, ev);\n  }\n\n  return json(405, { message: 'Metodo nao permitido' });\n};\n"
    },
    "notes": [
      "GeoMatchStatement não é suportado nativamente em WAFRule do iacmp — usar Custom.Resource com template CloudFormation completo (PascalCase nativo: CountryCodes, GeoMatchStatement)",
      "Custom.Resource WAF co-localizado na stack de compute pelo mesmo motivo do exemplo 2: sem export automático de ARN, wafAclId resolve via Fn::GetAtt somente na mesma stack",
      "CountryCodes exige array de códigos ISO 3166-1 alpha-2 em MAIÚSCULAS (ex: 'CN', 'RU') — AWS rejeita códigos inválidos com InvalidOperationException na criação do WebACL",
      "RateBasedStatement dentro de Custom.Resource usa PascalCase nativo CloudFormation (AggregateKeyType, Limit) — diferente da interface WAFRule do iacmp que usa camelCase (rateLimit)",
      "Geo-blocking pode bloquear usuarios legítimos via VPN — avaliar impacto em producao substituindo Action: { Block: {} } por Action: { Count: {} } primeiro e analisando CloudWatch Metrics"
    ]
  },
  {
    "id": "aws-secret-vault-1",
    "title": "Secret de API key lido por Lambda via SDK fora de VPC",
    "provider": "aws",
    "constructs": [
      "Secret.Vault",
      "Function.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "secret.vault",
      "function.lambda",
      "policy.iam",
      "secrets-manager",
      "sdk",
      "api-key"
    ],
    "validated": false,
    "stacks": {
      "stacks/storage/api-key-secret-stack.ts": "import { Stack, Secret } from '@iacmp/core';\n\nconst stack = new Stack('api-key-secret');\n\nnew Secret.Vault(stack, 'ApiKeySecret', {\n  description: 'Chave de API do serviço externo',\n});\n\nexport default stack;\n",
      "stacks/compute/api-reader-stack.ts": "import { Stack, Fn, Policy } from '@iacmp/core';\n\nconst stack = new Stack('api-reader');\n\nnew Fn.Lambda(stack, 'ApiReaderFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/api-reader.handler',\n  code: '.',\n  timeout: 10,\n  environment: {\n    SECRET_ARN: 'ApiKeySecret.SecretArn',\n  },\n});\n\nnew Policy.IAM(stack, 'ApiReaderPolicy', {\n  attachTo: 'ApiReaderFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['secretsmanager:GetSecretValue'],\n      resources: ['ApiKeySecret.SecretArn'],\n    },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/api-reader.ts": "import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';\n\nconst client = new SecretsManagerClient({});\n\nlet cachedKey: string | undefined;\n\nasync function getApiKey(): Promise<string> {\n  if (cachedKey) return cachedKey;\n  const secretArn = process.env.SECRET_ARN ?? '';\n  const res = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));\n  const parsed = JSON.parse(res.SecretString ?? '{}') as { apiKey?: string };\n  cachedKey = parsed.apiKey ?? '';\n  return cachedKey;\n}\n\nexport async function handler(event: unknown) {\n  const apiKey = await getApiKey();\n  // Usa a chave para chamar o serviço externo\n  const response = await fetch('https://api.exemplo.com/dados', {\n    headers: { Authorization: `Bearer ${apiKey}` },\n  });\n  const data = await response.json();\n  return {\n    statusCode: 200,\n    body: JSON.stringify({ ok: true, data }),\n  };\n}\n"
    },
    "notes": [
      "Lambda fora de VPC alcança Secrets Manager diretamente pelo endpoint público — se você mover esta Lambda para uma VPC sem NAT Gateway, o SDK vai travar em timeout. Use VPC Interface Endpoint (ver exemplo 3) ou injete via env var.",
      "Policy.IAM com attachTo: 'ApiReaderFn' DEVE estar na MESMA stack TypeScript que o Fn.Lambda('ApiReaderFn') — nunca em stack separada. O synth não localiza a Lambda em outra stack e cria uma role desvinculada.",
      "environment: { SECRET_ARN: 'ApiKeySecret.SecretArn' } resolve para Fn::ImportValue (cross-stack) ou Ref (same-stack) — nunca coloque o ARN hardcoded. Não use ref('ApiKeySecret','SecretArn').toString() — produz '[object Object]'.",
      "GetSecretValueCommand retorna SecretString como string JSON — sempre JSON.parse() antes de acessar campos. O synth gera GenerateSecretString com PasswordLength:32/ExcludePunctuation:true; para armazenar uma chave específica, chame PutSecretValue na AWS CLI ou via SDK após o deploy.",
      "Cache a chave em uma variável de módulo fora do handler (como no exemplo) para evitar uma chamada ao Secrets Manager a cada invocação — o container Lambda é reutilizado entre invocações no mesmo worker."
    ]
  },
  {
    "id": "aws-secret-vault-2",
    "title": "Secret com rotação automática a cada 30 dias via Lambda customizado",
    "provider": "aws",
    "constructs": [
      "Secret.Vault",
      "Function.Lambda",
      "Policy.IAM",
      "Custom.Resource"
    ],
    "tags": [
      "aws",
      "secret.vault",
      "function.lambda",
      "policy.iam",
      "custom.resource",
      "secrets-manager",
      "rotation",
      "rotacao-automatica"
    ],
    "validated": false,
    "stacks": {
      "stacks/storage/rotated-secret-stack.ts": "import { Stack, Secret, Fn, Policy, Custom } from '@iacmp/core';\n\n// Tudo em uma stack: Custom.Resource valida Ref/Fn::GetAtt contra recursos\n// da MESMA stack no synth — misturar Secret + RotationSchedule em stacks\n// separadas exigiria Fn::ImportValue hardcoded no cloudformation.properties.\nconst stack = new Stack('rotated-secret');\n\nnew Secret.Vault(stack, 'ApiRotSecret', {\n  description: 'Secret com rotação automática a cada 30 dias',\n  rotationDays: 30,\n});\n\nnew Fn.Lambda(stack, 'RotationFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/rotate-secret.handler',\n  code: '.',\n  timeout: 30,\n});\n\nnew Policy.IAM(stack, 'RotationFnPolicy', {\n  attachTo: 'RotationFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'secretsmanager:GetSecretValue',\n        'secretsmanager:PutSecretValue',\n        'secretsmanager:DescribeSecret',\n        'secretsmanager:UpdateSecretVersionStage',\n      ],\n      resources: ['ApiRotSecret.SecretArn'],\n    },\n  ],\n});\n\n// Permite que o serviço Secrets Manager invoque a Lambda de rotação.\n// Sem esta permissão o primeiro rotate falha com AccessDenied silencioso.\nnew Custom.Resource(stack, 'RotationLambdaPermission', {\n  cloudformation: {\n    type: 'AWS::Lambda::Permission',\n    properties: {\n      FunctionName: { 'Fn::GetAtt': ['RotationFn', 'Arn'] },\n      Action: 'lambda:InvokeFunction',\n      Principal: 'secretsmanager.amazonaws.com',\n      SourceArn: { Ref: 'ApiRotSecret' },\n    },\n  },\n});\n\n// rotationDays no Secret.Vault NÃO gera RotationSchedule automaticamente\n// no provider AWS — precisa deste Custom.Resource explícito.\nnew Custom.Resource(stack, 'RotationSchedule', {\n  cloudformation: {\n    type: 'AWS::SecretsManager::RotationSchedule',\n    properties: {\n      SecretId: { Ref: 'ApiRotSecret' },\n      RotationLambdaARN: { 'Fn::GetAtt': ['RotationFn', 'Arn'] },\n      RotationRules: { AutomaticallyAfterDays: 30 },\n    },\n  },\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/rotate-secret.ts": "import {\n  SecretsManagerClient,\n  GetSecretValueCommand,\n  PutSecretValueCommand,\n  DescribeSecretCommand,\n  UpdateSecretVersionStageCommand,\n} from '@aws-sdk/client-secrets-manager';\n\nconst client = new SecretsManagerClient({});\n\nfunction generateApiKey(length = 40): string {\n  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';\n  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');\n}\n\nexport async function handler(event: {\n  Step: string;\n  SecretId: string;\n  ClientRequestToken: string;\n}) {\n  const { Step, SecretId, ClientRequestToken } = event;\n\n  const meta = await client.send(new DescribeSecretCommand({ SecretId }));\n  const versions = meta.VersionIdsToStages ?? {};\n\n  if (!(ClientRequestToken in versions)) {\n    throw new Error(\n      `Token ${ClientRequestToken} não está associado ao secret ${SecretId}`,\n    );\n  }\n\n  // Se o token já é AWSCURRENT e não estamos no createSecret, não há nada a fazer.\n  if (\n    versions[ClientRequestToken]?.includes('AWSCURRENT') &&\n    Step !== 'createSecret'\n  ) {\n    return;\n  }\n\n  switch (Step) {\n    case 'createSecret': {\n      // Só cria nova versão AWSPENDING se ainda não existir.\n      const hasPending = Object.values(versions).some(v => v.includes('AWSPENDING'));\n      if (hasPending) return;\n      await client.send(\n        new PutSecretValueCommand({\n          SecretId,\n          ClientRequestToken,\n          SecretString: JSON.stringify({ apiKey: generateApiKey() }),\n          VersionStages: ['AWSPENDING'],\n        }),\n      );\n      break;\n    }\n\n    case 'setSecret':\n      // Para API keys genéricas não há backend externo a notificar.\n      // Se a rotação envolvesse atualizar um provider externo, faça aqui:\n      // const pending = await client.send(new GetSecretValueCommand({ SecretId, VersionStage: 'AWSPENDING' }));\n      // await externService.updateKey(JSON.parse(pending.SecretString!).apiKey);\n      break;\n\n    case 'testSecret': {\n      const res = await client.send(\n        new GetSecretValueCommand({\n          SecretId,\n          VersionId: ClientRequestToken,\n          VersionStage: 'AWSPENDING',\n        }),\n      );\n      const parsed = JSON.parse(res.SecretString ?? '{}') as { apiKey?: string };\n      if (!parsed.apiKey || parsed.apiKey.length < 10) {\n        throw new Error('Versão AWSPENDING inválida ou vazia após createSecret');\n      }\n      break;\n    }\n\n    case 'finishSecret': {\n      const currentToken = Object.entries(versions).find(([, v]) =>\n        v.includes('AWSCURRENT'),\n      )?.[0];\n      if (currentToken === ClientRequestToken) return;\n      await client.send(\n        new UpdateSecretVersionStageCommand({\n          SecretId,\n          VersionStage: 'AWSCURRENT',\n          MoveToVersionId: ClientRequestToken,\n          RemoveFromVersionId: currentToken,\n        }),\n      );\n      break;\n    }\n\n    default:\n      throw new Error(`Step desconhecido: ${Step}`);\n  }\n}\n"
    },
    "notes": [
      "rotationDays no Secret.Vault existe na interface TypeScript mas o provider AWS NÃO gera AWS::SecretsManager::RotationSchedule automaticamente — é necessário o Custom.Resource explícito com type 'AWS::SecretsManager::RotationSchedule' (validado em cloudformation.test.ts linha 568-577).",
      "Custom.Resource valida Ref e Fn::GetAtt contra recursos da MESMA stack no synth (validateResourceReferences). Por isso Secret, Lambda, Policy e RotationSchedule ficam na mesma stack — separar em camadas exigiria Fn::ImportValue hardcoded no cloudformation.properties, frágil ao renomear a stack.",
      "AWS::Lambda::Permission com Principal 'secretsmanager.amazonaws.com' é obrigatório — sem ele o Secrets Manager não consegue invocar a Lambda de rotação e o primeiro rotate falha com AccessDenied sem mensagem clara no console.",
      "O rotation Lambda DEVE implementar os 4 steps na ordem: createSecret → setSecret → testSecret → finishSecret. Secrets Manager aborta e reverte se qualquer step lançar exceção. O step setSecret é o local correto para notificar sistemas externos da nova chave.",
      "A primeira rotação é disparada imediatamente ao criar o RotationSchedule (comportamento AWS padrão) — garanta que a Lambda já está deployada e com as permissões corretas antes do deploy do RotationSchedule."
    ]
  },
  {
    "id": "aws-storage-archive-1",
    "title": "Glacier para backup de logs (archive direto)",
    "provider": "aws",
    "constructs": [
      "Storage.Archive"
    ],
    "tags": [
      "aws",
      "storage.archive",
      "glacier",
      "deep-archive",
      "backup",
      "logs",
      "s3"
    ],
    "validated": false,
    "stacks": {
      "stacks/storage/log-archive-stack.ts": "import { Stack, Storage } from '@iacmp/core';\nconst stack = new Stack('log-archive');\n\nnew Storage.Archive(stack, 'LogArchiveBucket', {\n  retentionDays: 365,\n  retrievalTier: 'Bulk',\n});\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "Storage.Archive gera AWS::S3::Bucket com lifecycle TransitionInDays: 0 → StorageClass: DEEP_ARCHIVE. Objetos vão direto para Deep Archive ao serem escritos, sem período em S3 Standard.",
      "retrievalTier é meta-anotação apenas: o synth NÃO emite essa prop no CloudFormation. A tier de retrieval é escolhida na requisição de restore via SDK (Expedited, Standard, Bulk), não na criação do bucket.",
      "Storage.Archive NÃO está no RESOLVE_MAP do iacmp: ref('LogArchiveBucket','Arn') e ref('LogArchiveBucket','Name') lançam erro em synth. Obtenha o nome do bucket via: aws cloudformation describe-stacks --stack-name log-archive --query 'Stacks[0].Outputs' após o primeiro deploy.",
      "retentionDays: 365 mapeia para ExpirationInDays na lifecycle rule do CFN. Se omitido, objetos nunca expiram automaticamente.",
      "Custo DEEP_ARCHIVE: ~$0.00099/GB/mês vs S3 Standard $0.023/GB/mês. Restore Bulk leva 12-48h; planejar janelas de recuperação para backups de log."
    ]
  },
  {
    "id": "aws-storage-archive-2",
    "title": "Archive com lifecycle rule a partir de S3 (bucket staging + deep archive via SQS)",
    "provider": "aws",
    "constructs": [
      "Storage.Bucket",
      "Storage.Archive",
      "Messaging.Queue",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "storage.bucket",
      "storage.archive",
      "messaging.queue",
      "fn.lambda",
      "policy.iam",
      "lifecycle",
      "glacier",
      "deep-archive",
      "s3",
      "sqs"
    ],
    "validated": false,
    "stacks": {
      "stacks/storage/s3-lifecycle-archive-stack.ts": "import { Stack, Storage, Messaging } from '@iacmp/core';\nconst stack = new Stack('s3-lifecycle-archive');\n\nnew Storage.Bucket(stack, 'DataLakeBucket', {\n  versioning: true,\n  lifecycleRules: [\n    {\n      prefix: 'raw/',\n      transitionToGlacierDays: 90,\n      expireAfterDays: 1825,\n    },\n    {\n      prefix: 'processed/',\n      transitionToGlacierDays: 30,\n      expireAfterDays: 730,\n    },\n  ],\n});\n\nnew Storage.Archive(stack, 'ImmediateArchiveBucket', {\n  retentionDays: 730,\n  retrievalTier: 'Standard',\n});\n\nnew Messaging.Queue(stack, 'ArchiveRequestQueue', {\n  visibilityTimeoutSeconds: 120,\n  messageRetentionSeconds: 1209600,\n});\n\nexport default stack;",
      "stacks/compute/archive-uploader-lambda-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\nconst stack = new Stack('archive-uploader-lambda');\n\nnew Fn.Lambda(stack, 'ArchiveUploaderFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/archiveUploader.handler',\n  code: '.',\n  timeout: 120,\n  memory: 256,\n  environment: {\n    DATA_LAKE_BUCKET: ref('DataLakeBucket', 'Name'),\n  },\n  eventSources: [\n    {\n      queueId: 'ArchiveRequestQueue',\n      batchSize: 1,\n    },\n  ],\n});\n\nexport default stack;",
      "stacks/policy/archive-uploader-policy-stack.ts": "import { Stack, Policy, ref } from '@iacmp/core';\nconst stack = new Stack('archive-uploader-policy');\n\nnew Policy.IAM(stack, 'ArchiveUploaderPolicy', {\n  attachTo: 'ArchiveUploaderFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['s3:GetObject', 's3:GetObjectTagging'],\n      resources: ['DataLakeBucket/*'],\n    },\n    {\n      effect: 'Allow',\n      actions: ['s3:ListBucket'],\n      resources: [ref('DataLakeBucket', 'Arn')],\n    },\n    {\n      effect: 'Allow',\n      actions: ['s3:PutObject'],\n      resources: ['*'],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/archiveUploader.ts": "import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';\nimport type { SQSEvent, SQSRecord } from 'aws-lambda';\n\nconst s3 = new S3Client({});\n\ninterface ArchiveRequest {\n  sourceKey: string;\n  archiveBucketName: string;\n}\n\nasync function processRecord(record: SQSRecord): Promise<void> {\n  const request: ArchiveRequest = JSON.parse(record.body);\n  const { sourceKey, archiveBucketName } = request;\n  const sourceBucket = process.env.DATA_LAKE_BUCKET ?? '';\n\n  const getRes = await s3.send(new GetObjectCommand({\n    Bucket: sourceBucket,\n    Key: sourceKey,\n  }));\n\n  const bodyBytes = await getRes.Body?.transformToByteArray();\n  if (!bodyBytes) {\n    throw new Error(`Objeto ${sourceKey} retornou body vazio`);\n  }\n\n  const archiveKey = `archived/${new Date().toISOString().slice(0, 10)}/${sourceKey}`;\n\n  await s3.send(new PutObjectCommand({\n    Bucket: archiveBucketName,\n    Key: archiveKey,\n    Body: bodyBytes,\n    ContentType: getRes.ContentType,\n    StorageClass: 'DEEP_ARCHIVE',\n  }));\n}\n\nexport const handler = async (event: SQSEvent): Promise<void> => {\n  for (const record of event.Records) {\n    await processRecord(record);\n  }\n};"
    },
    "notes": [
      "Storage.Bucket com lifecycleRules.transitionToGlacierDays emite StorageClass: 'GLACIER' (S3 Glacier Flexible Retrieval) no CFN, NÃO DEEP_ARCHIVE. Para DEEP_ARCHIVE via lifecycle automático, use Storage.Archive.",
      "Storage.Archive NÃO está no RESOLVE_MAP: ref('ImmediateArchiveBucket','Arn') falha em synth. O nome do bucket (archiveBucketName) vem no corpo da mensagem SQS — o sistema publicador obtém o nome via aws cloudformation describe-stacks após o deploy da stack 's3-lifecycle-archive'.",
      "Policy.IAM com s3:PutObject resource '*' é obrigatório para Storage.Archive (sem ARN resolvível). O synth aceita '*' sem erro; IAM aplica a restrição de invoke via Lambda::Permission da fila SQS.",
      "'DataLakeBucket/*' no resources de Policy.IAM é resolvido pelo synth para '<arn-real>/*' via regex s3Match em resolvePolicyResource — é o padrão correto para operações em objetos dentro do bucket (s3:GetObject).",
      "batchSize: 1 na eventSource SQS garante que falha no upload de um objeto não afeta outros registros no batch (SQS não suporta partial batch response para Lambda padrão sem reportBatchItemFailures).",
      "MessagingQueueProps usa visibilityTimeoutSeconds (não visibilityTimeout) — erro comum que o synth só detecta em runtime se o campo errado for passado como prop extra ignorada."
    ]
  },
  {
    "id": "aws-storage-archive-3",
    "title": "Deep Archive para compliance (WORM com Object Lock e retenção de 7 anos)",
    "provider": "aws",
    "constructs": [
      "Storage.Archive",
      "Messaging.Queue",
      "Fn.Lambda",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "storage.archive",
      "messaging.queue",
      "fn.lambda",
      "policy.iam",
      "deep-archive",
      "compliance",
      "worm",
      "object-lock",
      "s3",
      "sqs"
    ],
    "validated": false,
    "stacks": {
      "stacks/storage/compliance-archive-stack.ts": "import { Stack, Storage, Messaging } from '@iacmp/core';\nconst stack = new Stack('compliance-archive');\n\nnew Storage.Archive(stack, 'ComplianceArchiveBucket', {\n  retentionDays: 2555,\n  retrievalTier: 'Standard',\n  lockEnabled: true,\n});\n\nnew Messaging.Queue(stack, 'ComplianceArchiveQueue', {\n  visibilityTimeoutSeconds: 300,\n  messageRetentionSeconds: 1209600,\n});\n\nexport default stack;",
      "stacks/compute/compliance-archiver-lambda-stack.ts": "import { Stack, Fn } from '@iacmp/core';\nconst stack = new Stack('compliance-archiver-lambda');\n\nnew Fn.Lambda(stack, 'ComplianceArchiverFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/complianceArchiver.handler',\n  code: '.',\n  timeout: 300,\n  memory: 512,\n  eventSources: [\n    {\n      queueId: 'ComplianceArchiveQueue',\n      batchSize: 1,\n    },\n  ],\n});\n\nexport default stack;",
      "stacks/policy/compliance-archiver-policy-stack.ts": "import { Stack, Policy } from '@iacmp/core';\nconst stack = new Stack('compliance-archiver-policy');\n\nnew Policy.IAM(stack, 'ComplianceArchiverPolicy', {\n  attachTo: 'ComplianceArchiverFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['s3:PutObject', 's3:PutObjectLegalHold', 's3:PutObjectRetention'],\n      resources: ['*'],\n    },\n    {\n      effect: 'Allow',\n      actions: ['s3:GetBucketObjectLockConfiguration'],\n      resources: ['*'],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/complianceArchiver.ts": "import { S3Client, PutObjectCommand, GetBucketObjectLockConfigurationCommand } from '@aws-sdk/client-s3';\nimport type { SQSEvent, SQSRecord } from 'aws-lambda';\n\nconst s3 = new S3Client({});\n\ninterface ComplianceRecord {\n  recordId: string;\n  recordType: string;\n  payload: Record<string, unknown>;\n  archiveBucketName: string;\n  retainUntil: string;\n}\n\nasync function archiveRecord(record: SQSRecord): Promise<void> {\n  const req: ComplianceRecord = JSON.parse(record.body);\n  const { recordId, recordType, payload, archiveBucketName, retainUntil } = req;\n\n  await s3.send(new GetBucketObjectLockConfigurationCommand({\n    Bucket: archiveBucketName,\n  }));\n\n  const key = `${recordType}/${new Date().toISOString().slice(0, 7)}/${recordId}.json`;\n  const retainUntilDate = new Date(retainUntil);\n\n  await s3.send(new PutObjectCommand({\n    Bucket: archiveBucketName,\n    Key: key,\n    Body: JSON.stringify({ recordId, recordType, archivedAt: new Date().toISOString(), payload }),\n    ContentType: 'application/json',\n    StorageClass: 'DEEP_ARCHIVE',\n    ObjectLockMode: 'COMPLIANCE',\n    ObjectLockRetainUntilDate: retainUntilDate,\n  }));\n}\n\nexport const handler = async (event: SQSEvent): Promise<void> => {\n  for (const record of event.Records) {\n    await archiveRecord(record);\n  }\n};"
    },
    "notes": [
      "lockEnabled: true emite ObjectLockEnabled: true no AWS::S3::Bucket CFN. Para que o Object Lock funcione no deploy, o bucket deve ser CRIADO com essa flag — não é possível habilitar Object Lock em bucket existente sem recriá-lo.",
      "Storage.Archive com lockEnabled NÃO configura ObjectLockConfiguration (DefaultRetention) automaticamente: o synth só liga o flag do bucket. A retenção por objeto é aplicada via ObjectLockMode e ObjectLockRetainUntilDate no PutObjectCommand do handler.",
      "retentionDays: 2555 (≈7 anos) mapeia apenas para ExpirationInDays na lifecycle rule. Esse valor NÃO cria um Object Lock default — é o período antes do objeto ser EXCLUÍDO após o bloqueio expirar. Em compliance, ExpirationInDays deve ser maior ou igual ao período de retenção do lock.",
      "Storage.Archive NÃO está no RESOLVE_MAP: o nome do bucket (archiveBucketName) vem no corpo da mensagem SQS. O publicador obtém o nome via aws cloudformation describe-stacks --stack-name compliance-archive --query 'Stacks[0].Resources[?LogicalResourceId==`ComplianceArchiveBucket`].PhysicalResourceId' após o deploy.",
      "Policy.IAM usa resources: ['*'] para todas as actions S3 porque Storage.Archive não expõe ARN via ref(). Isso é necessário e aceito pelo synth; s3:PutObjectLegalHold e s3:PutObjectRetention requerem permissão explícita além de s3:PutObject para buckets com Object Lock.",
      "Objetos em COMPLIANCE mode de Object Lock não podem ser deletados nem o lock reduzido por nenhum usuário, incluindo root — garantir que retainUntil na mensagem SQS é validado pelo sistema publicador antes de enviar."
    ]
  },
  {
    "id": "aws-storage-filesystem-1",
    "title": "EFS montado em Lambda via access point dedicado",
    "provider": "aws",
    "constructs": [
      "Storage.FileSystem",
      "Fn.Lambda",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "storage.filesystem",
      "fn.lambda",
      "efs",
      "vpc",
      "access-point",
      "policy.iam"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/network-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('efs-lambda-network');\n\nnew Network.VPC(stack, 'AppVpc', { cidr: '10.0.0.0/16' });\n\nnew Network.Subnet(stack, 'PrivateSubnet1', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.1.0/24',\n  availabilityZone: 'us-east-1a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'PrivateSubnet2', {\n  vpcId: 'AppVpc',\n  cidr: '10.0.2.0/24',\n  availabilityZone: 'us-east-1b',\n  public: false,\n});\n\nnew Network.SecurityGroup(stack, 'LambdaSG', {\n  vpcId: 'AppVpc',\n  description: 'Lambda com acesso ao EFS',\n  egressRules: [{ protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0' }],\n});\n\nnew Network.SecurityGroup(stack, 'EfsSG', {\n  vpcId: 'AppVpc',\n  description: 'EFS mount targets — aceita NFS apenas da Lambda',\n  ingressRules: [{\n    protocol: 'tcp',\n    fromPort: 2049,\n    toPort: 2049,\n    sourceSecurityGroupId: 'LambdaSG',\n    description: 'NFS da LambdaSG',\n  }],\n});\n\nexport default stack;",
      "stacks/storage/filesystem-stack.ts": "import { Stack, Storage } from '@iacmp/core';\n\nconst stack = new Stack('efs-lambda-storage');\n\nnew Storage.FileSystem(stack, 'AppFileSystem', {\n  performanceMode: 'generalPurpose',\n  throughputMode: 'bursting',\n  encrypted: true,\n  accessPoints: [\n    { name: 'lambda-ap', path: '/lambda', uid: 1000, gid: 1000 },\n  ],\n});\n\nexport default stack;",
      "stacks/compute/file-processor-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('efs-lambda-compute');\n\nnew Fn.Lambda(stack, 'FileProcessorFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/fileProcessor.handler',\n  code: '.',\n  memory: 512,\n  timeout: 60,\n  vpcId: 'AppVpc',\n  subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],\n  securityGroupIds: ['LambdaSG'],\n  environment: {\n    EFS_MOUNT_PATH: '/mnt/efs',\n  },\n});\n\nexport default stack;",
      "stacks/policy/file-processor-policy-stack.ts": "import { Stack, Policy } from '@iacmp/core';\n\nconst stack = new Stack('efs-lambda-policy');\n\nnew Policy.IAM(stack, 'FileProcessorPolicy', {\n  attachTo: 'FileProcessorFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'elasticfilesystem:ClientMount',\n        'elasticfilesystem:ClientWrite',\n        'elasticfilesystem:ClientRootAccess',\n      ],\n      resources: ['*'],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/fileProcessor.ts": "import * as fs from 'fs';\nimport * as path from 'path';\n\nconst EFS_MOUNT_PATH = process.env.EFS_MOUNT_PATH ?? '/mnt/efs';\n\nexport const handler = async (event: {\n  action: 'read' | 'write';\n  key: string;\n  content?: string;\n}): Promise<{ success: boolean; data?: string; error?: string }> => {\n  const filePath = path.join(EFS_MOUNT_PATH, event.key);\n\n  if (event.action === 'write') {\n    if (event.content === undefined) {\n      return { success: false, error: 'content obrigatorio para escrita' };\n    }\n    fs.mkdirSync(path.dirname(filePath), { recursive: true });\n    fs.writeFileSync(filePath, event.content, 'utf8');\n    return { success: true };\n  }\n\n  if (!fs.existsSync(filePath)) {\n    return { success: false, error: 'arquivo nao encontrado' };\n  }\n\n  const data = fs.readFileSync(filePath, 'utf8');\n  return { success: true, data };\n};"
    },
    "notes": [
      "Fn.Lambda nao tem prop nativa filesystemArn — o synth nao gera FileSystemConfigs. Apos iacmp synth, adicionar manualmente FileSystemConfigs: [{ Arn: <arn-do-access-point>, LocalMountPath: '/mnt/efs' }] no AWS::Lambda::Function gerado, ou aguardar suporte nativo.",
      "Storage.FileSystem nao esta no RESOLVE_MAP do synth — ref('AppFileSystem','Arn') em Policy.IAM resources lanca erro no synth. Usar resources: ['*'] para permissoes elasticfilesystem:Client*.",
      "EFS mount target nao e gerado pelo iacmp — criar via console AWS ou Custom.Resource com AWS::EFS::MountTarget para cada subnet (PrivateSubnet1 e PrivateSubnet2) associando EfsSG.",
      "A Lambda so acessa o EFS se estiver na mesma VPC e AZ que o mount target. Se o mount target existir so em us-east-1a, a Lambda em us-east-1b recebe 'Connection timed out'.",
      "Policy.IAM com attachType 'lambda' e vpcId configurado adiciona automaticamente AWSLambdaVPCAccessExecutionRole — nao e necessario adicionar essa managed policy manualmente."
    ]
  },
  {
    "id": "aws-storage-filesystem-2",
    "title": "EFS compartilhado entre Writer Lambda e Reader Lambda via access points separados",
    "provider": "aws",
    "constructs": [
      "Storage.FileSystem",
      "Fn.Lambda",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "storage.filesystem",
      "fn.lambda",
      "efs",
      "vpc",
      "access-point",
      "shared",
      "multi-lambda",
      "policy.iam"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/shared-network-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('efs-shared-network');\n\nnew Network.VPC(stack, 'SharedVpc', { cidr: '10.1.0.0/16' });\n\nnew Network.Subnet(stack, 'SharedPrivateSubnet1', {\n  vpcId: 'SharedVpc',\n  cidr: '10.1.1.0/24',\n  availabilityZone: 'us-east-1a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'SharedPrivateSubnet2', {\n  vpcId: 'SharedVpc',\n  cidr: '10.1.2.0/24',\n  availabilityZone: 'us-east-1b',\n  public: false,\n});\n\nnew Network.SecurityGroup(stack, 'WriterSG', {\n  vpcId: 'SharedVpc',\n  description: 'Writer Lambda',\n  egressRules: [{ protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0' }],\n});\n\nnew Network.SecurityGroup(stack, 'ReaderSG', {\n  vpcId: 'SharedVpc',\n  description: 'Reader Lambda',\n  egressRules: [{ protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0' }],\n});\n\nnew Network.SecurityGroup(stack, 'SharedEfsSG', {\n  vpcId: 'SharedVpc',\n  description: 'EFS mount targets — aceita NFS de Writer e Reader',\n  ingressRules: [\n    {\n      protocol: 'tcp',\n      fromPort: 2049,\n      toPort: 2049,\n      sourceSecurityGroupId: 'WriterSG',\n      description: 'NFS do Writer',\n    },\n    {\n      protocol: 'tcp',\n      fromPort: 2049,\n      toPort: 2049,\n      sourceSecurityGroupId: 'ReaderSG',\n      description: 'NFS do Reader',\n    },\n  ],\n});\n\nexport default stack;",
      "stacks/storage/shared-filesystem-stack.ts": "import { Stack, Storage } from '@iacmp/core';\n\nconst stack = new Stack('efs-shared-storage');\n\nnew Storage.FileSystem(stack, 'SharedFileSystem', {\n  performanceMode: 'generalPurpose',\n  throughputMode: 'bursting',\n  encrypted: true,\n  accessPoints: [\n    { name: 'writer-ap', path: '/data/writer', uid: 1001, gid: 1001 },\n    { name: 'reader-ap', path: '/data/reader', uid: 1002, gid: 1002 },\n  ],\n});\n\nexport default stack;",
      "stacks/compute/writer-lambda-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('efs-shared-writer');\n\nnew Fn.Lambda(stack, 'WriterFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/efsWriter.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  vpcId: 'SharedVpc',\n  subnetIds: ['SharedPrivateSubnet1', 'SharedPrivateSubnet2'],\n  securityGroupIds: ['WriterSG'],\n  environment: {\n    EFS_WRITER_PATH: '/mnt/efs/writer',\n  },\n});\n\nexport default stack;",
      "stacks/compute/reader-lambda-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('efs-shared-reader');\n\nnew Fn.Lambda(stack, 'ReaderFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/efsReader.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  vpcId: 'SharedVpc',\n  subnetIds: ['SharedPrivateSubnet1', 'SharedPrivateSubnet2'],\n  securityGroupIds: ['ReaderSG'],\n  environment: {\n    EFS_READER_PATH: '/mnt/efs/reader',\n  },\n});\n\nexport default stack;",
      "stacks/policy/writer-policy-stack.ts": "import { Stack, Policy } from '@iacmp/core';\n\nconst stack = new Stack('efs-shared-writer-policy');\n\nnew Policy.IAM(stack, 'WriterPolicy', {\n  attachTo: 'WriterFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'elasticfilesystem:ClientMount',\n        'elasticfilesystem:ClientWrite',\n      ],\n      resources: ['*'],\n    },\n  ],\n});\n\nexport default stack;",
      "stacks/policy/reader-policy-stack.ts": "import { Stack, Policy } from '@iacmp/core';\n\nconst stack = new Stack('efs-shared-reader-policy');\n\nnew Policy.IAM(stack, 'ReaderPolicy', {\n  attachTo: 'ReaderFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'elasticfilesystem:ClientMount',\n      ],\n      resources: ['*'],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/efsWriter.ts": "import * as fs from 'fs';\nimport * as path from 'path';\n\nconst EFS_WRITER_PATH = process.env.EFS_WRITER_PATH ?? '/mnt/efs/writer';\n\nexport const handler = async (event: {\n  filename: string;\n  content: string;\n}): Promise<{ success: boolean; path: string }> => {\n  const dest = path.join(EFS_WRITER_PATH, event.filename);\n  fs.mkdirSync(path.dirname(dest), { recursive: true });\n  fs.writeFileSync(dest, event.content, 'utf8');\n  return { success: true, path: dest };\n};",
      "src/efsReader.ts": "import * as fs from 'fs';\nimport * as path from 'path';\n\nconst EFS_READER_PATH = process.env.EFS_READER_PATH ?? '/mnt/efs/reader';\n\nexport const handler = async (event: {\n  filename: string;\n}): Promise<{ success: boolean; content?: string; error?: string }> => {\n  const src = path.join(EFS_READER_PATH, event.filename);\n  if (!fs.existsSync(src)) {\n    return { success: false, error: `arquivo nao encontrado: ${event.filename}` };\n  }\n  const content = fs.readFileSync(src, 'utf8');\n  return { success: true, content };\n};"
    },
    "notes": [
      "Policy separada por Lambda e obrigatorio — nunca uma unica Policy.IAM com attachTo cobrindo WriterFn e ReaderFn ao mesmo tempo.",
      "Access points separados (writer-ap em /data/writer, reader-ap em /data/reader) isolam o path de cada Lambda no mesmo filesystem. O ReaderFn nao precisa de elasticfilesystem:ClientWrite.",
      "Storage.FileSystem nao esta no RESOLVE_MAP — ref('SharedFileSystem','Arn') em resources lanca erro de synth. Usar resources: ['*'] para ambas as policies.",
      "FileSystemConfigs na Lambda (vinculo EFS<->Lambda) nao e gerado pelo iacmp — necessario adicionar manualmente no template apos synth, um por Lambda, apontando para o access point correto.",
      "Mount targets do EFS devem existir nas mesmas AZs das subnets das Lambdas (us-east-1a e us-east-1b). Criar via console ou Custom.Resource com AWS::EFS::MountTarget associando SharedEfsSG."
    ]
  },
  {
    "id": "aws-storage-filesystem-3",
    "title": "EFS com encryption em repouso e throughput configurado para carga alta",
    "provider": "aws",
    "constructs": [
      "Storage.FileSystem",
      "Fn.Lambda",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup",
      "Policy.IAM"
    ],
    "tags": [
      "aws",
      "storage.filesystem",
      "fn.lambda",
      "efs",
      "vpc",
      "encrypted",
      "throughput",
      "backup",
      "policy.iam"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/secure-network-stack.ts": "import { Stack, Network } from '@iacmp/core';\n\nconst stack = new Stack('efs-secure-network');\n\nnew Network.VPC(stack, 'SecureVpc', { cidr: '10.2.0.0/16' });\n\nnew Network.Subnet(stack, 'SecurePrivateSubnet1', {\n  vpcId: 'SecureVpc',\n  cidr: '10.2.1.0/24',\n  availabilityZone: 'us-east-1a',\n  public: false,\n});\n\nnew Network.Subnet(stack, 'SecurePrivateSubnet2', {\n  vpcId: 'SecureVpc',\n  cidr: '10.2.2.0/24',\n  availabilityZone: 'us-east-1b',\n  public: false,\n});\n\nnew Network.SecurityGroup(stack, 'SecureLambdaSG', {\n  vpcId: 'SecureVpc',\n  description: 'Lambda com acesso ao EFS criptografado',\n  egressRules: [{ protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0' }],\n});\n\nnew Network.SecurityGroup(stack, 'SecureEfsSG', {\n  vpcId: 'SecureVpc',\n  description: 'EFS criptografado — NFS somente da SecureLambdaSG',\n  ingressRules: [{\n    protocol: 'tcp',\n    fromPort: 2049,\n    toPort: 2049,\n    sourceSecurityGroupId: 'SecureLambdaSG',\n    description: 'NFS criptografado da Lambda',\n  }],\n});\n\nexport default stack;",
      "stacks/storage/secure-filesystem-stack.ts": "import { Stack, Storage } from '@iacmp/core';\n\nconst stack = new Stack('efs-secure-storage');\n\nnew Storage.FileSystem(stack, 'SecureFileSystem', {\n  performanceMode: 'generalPurpose',\n  throughputMode: 'bursting',\n  encrypted: true,\n  accessPoints: [\n    { name: 'secure-ap', path: '/secure', uid: 2000, gid: 2000 },\n  ],\n});\n\nexport default stack;",
      "stacks/compute/secure-processor-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('efs-secure-compute');\n\nnew Fn.Lambda(stack, 'SecureProcessorFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/secureProcessor.handler',\n  code: '.',\n  memory: 1024,\n  timeout: 120,\n  vpcId: 'SecureVpc',\n  subnetIds: ['SecurePrivateSubnet1', 'SecurePrivateSubnet2'],\n  securityGroupIds: ['SecureLambdaSG'],\n  environment: {\n    EFS_MOUNT_PATH: '/mnt/efs',\n  },\n});\n\nexport default stack;",
      "stacks/policy/secure-processor-policy-stack.ts": "import { Stack, Policy } from '@iacmp/core';\n\nconst stack = new Stack('efs-secure-policy');\n\nnew Policy.IAM(stack, 'SecureProcessorPolicy', {\n  attachTo: 'SecureProcessorFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: [\n        'elasticfilesystem:ClientMount',\n        'elasticfilesystem:ClientWrite',\n        'elasticfilesystem:ClientRootAccess',\n      ],\n      resources: ['*'],\n    },\n    {\n      effect: 'Allow',\n      actions: [\n        'kms:Decrypt',\n        'kms:GenerateDataKey',\n      ],\n      resources: ['*'],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/secureProcessor.ts": "import * as fs from 'fs';\nimport * as path from 'path';\nimport * as crypto from 'crypto';\n\nconst EFS_MOUNT_PATH = process.env.EFS_MOUNT_PATH ?? '/mnt/efs';\n\nfunction checksumFile(filePath: string): string {\n  const content = fs.readFileSync(filePath);\n  return crypto.createHash('sha256').update(content).digest('hex');\n}\n\nexport const handler = async (event: {\n  action: 'write' | 'verify' | 'list';\n  key?: string;\n  content?: string;\n}): Promise<{ success: boolean; result?: unknown; error?: string }> => {\n  if (event.action === 'write') {\n    if (!event.key || event.content === undefined) {\n      return { success: false, error: 'key e content obrigatorios para escrita' };\n    }\n    const dest = path.join(EFS_MOUNT_PATH, event.key);\n    fs.mkdirSync(path.dirname(dest), { recursive: true });\n    fs.writeFileSync(dest, event.content, 'utf8');\n    const checksum = checksumFile(dest);\n    return { success: true, result: { path: dest, checksum } };\n  }\n\n  if (event.action === 'verify') {\n    if (!event.key) {\n      return { success: false, error: 'key obrigatorio para verificacao' };\n    }\n    const src = path.join(EFS_MOUNT_PATH, event.key);\n    if (!fs.existsSync(src)) {\n      return { success: false, error: 'arquivo nao encontrado' };\n    }\n    const checksum = checksumFile(src);\n    return { success: true, result: { exists: true, checksum } };\n  }\n\n  if (event.action === 'list') {\n    if (!fs.existsSync(EFS_MOUNT_PATH)) {\n      return { success: true, result: [] };\n    }\n    const files = fs.readdirSync(EFS_MOUNT_PATH, { recursive: true }) as string[];\n    return { success: true, result: files.filter(f => !fs.statSync(path.join(EFS_MOUNT_PATH, f)).isDirectory()) };\n  }\n\n  return { success: false, error: `action desconhecida: ${event.action}` };\n};"
    },
    "notes": [
      "backupPolicy nao e uma prop de StorageFileSystemProps no iacmp atual. Para ativar AWS Backup no EFS, usar o console AWS (EFS > File systems > Backups) ou Custom.Resource com cloudformation: { type: 'AWS::EFS::FileSystem', properties: { BackupPolicy: { Status: 'ENABLED' } } }.",
      "throughputMode: 'provisioned' no iacmp gera ThroughputMode: provisioned no CloudFormation, mas o synth nao emite ProvisionedThroughputInMibps — o CFN rejeita com ValidationError. Usar 'bursting' ate o iacmp adicionar suporte ao campo provisionedThroughputInMibps.",
      "encrypted: true ativa SSE com chave gerenciada pela AWS (aws/elasticfilesystem). Para KMS customer-managed key, necessario Custom.Resource com KmsKeyId no AWS::EFS::FileSystem.",
      "O synth adiciona automaticamente LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }] — arquivos nao acessados em 30 dias sao movidos para EFS-IA (menor custo). Nao ha como desativar isso sem Custom.Resource.",
      "Storage.FileSystem nao esta no RESOLVE_MAP — ref('SecureFileSystem','Arn') em Policy.IAM resources lanca erro no synth. Permissoes KMS com resources: ['*'] sao aceitas pela AWS sem restricao de recurso especifico quando a key e gerenciada pelo servico."
    ]
  },
  {
    "id": "azure-alarm-cpu-high",
    "title": "Azure Monitor Alert — alarme de CPU alta em Container App",
    "provider": "azure",
    "constructs": [
      "Compute.Container",
      "Monitoring.Alarm"
    ],
    "tags": [
      "monitor",
      "alarm",
      "cpu",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/azure-alarm-cpu-high.ts": "import { Stack, Compute, Monitoring } from '@iacmp/core';\n\nconst stack = new Stack('azure-alarm-cpu-high', { provider: 'azure' });\n\nnew Compute.Container(stack, 'ApiApp', {\n  image: 'myapp:latest',\n  port: 8080,\n  cpu: 512,\n  memory: 1024,\n});\n\nnew Monitoring.Alarm(stack, 'CpuHighAlarm', {\n  metricName: 'Duration',\n  threshold: 80,\n  evaluationPeriods: 3,\n  periodSeconds: 300,\n  comparisonOperator: 'GreaterThanThreshold',\n  statistic: 'Average',\n  treatMissingData: 'notBreaching',\n});\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "Monitoring.Alarm = Microsoft.Insights/metricAlerts; exemplo apenas infraestrutura, sem handler",
      "metricName 'Duration' é mapeado para 'TotalCpuUsage' no synth Azure (métrica de Container Apps)",
      "escopo do alarme é resolvido automaticamente para o Compute.Container presente na stack; evaluationPeriods 3 × 300s = janela de 15 minutos"
    ]
  },
  {
    "id": "azure-alarm-latency",
    "title": "Azure Monitor Alert — latência P99 acima de 500ms",
    "provider": "azure",
    "constructs": [
      "Compute.Container",
      "Monitoring.Alarm"
    ],
    "tags": [
      "monitor",
      "alarm",
      "latency",
      "p99",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/azure-alarm-latency.ts": "import { Stack, Compute, Monitoring } from '@iacmp/core';\n\nconst stack = new Stack('azure-alarm-latency', { provider: 'azure' });\n\nnew Compute.Container(stack, 'ApiApp', {\n  image: 'myapi:latest',\n  port: 8080,\n});\n\nnew Monitoring.Alarm(stack, 'LatencyP99Alarm', {\n  metricName: 'p99',\n  threshold: 500,\n  evaluationPeriods: 5,\n  periodSeconds: 60,\n  comparisonOperator: 'GreaterThanThreshold',\n  statistic: 'Maximum',\n  treatMissingData: 'notBreaching',\n});\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "metricName 'p99' é mapeado para 'Requests' com timeAggregation 'Maximum' no synth Azure; threshold 500 = 500ms",
      "evaluationPeriods 5 × periodSeconds 60s = janela de avaliação de 5 minutos (PT5M no formato ISO 8601 gerado pelo synth)",
      "Monitoring.Alarm gera apenas infraestrutura; ref() expõe AlarmArn e Name para outros constructs referenciarem este alarme"
    ]
  },
  {
    "id": "azure-apim-public-api",
    "title": "Azure APIM — gateway público com múltiplas rotas e CORS",
    "provider": "azure",
    "constructs": [
      "Fn.Lambda",
      "Fn.ApiGateway"
    ],
    "tags": [
      "apim",
      "api-gateway",
      "cors",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/apim-public-api-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('apim-public-api');\n\nnew Fn.Lambda(stack, 'CatalogFn', {\n  runtime: 'nodejs20',\n  handler: 'catalog.handler',\n  code: 'dist/',\n  memory: 256,\n  timeout: 15,\n});\n\nnew Fn.Lambda(stack, 'OrderFn', {\n  runtime: 'nodejs20',\n  handler: 'order.handler',\n  code: 'dist/',\n  memory: 256,\n  timeout: 15,\n});\n\nnew Fn.ApiGateway(stack, 'StorefrontApi', {\n  name: 'storefront-api',\n  stageName: 'api',\n  cors: true,\n  routes: [\n    { method: 'GET', path: '/products', lambdaId: 'CatalogFn' },\n    { method: 'GET', path: '/products/{id}', lambdaId: 'CatalogFn' },\n    { method: 'POST', path: '/orders', lambdaId: 'OrderFn' },\n    { method: 'GET', path: '/orders/{id}', lambdaId: 'OrderFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/catalog.ts": "const products: Record<string, { id: string; name: string; price: number; stock: number }> = {\n  p1: { id: 'p1', name: 'Widget Pro', price: 49.99, stock: 100 },\n  p2: { id: 'p2', name: 'Gadget Plus', price: 99.99, stock: 50 },\n  p3: { id: 'p3', name: 'Tool Max', price: 29.99, stock: 200 },\n};\n\nexport async function handler(event: any) {\n  const method = event.httpMethod ?? event.requestContext?.http?.method ?? 'GET';\n  const id = event.pathParameters?.id ?? (event.path || '').split('/').filter(Boolean).pop();\n\n  const headers = {\n    'Content-Type': 'application/json',\n    'Access-Control-Allow-Origin': '*',\n    'Access-Control-Allow-Headers': 'Content-Type,Authorization',\n    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',\n  };\n\n  if (method === 'OPTIONS') {\n    return { statusCode: 200, headers, body: '' };\n  }\n\n  if (id && method === 'GET') {\n    const product = products[id];\n    if (!product) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Product not found' }) };\n    return { statusCode: 200, headers, body: JSON.stringify(product) };\n  }\n\n  if (method === 'GET') {\n    return { statusCode: 200, headers, body: JSON.stringify(Object.values(products)) };\n  }\n\n  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };\n}",
      "src/order.ts": "import { randomUUID } from 'crypto';\n\nconst orders: Record<string, { id: string; productId: string; quantity: number; status: string; createdAt: string }> = {};\n\nexport async function handler(event: any) {\n  const method = event.httpMethod ?? event.requestContext?.http?.method ?? 'GET';\n  const id = event.pathParameters?.id ?? (event.path || '').split('/').filter(Boolean).pop();\n\n  const headers = {\n    'Content-Type': 'application/json',\n    'Access-Control-Allow-Origin': '*',\n  };\n\n  if (method === 'POST') {\n    const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n    const { productId, quantity } = body;\n    if (!productId || !quantity) {\n      return { statusCode: 400, headers, body: JSON.stringify({ error: 'productId and quantity are required' }) };\n    }\n    const orderId = randomUUID();\n    const order = { id: orderId, productId, quantity: Number(quantity), status: 'pending', createdAt: new Date().toISOString() };\n    orders[orderId] = order;\n    return { statusCode: 201, headers, body: JSON.stringify(order) };\n  }\n\n  if (method === 'GET' && id) {\n    const order = orders[id];\n    if (!order) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Order not found' }) };\n    return { statusCode: 200, headers, body: JSON.stringify(order) };\n  }\n\n  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };\n}"
    },
    "notes": [
      "Fn.ApiGateway = APIM no Azure; stageName nunca pode ser string vazia — sempre 'api' (ou outro valor não-vazio)",
      "cors: true habilita CORS nativo no APIM — o handler ainda deve retornar Access-Control-Allow-Origin: * nos headers de resposta",
      "Handlers Azure: NUNCA @aws-sdk/*; export async function handler(event: any) retornando { statusCode, headers, body }",
      "environment na stack: valores são ref() ou strings literais — NUNCA process.env.X (process.env só existe dentro do handler em runtime)"
    ]
  },
  {
    "id": "azure-apim-rate-limit",
    "title": "Azure APIM — gateway com rate limit e autenticação por chave",
    "provider": "azure",
    "constructs": [
      "Secret.Vault",
      "Fn.Lambda",
      "Policy.IAM",
      "Fn.ApiGateway"
    ],
    "tags": [
      "apim",
      "api-gateway",
      "rate-limit",
      "auth",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/apim-rate-limit-stack.ts": "import { Stack, Fn, Secret, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('apim-rate-limit');\n\nnew Secret.Vault(stack, 'ApiKeyVault', {\n  description: 'API keys para autenticação de parceiros externos',\n});\n\nnew Fn.Lambda(stack, 'DataApiFn', {\n  runtime: 'nodejs20',\n  handler: 'dataApi.handler',\n  code: 'dist/',\n  memory: 256,\n  timeout: 30,\n  environment: {\n    VAULT_URI: ref('ApiKeyVault', 'VaultUri'),\n  },\n});\n\nnew Policy.IAM(stack, 'DataApiFnPolicy', {\n  attachTo: 'DataApiFn',\n  attachType: 'lambda',\n  statements: [{\n    effect: 'Allow',\n    actions: ['keyvault:GetSecretValue'],\n    resources: [ref('ApiKeyVault', 'Arn')],\n  }],\n});\n\nnew Fn.ApiGateway(stack, 'SecureApi', {\n  name: 'data-api',\n  stageName: 'api',\n  throttlingRateLimit: 100,\n  throttlingBurstLimit: 50,\n  routes: [\n    { method: 'GET', path: '/data', lambdaId: 'DataApiFn' },\n    { method: 'GET', path: '/data/{id}', lambdaId: 'DataApiFn' },\n    { method: 'POST', path: '/data', lambdaId: 'DataApiFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/dataApi.ts": "import { SecretClient } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\nimport { randomUUID } from 'crypto';\n\nlet secretClient: SecretClient | null = null;\nconst keyCache: Map<string, { value: string; expiresAt: number }> = new Map();\nconst store: Record<string, { id: string; payload: unknown; createdAt: string }> = {};\n\nfunction getSecretClient(): SecretClient {\n  if (!secretClient) {\n    secretClient = new SecretClient(process.env.VAULT_URI!, new DefaultAzureCredential());\n  }\n  return secretClient;\n}\n\nasync function getApiKey(secretName: string): Promise<string | null> {\n  const cached = keyCache.get(secretName);\n  if (cached && cached.expiresAt > Date.now()) return cached.value;\n  try {\n    const secret = await getSecretClient().getSecret(secretName);\n    const value = secret.value ?? '';\n    keyCache.set(secretName, { value, expiresAt: Date.now() + 5 * 60 * 1000 });\n    return value;\n  } catch {\n    return null;\n  }\n}\n\nexport async function handler(event: any) {\n  const method = event.httpMethod ?? event.requestContext?.http?.method ?? 'GET';\n  const id = event.pathParameters?.id ?? (event.path || '').split('/').filter(Boolean).pop();\n  const headers = { 'Content-Type': 'application/json' };\n\n  const incomingKey = event.headers?.['x-api-key'] ?? event.headers?.['X-Api-Key'] ?? '';\n  const validKey = await getApiKey('partner-api-key');\n\n  if (!validKey || incomingKey !== validKey) {\n    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or missing API key' }) };\n  }\n\n  if (method === 'POST') {\n    const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n    const entryId = randomUUID();\n    store[entryId] = { id: entryId, payload: body, createdAt: new Date().toISOString() };\n    return { statusCode: 201, headers, body: JSON.stringify(store[entryId]) };\n  }\n\n  if (method === 'GET' && id) {\n    const entry = store[id];\n    if (!entry) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };\n    return { statusCode: 200, headers, body: JSON.stringify(entry) };\n  }\n\n  if (method === 'GET') {\n    return { statusCode: 200, headers, body: JSON.stringify(Object.values(store)) };\n  }\n\n  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };\n}"
    },
    "notes": [
      "Secret.Vault no Azure = Key Vault: handler usa @azure/keyvault-secrets + DefaultAzureCredential (npm install @azure/keyvault-secrets @azure/identity)",
      "Policy.IAM para Key Vault usa dataActions: actions: ['keyvault:GetSecretValue'], resources: [ref('ApiKeyVault', 'Arn')]",
      "VAULT_URI: ref('ApiKeyVault', 'VaultUri') — atributo VaultUri emite a URI completa do Key Vault (https://kv-xxx.vault.azure.net/)",
      "throttlingRateLimit (req/s sustentado) e throttlingBurstLimit (req/s em pico) habilitam rate limiting nativo no APIM sem código adicional"
    ]
  },
  {
    "id": "azure-blob-backup",
    "title": "Azure Blob Storage — backup automático de banco de dados",
    "provider": "azure",
    "constructs": [
      "Storage.Bucket",
      "Database.SQL",
      "Fn.Lambda",
      "Events.EventBridge",
      "Policy.IAM"
    ],
    "tags": [
      "blob",
      "storage",
      "backup",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/database/db-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('azure-blob-backup-database');\n\nnew Database.SQL(stack, 'AppDB', {\n  engine: 'postgres',\n  instanceType: 'small',\n  storageGb: 20,\n});\n\nexport default stack;",
      "stacks/storage/backup-storage-stack.ts": "import { Stack, Storage } from '@iacmp/core';\n\nconst stack = new Stack('azure-blob-backup-storage');\n\nnew Storage.Bucket(stack, 'BackupsBucket', {\n  versioning: true,\n  lifecycleRules: [{ prefix: 'backups/', expireAfterDays: 30 }],\n});\n\nexport default stack;",
      "stacks/compute/backup-compute-stack.ts": "import { Stack, ref, Fn, Events, Policy } from '@iacmp/core';\n\nconst stack = new Stack('azure-blob-backup-compute');\n\nnew Fn.Lambda(stack, 'DatabaseBackupFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/databaseBackup.handler',\n  code: '.',\n  memory: 512,\n  timeout: 300,\n  environment: {\n    STORAGE_CONNECTION: ref('BackupsBucket', 'Endpoint'),\n    DB_HOST: ref('AppDB', 'Endpoint'),\n    DB_NAME: 'postgres',\n    DB_USER: ref('AppDB', 'Username'),\n    DB_PASSWORD: ref('AppDB', 'Password'),\n  },\n});\n\nnew Events.EventBridge(stack, 'BackupSchedule', {\n  rules: [\n    {\n      name: 'daily-backup',\n      cron: '0 2 * * ? *',\n      targetLambdaId: 'DatabaseBackupFn',\n      description: 'Daily database backup at 02:00 UTC',\n    },\n  ],\n});\n\nnew Policy.IAM(stack, 'DatabaseBackupFnIAM', {\n  attachTo: 'DatabaseBackupFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['blob:read', 'blob:write', 'blob:create', 'blob:delete'],\n      resources: [ref('BackupsBucket', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/databaseBackup.ts": "import { BlobServiceClient } from '@azure/storage-blob';\nimport { Client } from 'pg';\n\nexport async function handler(event: any) {\n  const now = new Date();\n  const dateStr = now.toISOString().slice(0, 10);\n  const blobName = `db-backup-${dateStr}-${now.getTime()}.sql`;\n\n  const db = new Client({\n    host: process.env.DB_HOST!,\n    database: process.env.DB_NAME!,\n    user: process.env.DB_USER!,\n    password: process.env.DB_PASSWORD!,\n    port: 5432,\n    ssl: { rejectUnauthorized: false },\n  });\n\n  await db.connect();\n\n  try {\n    const tablesRes = await db.query<{ tablename: string }>(\n      \"SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename\",\n    );\n\n    const lines: string[] = [`-- PostgreSQL backup — ${now.toISOString()}`, ''];\n\n    for (const { tablename } of tablesRes.rows) {\n      lines.push(`-- Table: ${tablename}`);\n\n      const colsRes = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(\n        `SELECT column_name, data_type, is_nullable\n         FROM information_schema.columns\n         WHERE table_schema = 'public' AND table_name = $1\n         ORDER BY ordinal_position`,\n        [tablename],\n      );\n\n      const colDefs = colsRes.rows\n        .map((c) => `\"${c.column_name}\" ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`)\n        .join(', ');\n      lines.push(`CREATE TABLE IF NOT EXISTS \"${tablename}\" (${colDefs});`);\n\n      const rowsRes = await db.query(`SELECT * FROM \"${tablename}\" LIMIT 10000`);\n      for (const row of rowsRes.rows) {\n        const cols = Object.keys(row).map((k) => `\"${k}\"`).join(', ');\n        const vals = Object.values(row)\n          .map((v) => {\n            if (v === null) return 'NULL';\n            if (typeof v === 'string') return `'${v.replace(/'/g, \"''\")}'`;\n            if (v instanceof Date) return `'${v.toISOString()}'`;\n            return String(v);\n          })\n          .join(', ');\n        lines.push(`INSERT INTO \"${tablename}\" (${cols}) VALUES (${vals});`);\n      }\n      lines.push('');\n    }\n\n    const sqlDump = lines.join('\\n');\n    const buffer = Buffer.from(sqlDump, 'utf-8');\n\n    const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION!);\n    const containerClient = blobServiceClient.getContainerClient('backups');\n    await containerClient.createIfNotExists();\n\n    const blockBlobClient = containerClient.getBlockBlobClient(blobName);\n    await blockBlobClient.uploadData(buffer, {\n      blobHTTPHeaders: { blobContentType: 'text/plain; charset=utf-8' },\n    });\n\n    return {\n      statusCode: 200,\n      body: JSON.stringify({\n        backup: blobName,\n        sizeBytes: buffer.length,\n        tables: tablesRes.rows.length,\n      }),\n    };\n  } finally {\n    await db.end();\n  }\n}"
    },
    "notes": [
      "Storage.Bucket = Azure Blob Storage. NUNCA @aws-sdk/*. Handler usa @azure/storage-blob: BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION!).",
      "Database.SQL: DB_NAME:'postgres', ssl:{rejectUnauthorized:false}, DB_USER:ref('AppDB','Username'). Valores literais ('postgres') sao permitidos em environment; ref() para atributos dinamicos.",
      "createIfNotExists() obrigatorio — container 'backups' nao existe por padrao no Blob Storage.",
      "lifecycleRules com expireAfterDays:30 descarta backups antigos automaticamente, controlando custo de armazenamento."
    ]
  },
  {
    "id": "azure-blob-presigned-url",
    "title": "Azure Blob Storage — URL pré-assinada para download temporário",
    "provider": "azure",
    "constructs": [
      "Storage.Bucket",
      "Fn.Lambda",
      "Fn.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "blob",
      "storage",
      "presigned-url",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/storage/files-stack.ts": "import { Stack, Storage } from '@iacmp/core';\n\nconst stack = new Stack('azure-blob-presigned-url-storage');\n\nnew Storage.Bucket(stack, 'FilesBucket', {\n  versioning: true,\n});\n\nexport default stack;",
      "stacks/compute/files-api-stack.ts": "import { Stack, ref, Fn, Policy } from '@iacmp/core';\n\nconst stack = new Stack('azure-blob-presigned-url-compute');\n\nnew Fn.Lambda(stack, 'GetDownloadUrlFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/getDownloadUrl.handler',\n  code: '.',\n  memory: 256,\n  timeout: 10,\n  environment: {\n    STORAGE_CONNECTION: ref('FilesBucket', 'Endpoint'),\n  },\n});\n\nnew Fn.Lambda(stack, 'UploadFileFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/uploadFile.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  environment: {\n    STORAGE_CONNECTION: ref('FilesBucket', 'Endpoint'),\n  },\n});\n\nnew Fn.ApiGateway(stack, 'FilesApi', {\n  name: 'files-api',\n  cors: true,\n  routes: [\n    { method: 'POST', path: '/files', lambdaId: 'UploadFileFn' },\n    { method: 'GET', path: '/files/{blobName+}/download-url', lambdaId: 'GetDownloadUrlFn' },\n  ],\n});\n\nnew Policy.IAM(stack, 'GetDownloadUrlFnIAM', {\n  attachTo: 'GetDownloadUrlFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['blob:read'],\n      resources: [ref('FilesBucket', 'Arn')],\n    },\n  ],\n});\n\nnew Policy.IAM(stack, 'UploadFileFnIAM', {\n  attachTo: 'UploadFileFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['blob:read', 'blob:write', 'blob:create'],\n      resources: [ref('FilesBucket', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/getDownloadUrl.ts": "import {\n  BlobServiceClient,\n  BlobSASPermissions,\n  StorageSharedKeyCredential,\n  generateBlobSASQueryParameters,\n} from '@azure/storage-blob';\n\nexport async function handler(event: any) {\n  const blobName = event.pathParameters?.blobName;\n  const ttlMinutes = parseInt(event.queryStringParameters?.ttl ?? '60', 10);\n\n  if (!blobName) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'blobName is required' }) };\n  }\n  if (isNaN(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'ttl must be between 1 and 1440 minutes' }) };\n  }\n\n  const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION!);\n  const containerClient = blobServiceClient.getContainerClient('files');\n  const blockBlobClient = containerClient.getBlockBlobClient(blobName);\n\n  const exists = await blockBlobClient.exists();\n  if (!exists) {\n    return { statusCode: 404, body: JSON.stringify({ error: 'File not found' }) };\n  }\n\n  const expiresOn = new Date(Date.now() + ttlMinutes * 60 * 1000);\n\n  const sasToken = generateBlobSASQueryParameters(\n    {\n      containerName: 'files',\n      blobName,\n      permissions: BlobSASPermissions.parse('r'),\n      expiresOn,\n    },\n    blobServiceClient.credential as StorageSharedKeyCredential,\n  ).toString();\n\n  const downloadUrl = `${blockBlobClient.url}?${sasToken}`;\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ downloadUrl, blobName, expiresAt: expiresOn.toISOString() }),\n  };\n}",
      "src/uploadFile.ts": "import { BlobServiceClient } from '@azure/storage-blob';\n\nexport async function handler(event: any) {\n  const body = JSON.parse(event.body || '{}');\n  const { filename, content, contentType = 'application/octet-stream' } = body as {\n    filename: string;\n    content: string;\n    contentType?: string;\n  };\n\n  if (!filename || !content) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'filename and content (base64) are required' }) };\n  }\n\n  const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION!);\n  const containerClient = blobServiceClient.getContainerClient('files');\n  await containerClient.createIfNotExists();\n\n  const safeName = filename.replace(/[^a-zA-Z0-9._\\-\\/]/g, '_');\n  const blobName = `${Date.now()}-${safeName}`;\n  const blockBlobClient = containerClient.getBlockBlobClient(blobName);\n\n  const buffer = Buffer.from(content, 'base64');\n  await blockBlobClient.uploadData(buffer, {\n    blobHTTPHeaders: { blobContentType: contentType },\n  });\n\n  return {\n    statusCode: 201,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ blobName, sizeBytes: buffer.length }),\n  };\n}"
    },
    "notes": [
      "Storage.Bucket = Blob Storage. NUNCA @aws-sdk/*. Handler usa @azure/storage-blob: BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION!).",
      "BlobSASPermissions.parse('r') gera SAS somente leitura (download). Para upload usar 'cw' (create+write). Para delete adicionar 'd'.",
      "blockBlobClient.exists() verifica a existencia do blob antes de gerar SAS — evita gerar URL valida para arquivo inexistente.",
      "Rota com {blobName+} (greedy) captura keys com barras (ex: pasta/subpasta/arquivo.pdf). Sem o '+' a barra gera 404 no gateway."
    ]
  },
  {
    "id": "azure-blob-upload-api",
    "title": "Azure Blob Storage — upload de arquivos via SAS token",
    "provider": "azure",
    "constructs": [
      "Storage.Bucket",
      "Fn.Lambda",
      "Fn.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "blob",
      "storage",
      "upload",
      "sas",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/storage/uploads-stack.ts": "import { Stack, Storage } from '@iacmp/core';\n\nconst stack = new Stack('azure-blob-upload-api-storage');\n\nnew Storage.Bucket(stack, 'UploadsBucket', {\n  cors: [\n    {\n      allowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],\n      allowedOrigins: ['*'],\n      allowedHeaders: ['*'],\n      maxAgeSeconds: 3600,\n    },\n  ],\n});\n\nexport default stack;",
      "stacks/compute/upload-api-stack.ts": "import { Stack, ref, Fn, Policy } from '@iacmp/core';\n\nconst stack = new Stack('azure-blob-upload-api-compute');\n\nnew Fn.Lambda(stack, 'GenerateSASFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/generateSAS.handler',\n  code: '.',\n  memory: 256,\n  timeout: 15,\n  environment: {\n    STORAGE_CONNECTION: ref('UploadsBucket', 'Endpoint'),\n  },\n});\n\nnew Fn.Lambda(stack, 'ListFilesFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/listFiles.handler',\n  code: '.',\n  memory: 256,\n  timeout: 15,\n  environment: {\n    STORAGE_CONNECTION: ref('UploadsBucket', 'Endpoint'),\n  },\n});\n\nnew Fn.ApiGateway(stack, 'UploadsApi', {\n  name: 'uploads-api',\n  cors: true,\n  routes: [\n    { method: 'POST', path: '/upload-url', lambdaId: 'GenerateSASFn' },\n    { method: 'GET', path: '/files', lambdaId: 'ListFilesFn' },\n  ],\n});\n\nnew Policy.IAM(stack, 'GenerateSASFnIAM', {\n  attachTo: 'GenerateSASFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['blob:read', 'blob:write', 'blob:create'],\n      resources: [ref('UploadsBucket', 'Arn')],\n    },\n  ],\n});\n\nnew Policy.IAM(stack, 'ListFilesFnIAM', {\n  attachTo: 'ListFilesFn',\n  attachType: 'lambda',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['blob:read'],\n      resources: [ref('UploadsBucket', 'Arn')],\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/generateSAS.ts": "import {\n  BlobServiceClient,\n  BlobSASPermissions,\n  StorageSharedKeyCredential,\n  generateBlobSASQueryParameters,\n} from '@azure/storage-blob';\n\nexport async function handler(event: any) {\n  const body = JSON.parse(event.body || '{}');\n  const { filename, contentType = 'application/octet-stream' } = body as {\n    filename: string;\n    contentType?: string;\n  };\n\n  if (!filename) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'filename is required' }) };\n  }\n\n  const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION!);\n  const containerClient = blobServiceClient.getContainerClient('uploads');\n  await containerClient.createIfNotExists();\n\n  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');\n  const blobName = `${Date.now()}-${safeName}`;\n  const blockBlobClient = containerClient.getBlockBlobClient(blobName);\n\n  const expiresOn = new Date(Date.now() + 5 * 60 * 1000);\n\n  const sasToken = generateBlobSASQueryParameters(\n    {\n      containerName: 'uploads',\n      blobName,\n      permissions: BlobSASPermissions.parse('cw'),\n      expiresOn,\n      contentType,\n    },\n    blobServiceClient.credential as StorageSharedKeyCredential,\n  ).toString();\n\n  const sasUrl = `${blockBlobClient.url}?${sasToken}`;\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ sasUrl, blobName, expiresAt: expiresOn.toISOString() }),\n  };\n}",
      "src/listFiles.ts": "import { BlobServiceClient } from '@azure/storage-blob';\n\ninterface BlobItem {\n  name: string;\n  size: number;\n  lastModified: string;\n  contentType: string;\n}\n\nexport async function handler(event: any) {\n  const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION!);\n  const containerClient = blobServiceClient.getContainerClient('uploads');\n  await containerClient.createIfNotExists();\n\n  const files: BlobItem[] = [];\n  for await (const blob of containerClient.listBlobsFlat()) {\n    files.push({\n      name: blob.name,\n      size: blob.properties.contentLength ?? 0,\n      lastModified: blob.properties.lastModified?.toISOString() ?? '',\n      contentType: blob.properties.contentType ?? 'application/octet-stream',\n    });\n  }\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ files, count: files.length }),\n  };\n}"
    },
    "notes": [
      "Storage.Bucket no Azure = Blob Storage. NUNCA @aws-sdk/*. Usar @azure/storage-blob com BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION!).",
      "createIfNotExists() obrigatorio no handler — o container 'uploads' nao existe por padrao no Blob Storage.",
      "SAS gerado via generateBlobSASQueryParameters com blobServiceClient.credential as StorageSharedKeyCredential. BlobSASPermissions.parse('cw') para upload (create+write).",
      "ref() e um objeto interno — NUNCA concatenar com string nem chamar .toString(). Para Policy.IAM resources usar ref('UploadsBucket','Arn'); para env var de conexao usar ref('UploadsBucket','Endpoint')."
    ]
  },
  {
    "id": "azure-combo-01",
    "title": "Azure: APIM + Function + Cosmos Table — API de pedidos",
    "provider": "azure",
    "constructs": [
      "Messaging.Queue",
      "Database.DynamoDB",
      "Fn.Lambda",
      "Fn.ApiGateway"
    ],
    "tags": [
      "apim",
      "function",
      "cosmos-table",
      "service-bus",
      "orders",
      "async"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/orders-queue-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('orders-queue-stack');\n\nnew Messaging.Queue(stack, 'OrdersQueue', {\n  visibilityTimeoutSeconds: 60,\n  messageRetentionSeconds: 345600,\n});\n\nexport default stack;",
      "stacks/database/orders-table-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('orders-table-stack');\n\nnew Database.DynamoDB(stack, 'OrdersTable', {\n  partitionKey: 'partitionKey',\n  sortKey: 'rowKey',\n  billingMode: 'PAY_PER_REQUEST',\n});\n\nexport default stack;",
      "stacks/compute/orders-compute-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('orders-compute-stack');\n\nnew Fn.Lambda(stack, 'CreateOrderFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/createOrder.handler',\n  code: '.',\n  environment: {\n    COSMOS_CONNECTION: ref('OrdersTable', 'ConnectionString'),\n    TABLE_NAME: ref('OrdersTable', 'Name'),\n    ORDERS_QUEUE_CONNECTION_STRING: ref('OrdersQueue', 'ConnectionString'),\n    QUEUE_NAME: 'OrdersQueue',\n  },\n});\n\nnew Fn.Lambda(stack, 'ListOrdersFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/listOrders.handler',\n  code: '.',\n  environment: {\n    COSMOS_CONNECTION: ref('OrdersTable', 'ConnectionString'),\n    TABLE_NAME: ref('OrdersTable', 'Name'),\n  },\n});\n\nnew Fn.Lambda(stack, 'GetOrderStatusFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/getOrderStatus.handler',\n  code: '.',\n  environment: {\n    COSMOS_CONNECTION: ref('OrdersTable', 'ConnectionString'),\n    TABLE_NAME: ref('OrdersTable', 'Name'),\n  },\n});\n\nnew Fn.Lambda(stack, 'OrderProcessorFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/orderProcessor.handler',\n  code: '.',\n  eventSources: [{ queueId: 'OrdersQueue' }],\n  environment: {\n    COSMOS_CONNECTION: ref('OrdersTable', 'ConnectionString'),\n    TABLE_NAME: ref('OrdersTable', 'Name'),\n  },\n});\n\nexport default stack;",
      "stacks/network/orders-api-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('orders-api-stack');\n\nnew Fn.ApiGateway(stack, 'OrdersApi', {\n  name: 'orders-api',\n  cors: true,\n  routes: [\n    { method: 'POST', path: '/orders', lambdaId: 'CreateOrderFn' },\n    { method: 'GET', path: '/orders', lambdaId: 'ListOrdersFn' },\n    { method: 'GET', path: '/orders/{id}', lambdaId: 'GetOrderStatusFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/createOrder.ts": "import { TableClient } from '@azure/data-tables';\nimport { ServiceBusClient } from '@azure/service-bus';\nimport { randomUUID } from 'crypto';\n\nconst tableClient = TableClient.fromConnectionString(\n  process.env.COSMOS_CONNECTION!,\n  process.env.TABLE_NAME!\n);\n\nexport async function handler(event: any) {\n  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const orderId = randomUUID();\n  const { id: _id, ...rest } = body;\n  const now = new Date().toISOString();\n\n  await tableClient.createEntity({\n    partitionKey: 'orders',\n    rowKey: orderId,\n    status: 'pending',\n    createdAt: now,\n    ...rest,\n  });\n\n  const sbClient = new ServiceBusClient(process.env.ORDERS_QUEUE_CONNECTION_STRING!);\n  const sender = sbClient.createSender(process.env.QUEUE_NAME!);\n  try {\n    await sender.sendMessages({ body: JSON.stringify({ orderId, ...rest }) });\n  } finally {\n    await sender.close();\n    await sbClient.close();\n  }\n\n  return {\n    statusCode: 201,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ id: orderId, status: 'pending', createdAt: now, ...rest }),\n  };\n}",
      "src/listOrders.ts": "import { TableClient } from '@azure/data-tables';\n\nconst tableClient = TableClient.fromConnectionString(\n  process.env.COSMOS_CONNECTION!,\n  process.env.TABLE_NAME!\n);\n\nexport async function handler() {\n  const orders: any[] = [];\n  for await (const entity of tableClient.listEntities({\n    queryOptions: { filter: \"PartitionKey eq 'orders'\" },\n  })) {\n    orders.push({ id: entity.rowKey, ...entity });\n  }\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify(orders),\n  };\n}",
      "src/getOrderStatus.ts": "import { TableClient } from '@azure/data-tables';\n\nconst tableClient = TableClient.fromConnectionString(\n  process.env.COSMOS_CONNECTION!,\n  process.env.TABLE_NAME!\n);\n\nexport async function handler(event: any) {\n  const id = event.pathParameters?.id ?? (event.path || '').split('/').filter(Boolean).pop();\n  if (!id) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'id obrigatório' }) };\n  }\n  try {\n    const entity = await tableClient.getEntity('orders', id);\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ id: entity.rowKey, ...entity }),\n    };\n  } catch {\n    return { statusCode: 404, body: JSON.stringify({ error: 'Pedido não encontrado' }) };\n  }\n}",
      "src/orderProcessor.ts": "import { TableClient } from '@azure/data-tables';\n\nconst tableClient = TableClient.fromConnectionString(\n  process.env.COSMOS_CONNECTION!,\n  process.env.TABLE_NAME!\n);\n\nexport async function handler(event: any) {\n  for (const record of event.Records ?? []) {\n    const msg = JSON.parse(record.body);\n    const { orderId } = msg;\n    if (!orderId) continue;\n\n    await tableClient.updateEntity(\n      {\n        partitionKey: 'orders',\n        rowKey: orderId,\n        status: 'processing',\n        processedAt: new Date().toISOString(),\n      },\n      'Merge'\n    );\n  }\n  return { statusCode: 200, body: '' };\n}"
    },
    "notes": [
      "npm install @azure/data-tables @azure/service-bus",
      "OrderProcessorFn consome a fila via eventSources — não abre ServiceBusReceiver no handler",
      "partitionKey fixo 'orders' e rowKey = UUID — padrão obrigatório da Cosmos Table API",
      "ref('OrdersTable','ConnectionString') e ref('OrdersQueue','ConnectionString') são objetos Ref — nunca concatenar com strings"
    ]
  },
  {
    "id": "azure-combo-01b",
    "title": "Azure: APIM + Function + Cosmos Table — confirmação de pagamento",
    "provider": "azure",
    "constructs": [
      "Messaging.Queue",
      "Database.DynamoDB",
      "Fn.Lambda",
      "Fn.ApiGateway"
    ],
    "tags": [
      "apim",
      "function",
      "cosmos-table",
      "service-bus",
      "payments",
      "async"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/payment-events-queue-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('payment-events-queue-stack');\n\nnew Messaging.Queue(stack, 'PaymentEventsQueue', {\n  visibilityTimeoutSeconds: 90,\n  messageRetentionSeconds: 345600,\n});\n\nexport default stack;",
      "stacks/database/payments-table-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('payments-table-stack');\n\nnew Database.DynamoDB(stack, 'PaymentsTable', {\n  partitionKey: 'partitionKey',\n  sortKey: 'rowKey',\n  billingMode: 'PAY_PER_REQUEST',\n});\n\nexport default stack;",
      "stacks/compute/payments-compute-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('payments-compute-stack');\n\nnew Fn.Lambda(stack, 'ConfirmPaymentFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/confirmPayment.handler',\n  code: '.',\n  environment: {\n    COSMOS_CONNECTION: ref('PaymentsTable', 'ConnectionString'),\n    TABLE_NAME: ref('PaymentsTable', 'Name'),\n    PAYMENT_EVENTS_QUEUE_CONNECTION_STRING: ref('PaymentEventsQueue', 'ConnectionString'),\n    QUEUE_NAME: 'PaymentEventsQueue',\n  },\n});\n\nnew Fn.Lambda(stack, 'ListPaymentsFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/listPayments.handler',\n  code: '.',\n  environment: {\n    COSMOS_CONNECTION: ref('PaymentsTable', 'ConnectionString'),\n    TABLE_NAME: ref('PaymentsTable', 'Name'),\n  },\n});\n\nnew Fn.Lambda(stack, 'GetPaymentStatusFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/getPaymentStatus.handler',\n  code: '.',\n  environment: {\n    COSMOS_CONNECTION: ref('PaymentsTable', 'ConnectionString'),\n    TABLE_NAME: ref('PaymentsTable', 'Name'),\n  },\n});\n\nnew Fn.Lambda(stack, 'PaymentProcessorFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/paymentProcessor.handler',\n  code: '.',\n  eventSources: [{ queueId: 'PaymentEventsQueue' }],\n  environment: {\n    COSMOS_CONNECTION: ref('PaymentsTable', 'ConnectionString'),\n    TABLE_NAME: ref('PaymentsTable', 'Name'),\n  },\n});\n\nexport default stack;",
      "stacks/network/payments-api-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('payments-api-stack');\n\nnew Fn.ApiGateway(stack, 'PaymentsApi', {\n  name: 'payments-api',\n  cors: true,\n  routes: [\n    { method: 'POST', path: '/payments', lambdaId: 'ConfirmPaymentFn' },\n    { method: 'GET', path: '/payments', lambdaId: 'ListPaymentsFn' },\n    { method: 'GET', path: '/payments/{id}', lambdaId: 'GetPaymentStatusFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/confirmPayment.ts": "import { TableClient } from '@azure/data-tables';\nimport { ServiceBusClient } from '@azure/service-bus';\nimport { randomUUID } from 'crypto';\n\nconst tableClient = TableClient.fromConnectionString(\n  process.env.COSMOS_CONNECTION!,\n  process.env.TABLE_NAME!\n);\n\nexport async function handler(event: any) {\n  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const paymentId = randomUUID();\n  const { id: _id, ...rest } = body;\n  const now = new Date().toISOString();\n\n  await tableClient.createEntity({\n    partitionKey: 'payments',\n    rowKey: paymentId,\n    status: 'pending_confirmation',\n    createdAt: now,\n    ...rest,\n  });\n\n  const sbClient = new ServiceBusClient(process.env.PAYMENT_EVENTS_QUEUE_CONNECTION_STRING!);\n  const sender = sbClient.createSender(process.env.QUEUE_NAME!);\n  try {\n    await sender.sendMessages({\n      body: JSON.stringify({ paymentId, orderId: rest.orderId, amount: rest.amount }),\n    });\n  } finally {\n    await sender.close();\n    await sbClient.close();\n  }\n\n  return {\n    statusCode: 201,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ id: paymentId, status: 'pending_confirmation', createdAt: now, ...rest }),\n  };\n}",
      "src/listPayments.ts": "import { TableClient } from '@azure/data-tables';\n\nconst tableClient = TableClient.fromConnectionString(\n  process.env.COSMOS_CONNECTION!,\n  process.env.TABLE_NAME!\n);\n\nexport async function handler() {\n  const payments: any[] = [];\n  for await (const entity of tableClient.listEntities({\n    queryOptions: { filter: \"PartitionKey eq 'payments'\" },\n  })) {\n    payments.push({ id: entity.rowKey, ...entity });\n  }\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify(payments),\n  };\n}",
      "src/getPaymentStatus.ts": "import { TableClient } from '@azure/data-tables';\n\nconst tableClient = TableClient.fromConnectionString(\n  process.env.COSMOS_CONNECTION!,\n  process.env.TABLE_NAME!\n);\n\nexport async function handler(event: any) {\n  const id = event.pathParameters?.id ?? (event.path || '').split('/').filter(Boolean).pop();\n  if (!id) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'id obrigatório' }) };\n  }\n  try {\n    const entity = await tableClient.getEntity('payments', id);\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ id: entity.rowKey, ...entity }),\n    };\n  } catch {\n    return { statusCode: 404, body: JSON.stringify({ error: 'Pagamento não encontrado' }) };\n  }\n}",
      "src/paymentProcessor.ts": "import { TableClient } from '@azure/data-tables';\n\nconst tableClient = TableClient.fromConnectionString(\n  process.env.COSMOS_CONNECTION!,\n  process.env.TABLE_NAME!\n);\n\nexport async function handler(event: any) {\n  for (const record of event.Records ?? []) {\n    const msg = JSON.parse(record.body);\n    const { paymentId, amount } = msg;\n    if (!paymentId) continue;\n\n    const isApproved = typeof amount === 'number' && amount > 0;\n\n    await tableClient.updateEntity(\n      {\n        partitionKey: 'payments',\n        rowKey: paymentId,\n        status: isApproved ? 'confirmed' : 'rejected',\n        processedAt: new Date().toISOString(),\n      },\n      'Merge'\n    );\n  }\n  return { statusCode: 200, body: '' };\n}"
    },
    "notes": [
      "npm install @azure/data-tables @azure/service-bus",
      "PaymentProcessorFn consome a fila via eventSources — não abre ServiceBusReceiver no handler",
      "status evolui: pending_confirmation → confirmed | rejected após processamento assíncrono",
      "ref('PaymentsTable','ConnectionString') e ref('PaymentEventsQueue','ConnectionString') são objetos Ref — nunca concatenar"
    ]
  },
  {
    "id": "azure-combo-01c",
    "title": "Azure: APIM + Function + Cosmos Table + Queue — notificação assíncrona",
    "provider": "azure",
    "constructs": [
      "Messaging.Queue",
      "Database.DynamoDB",
      "Fn.Lambda",
      "Fn.ApiGateway"
    ],
    "tags": [
      "apim",
      "function",
      "cosmos-table",
      "service-bus",
      "notifications",
      "async"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/notifications-queue-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('notifications-queue-stack');\n\nnew Messaging.Queue(stack, 'NotificationsQueue', {\n  visibilityTimeoutSeconds: 30,\n  messageRetentionSeconds: 172800,\n});\n\nexport default stack;",
      "stacks/database/notifications-table-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('notifications-table-stack');\n\nnew Database.DynamoDB(stack, 'NotificationsTable', {\n  partitionKey: 'partitionKey',\n  sortKey: 'rowKey',\n  billingMode: 'PAY_PER_REQUEST',\n});\n\nexport default stack;",
      "stacks/compute/notifications-compute-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('notifications-compute-stack');\n\nnew Fn.Lambda(stack, 'CreateNotificationFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/createNotification.handler',\n  code: '.',\n  environment: {\n    COSMOS_CONNECTION: ref('NotificationsTable', 'ConnectionString'),\n    TABLE_NAME: ref('NotificationsTable', 'Name'),\n    NOTIFICATIONS_QUEUE_CONNECTION_STRING: ref('NotificationsQueue', 'ConnectionString'),\n    QUEUE_NAME: 'NotificationsQueue',\n  },\n});\n\nnew Fn.Lambda(stack, 'ListNotificationsFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/listNotifications.handler',\n  code: '.',\n  environment: {\n    COSMOS_CONNECTION: ref('NotificationsTable', 'ConnectionString'),\n    TABLE_NAME: ref('NotificationsTable', 'Name'),\n  },\n});\n\nnew Fn.Lambda(stack, 'NotificationSenderFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/notificationSender.handler',\n  code: '.',\n  eventSources: [{ queueId: 'NotificationsQueue' }],\n  environment: {\n    COSMOS_CONNECTION: ref('NotificationsTable', 'ConnectionString'),\n    TABLE_NAME: ref('NotificationsTable', 'Name'),\n  },\n});\n\nexport default stack;",
      "stacks/network/notifications-api-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('notifications-api-stack');\n\nnew Fn.ApiGateway(stack, 'NotificationsApi', {\n  name: 'notifications-api',\n  cors: true,\n  routes: [\n    { method: 'POST', path: '/notifications', lambdaId: 'CreateNotificationFn' },\n    { method: 'GET', path: '/notifications', lambdaId: 'ListNotificationsFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/createNotification.ts": "import { TableClient } from '@azure/data-tables';\nimport { ServiceBusClient } from '@azure/service-bus';\nimport { randomUUID } from 'crypto';\n\nconst tableClient = TableClient.fromConnectionString(\n  process.env.COSMOS_CONNECTION!,\n  process.env.TABLE_NAME!\n);\n\nexport async function handler(event: any) {\n  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const notificationId = randomUUID();\n  const { id: _id, ...rest } = body;\n  const now = new Date().toISOString();\n\n  await tableClient.createEntity({\n    partitionKey: 'notifications',\n    rowKey: notificationId,\n    status: 'queued',\n    createdAt: now,\n    ...rest,\n  });\n\n  const sbClient = new ServiceBusClient(process.env.NOTIFICATIONS_QUEUE_CONNECTION_STRING!);\n  const sender = sbClient.createSender(process.env.QUEUE_NAME!);\n  try {\n    await sender.sendMessages({\n      body: JSON.stringify({\n        notificationId,\n        recipient: rest.recipient,\n        channel: rest.channel,\n        message: rest.message,\n      }),\n    });\n  } finally {\n    await sender.close();\n    await sbClient.close();\n  }\n\n  return {\n    statusCode: 201,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ id: notificationId, status: 'queued', createdAt: now, ...rest }),\n  };\n}",
      "src/listNotifications.ts": "import { TableClient } from '@azure/data-tables';\n\nconst tableClient = TableClient.fromConnectionString(\n  process.env.COSMOS_CONNECTION!,\n  process.env.TABLE_NAME!\n);\n\nexport async function handler() {\n  const notifications: any[] = [];\n  for await (const entity of tableClient.listEntities({\n    queryOptions: { filter: \"PartitionKey eq 'notifications'\" },\n  })) {\n    notifications.push({ id: entity.rowKey, ...entity });\n  }\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify(notifications),\n  };\n}",
      "src/notificationSender.ts": "import { TableClient } from '@azure/data-tables';\n\nconst tableClient = TableClient.fromConnectionString(\n  process.env.COSMOS_CONNECTION!,\n  process.env.TABLE_NAME!\n);\n\nexport async function handler(event: any) {\n  for (const record of event.Records ?? []) {\n    const msg = JSON.parse(record.body);\n    const { notificationId, recipient, channel, message } = msg;\n    if (!notificationId) continue;\n\n    console.log(`[${channel}] -> ${recipient}: ${message}`);\n\n    await tableClient.updateEntity(\n      {\n        partitionKey: 'notifications',\n        rowKey: notificationId,\n        status: 'sent',\n        sentAt: new Date().toISOString(),\n      },\n      'Merge'\n    );\n  }\n  return { statusCode: 200, body: '' };\n}"
    },
    "notes": [
      "npm install @azure/data-tables @azure/service-bus",
      "NotificationSenderFn consome a fila via eventSources — não abre ServiceBusReceiver no handler",
      "channel aceita qualquer valor (email, sms, push) — lógica de envio real vai no console.log substituído pelo SDK do canal",
      "status evolui: queued → sent após entrega assíncrona pelo NotificationSenderFn"
    ]
  },
  {
    "id": "azure-combo-02",
    "title": "Azure: Blob + Event Grid + Function + PostgreSQL — pipeline de documentos",
    "provider": "azure",
    "constructs": [
      "Storage.Bucket",
      "Fn.Lambda",
      "Database.SQL"
    ],
    "tags": [
      "azure",
      "blob",
      "event-grid",
      "container-app",
      "postgresql",
      "pipeline",
      "documentos"
    ],
    "validated": false,
    "stacks": {
      "stacks/database/database-stack.ts": "import { Stack, Database } from '@iacmp/core';\nconst stack = new Stack('database-stack');\nnew Database.SQL(stack, 'DocsDB', {\n  engine: 'postgres',\n  instanceType: 'small',\n  deletionProtection: false,\n});\nexport default stack;",
      "stacks/pipeline/pipeline-stack.ts": "import { Stack, Storage, Fn, ref } from '@iacmp/core';\nconst stack = new Stack('pipeline-stack');\n\nnew Fn.Lambda(stack, 'DocumentProcessorFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/documentProcessor.handler',\n  code: '.',\n  timeout: 60,\n  memory: 256,\n  environment: {\n    DB_HOST: ref('DocsDB', 'Endpoint'),\n    DB_PORT: ref('DocsDB', 'Port'),\n    DB_USER: ref('DocsDB', 'Username'),\n    DB_PASSWORD: ref('DocsDB', 'Password'),\n    DB_NAME: 'postgres',\n  },\n});\n\nnew Storage.Bucket(stack, 'UploadsBucket', {\n  eventNotifications: [{ lambdaId: 'DocumentProcessorFn', events: ['s3:ObjectCreated:*'] }],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/documentProcessor.ts": "import { Client } from 'pg';\n\nexport async function handler(event: any) {\n  const records = event.Records || [];\n\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS documents (\n      id SERIAL PRIMARY KEY,\n      blob_name TEXT NOT NULL,\n      container_name TEXT NOT NULL,\n      size_bytes BIGINT,\n      content_type TEXT,\n      processed_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n\n  for (const record of records) {\n    const blobName = record.s3.object.key;\n    const containerName = record.s3.bucket.name;\n    const sizeBytes = record.s3.object.size ?? 0;\n\n    const ext = blobName.split('.').pop()?.toLowerCase() ?? '';\n    const contentType =\n      ext === 'pdf' ? 'application/pdf'\n      : ext === 'json' ? 'application/json'\n      : ext === 'csv' ? 'text/csv'\n      : 'application/octet-stream';\n\n    await db.query(\n      'INSERT INTO documents (blob_name, container_name, size_bytes, content_type) VALUES ($1, $2, $3, $4)',\n      [blobName, containerName, sizeBytes, contentType]\n    );\n  }\n\n  await db.end();\n  return { statusCode: 200, body: '' };\n}"
    },
    "notes": [
      "Storage.Bucket com eventNotifications e Fn.Lambda DEVEM ficar na mesma stack (pipeline-stack) para evitar dependência circular cross-stack com Event Grid.",
      "O handler usa record.s3.object.key e record.s3.bucket.name — o runtime Azure converte o payload Event Grid para o formato S3.",
      "DB_NAME: 'postgres' — o Flexible Server cria apenas o banco 'postgres' por padrão; nunca use o nome da aplicação.",
      "CREATE TABLE IF NOT EXISTS é obrigatório em todos os handlers SQL no cold start.",
      "ssl: { rejectUnauthorized: false } é obrigatório — o Azure Flexible Server exige TLS."
    ]
  },
  {
    "id": "azure-combo-02b",
    "title": "Azure: Blob + Event Grid + Function + PostgreSQL — validação de CSV",
    "provider": "azure",
    "constructs": [
      "Storage.Bucket",
      "Fn.Lambda",
      "Database.SQL"
    ],
    "tags": [
      "azure",
      "blob",
      "event-grid",
      "container-app",
      "postgresql",
      "csv",
      "validacao",
      "pipeline"
    ],
    "validated": false,
    "stacks": {
      "stacks/database/database-stack.ts": "import { Stack, Database } from '@iacmp/core';\nconst stack = new Stack('database-stack');\nnew Database.SQL(stack, 'CsvDB', {\n  engine: 'postgres',\n  instanceType: 'small',\n  deletionProtection: false,\n});\nexport default stack;",
      "stacks/pipeline/pipeline-stack.ts": "import { Stack, Storage, Fn, ref } from '@iacmp/core';\nconst stack = new Stack('pipeline-stack');\n\nnew Fn.Lambda(stack, 'CsvValidatorFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/csvValidator.handler',\n  code: '.',\n  timeout: 120,\n  memory: 512,\n  environment: {\n    DB_HOST: ref('CsvDB', 'Endpoint'),\n    DB_PORT: ref('CsvDB', 'Port'),\n    DB_USER: ref('CsvDB', 'Username'),\n    DB_PASSWORD: ref('CsvDB', 'Password'),\n    DB_NAME: 'postgres',\n    BLOB_CONNECTION: ref('CsvUploadsBucket', 'ConnectionString'),\n  },\n});\n\nnew Storage.Bucket(stack, 'CsvUploadsBucket', {\n  eventNotifications: [{ lambdaId: 'CsvValidatorFn', events: ['s3:ObjectCreated:*'], suffix: '.csv' }],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/csvValidator.ts": "import { BlobServiceClient } from '@azure/storage-blob';\nimport { Client } from 'pg';\n\nfunction parseCsv(content: string): { headers: string[]; rows: Record<string, string>[] } {\n  const lines = content.trim().split('\\n');\n  const headers = lines[0].split(',').map(h => h.trim());\n  const rows = lines.slice(1).map(line => {\n    const values = line.split(',').map(v => v.trim());\n    return headers.reduce((obj, h, i) => ({ ...obj, [h]: values[i] ?? '' }), {} as Record<string, string>);\n  });\n  return { headers, rows };\n}\n\nexport async function handler(event: any) {\n  const records = event.Records || [];\n\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS csv_validations (\n      id SERIAL PRIMARY KEY,\n      file_name TEXT NOT NULL,\n      total_rows INTEGER NOT NULL,\n      valid_rows INTEGER NOT NULL,\n      invalid_rows INTEGER NOT NULL,\n      errors JSONB,\n      validated_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n\n  for (const record of records) {\n    const blobName = record.s3.object.key;\n    const containerName = record.s3.bucket.name;\n\n    const blobSvc = BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION!);\n    const container = blobSvc.getContainerClient(containerName);\n    const blob = container.getBlockBlobClient(blobName);\n    const buffer = await blob.downloadToBuffer();\n    const content = buffer.toString('utf-8');\n\n    const { headers, rows } = parseCsv(content);\n    const errors: { row: number; reason: string }[] = [];\n    let validRows = 0;\n\n    rows.forEach((row, idx) => {\n      const missing = headers.filter(h => !row[h] || row[h].trim() === '');\n      if (missing.length > 0) {\n        errors.push({ row: idx + 2, reason: `Campos obrigatórios ausentes: ${missing.join(', ')}` });\n      } else {\n        validRows++;\n      }\n    });\n\n    await db.query(\n      `INSERT INTO csv_validations (file_name, total_rows, valid_rows, invalid_rows, errors)\n       VALUES ($1, $2, $3, $4, $5)`,\n      [blobName, rows.length, validRows, errors.length, JSON.stringify(errors)]\n    );\n  }\n\n  await db.end();\n  return { statusCode: 200, body: '' };\n}"
    },
    "notes": [
      "BLOB_CONNECTION: ref('CsvUploadsBucket', 'ConnectionString') é necessário pois o handler faz download do conteúdo do blob para validar o CSV.",
      "O trigger usa suffix: '.csv' — Event Grid entrega apenas eventos de blobs com extensão .csv.",
      "Storage.Bucket com eventNotifications e Fn.Lambda na mesma stack (pipeline-stack) — regra anti-ciclo cross-stack.",
      "O handler usa record.s3.object.key e record.s3.bucket.name do payload Event Grid convertido para formato S3.",
      "CREATE TABLE IF NOT EXISTS csv_validations no cold start — NUNCA omita nos handlers SQL do Azure."
    ]
  },
  {
    "id": "azure-combo-02c",
    "title": "Azure: Blob + Event Grid + Function + PostgreSQL — indexação de PDFs",
    "provider": "azure",
    "constructs": [
      "Storage.Bucket",
      "Fn.Lambda",
      "Database.SQL"
    ],
    "tags": [
      "azure",
      "blob",
      "event-grid",
      "container-app",
      "postgresql",
      "pdf",
      "indexacao",
      "pipeline"
    ],
    "validated": false,
    "stacks": {
      "stacks/database/database-stack.ts": "import { Stack, Database } from '@iacmp/core';\nconst stack = new Stack('database-stack');\nnew Database.SQL(stack, 'PdfDB', {\n  engine: 'postgres',\n  instanceType: 'small',\n  deletionProtection: false,\n});\nexport default stack;",
      "stacks/pipeline/pipeline-stack.ts": "import { Stack, Storage, Fn, ref } from '@iacmp/core';\nconst stack = new Stack('pipeline-stack');\n\nnew Fn.Lambda(stack, 'PdfIndexerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/pdfIndexer.handler',\n  code: '.',\n  timeout: 120,\n  memory: 512,\n  environment: {\n    DB_HOST: ref('PdfDB', 'Endpoint'),\n    DB_PORT: ref('PdfDB', 'Port'),\n    DB_USER: ref('PdfDB', 'Username'),\n    DB_PASSWORD: ref('PdfDB', 'Password'),\n    DB_NAME: 'postgres',\n    BLOB_CONNECTION: ref('PdfUploadsBucket', 'ConnectionString'),\n  },\n});\n\nnew Storage.Bucket(stack, 'PdfUploadsBucket', {\n  eventNotifications: [{ lambdaId: 'PdfIndexerFn', events: ['s3:ObjectCreated:*'], suffix: '.pdf' }],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/pdfIndexer.ts": "import { BlobServiceClient } from '@azure/storage-blob';\nimport { Client } from 'pg';\n\nfunction extractPdfMetadata(buffer: Buffer): { pageCount: number; sizeBytes: number; hasText: boolean } {\n  const content = buffer.toString('latin1');\n  const pageMatches = content.match(/\\/Type\\s*\\/Page[^s]/g) || [];\n  const hasText = content.includes('/Font') || content.includes('BT ');\n  return {\n    pageCount: pageMatches.length || 1,\n    sizeBytes: buffer.length,\n    hasText,\n  };\n}\n\nexport async function handler(event: any) {\n  const records = event.Records || [];\n\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS pdf_index (\n      id SERIAL PRIMARY KEY,\n      file_name TEXT NOT NULL,\n      container_name TEXT NOT NULL,\n      size_bytes BIGINT NOT NULL,\n      page_count INTEGER NOT NULL,\n      has_text BOOLEAN NOT NULL,\n      indexed_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n\n  for (const record of records) {\n    const blobName = record.s3.object.key;\n    const containerName = record.s3.bucket.name;\n\n    const blobSvc = BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION!);\n    const container = blobSvc.getContainerClient(containerName);\n    const blob = container.getBlockBlobClient(blobName);\n    const buffer = await blob.downloadToBuffer();\n\n    const { pageCount, sizeBytes, hasText } = extractPdfMetadata(buffer);\n\n    await db.query(\n      `INSERT INTO pdf_index (file_name, container_name, size_bytes, page_count, has_text)\n       VALUES ($1, $2, $3, $4, $5)`,\n      [blobName, containerName, sizeBytes, pageCount, hasText]\n    );\n  }\n\n  await db.end();\n  return { statusCode: 200, body: '' };\n}"
    },
    "notes": [
      "BLOB_CONNECTION: ref('PdfUploadsBucket', 'ConnectionString') é necessário pois o handler faz download do binário do PDF para extrair metadados.",
      "O trigger usa suffix: '.pdf' — Event Grid entrega apenas eventos de blobs com extensão .pdf.",
      "extractPdfMetadata usa parseamento de baixo nível do PDF (sem dependência externa) para evitar binários pesados no Container App.",
      "Storage.Bucket com eventNotifications e Fn.Lambda na mesma stack (pipeline-stack) — regra anti-ciclo cross-stack.",
      "DB_NAME: 'postgres' — nunca use o nome da aplicação como banco no Flexible Server Azure."
    ]
  },
  {
    "id": "azure-combo-03",
    "title": "Azure: APIM + Function + Redis + PostgreSQL — catálogo com cache",
    "provider": "azure",
    "constructs": [
      "Fn.ApiGateway",
      "Fn.Lambda",
      "Cache.Redis",
      "Database.SQL"
    ],
    "tags": [
      "azure",
      "apim",
      "redis",
      "postgres",
      "cache-aside",
      "catalog"
    ],
    "validated": false,
    "stacks": {
      "stacks/infra-stack.ts": "import { Stack, Database, Cache } from '@iacmp/core';\n\nconst stack = new Stack('infra-stack');\n\nnew Database.SQL(stack, 'CatalogDB', {\n  engine: 'postgres',\n  instanceType: 'small',\n  storageGb: 20,\n});\n\nnew Cache.Redis(stack, 'CatalogCache', {\n  nodeType: 'small',\n  numCacheNodes: 1,\n});\n\nexport default stack;",
      "stacks/api-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('api-stack');\n\nnew Fn.Lambda(stack, 'GetProductsFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/getProducts.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  environment: {\n    DB_HOST: ref('CatalogDB', 'Endpoint'),\n    DB_PORT: ref('CatalogDB', 'Port'),\n    DB_USER: ref('CatalogDB', 'Username'),\n    DB_PASSWORD: ref('CatalogDB', 'Password'),\n    DB_NAME: 'postgres',\n    REDIS_CONNECTION_STRING: ref('CatalogCache', 'ConnectionString'),\n  },\n});\n\nnew Fn.Lambda(stack, 'CreateProductFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/createProduct.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  environment: {\n    DB_HOST: ref('CatalogDB', 'Endpoint'),\n    DB_PORT: ref('CatalogDB', 'Port'),\n    DB_USER: ref('CatalogDB', 'Username'),\n    DB_PASSWORD: ref('CatalogDB', 'Password'),\n    DB_NAME: 'postgres',\n    REDIS_CONNECTION_STRING: ref('CatalogCache', 'ConnectionString'),\n  },\n});\n\nnew Fn.ApiGateway(stack, 'CatalogApi', {\n  name: 'catalog-api',\n  type: 'HTTP',\n  cors: true,\n  routes: [\n    { method: 'GET', path: '/products', lambdaId: 'GetProductsFn' },\n    { method: 'POST', path: '/products', lambdaId: 'CreateProductFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/getProducts.ts": "import { Client } from 'pg';\nimport Redis from 'ioredis';\n\nconst redis = new Redis(process.env.REDIS_CONNECTION_STRING!);\nconst CACHE_KEY = 'products:all';\nconst CACHE_TTL = 60;\n\nexport async function handler(event: any) {\n  const cached = await redis.get(CACHE_KEY);\n  if (cached) {\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },\n      body: cached,\n    };\n  }\n\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS products (\n      id SERIAL PRIMARY KEY,\n      name TEXT NOT NULL,\n      description TEXT,\n      price NUMERIC(10,2) NOT NULL,\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n  const result = await db.query('SELECT * FROM products ORDER BY id');\n  await db.end();\n\n  const body = JSON.stringify(result.rows);\n  await redis.set(CACHE_KEY, body, 'EX', CACHE_TTL);\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },\n    body,\n  };\n}",
      "src/createProduct.ts": "import { Client } from 'pg';\nimport Redis from 'ioredis';\n\nconst redis = new Redis(process.env.REDIS_CONNECTION_STRING!);\nconst CACHE_KEY = 'products:all';\n\nexport async function handler(event: any) {\n  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const { name, description, price } = body;\n  if (!name || price == null) {\n    return {\n      statusCode: 400,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'name e price são obrigatórios' }),\n    };\n  }\n\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS products (\n      id SERIAL PRIMARY KEY,\n      name TEXT NOT NULL,\n      description TEXT,\n      price NUMERIC(10,2) NOT NULL,\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n  const result = await db.query(\n    'INSERT INTO products (name, description, price) VALUES ($1, $2, $3) RETURNING *',\n    [name, description ?? null, price]\n  );\n  await db.end();\n\n  await redis.del(CACHE_KEY);\n\n  return {\n    statusCode: 201,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify(result.rows[0]),\n  };\n}"
    },
    "notes": [
      "Cache-aside: GET lê do Redis primeiro (HIT), fallback PostgreSQL + popula cache (MISS); POST escreve no PG e invalida a chave 'products:all'.",
      "REDIS_CONNECTION_STRING recebe ref() direto — URL rediss:// do Redis Enterprise inclui TLS e auth; não use split/password=.",
      "CREATE TABLE IF NOT EXISTS em todos os handlers — cold start antes de qualquer SELECT/INSERT evita 'relation does not exist'.",
      "npm install: pg ioredis @types/pg"
    ]
  },
  {
    "id": "azure-combo-03b",
    "title": "Azure: APIM + Function + Redis + PostgreSQL — sessão de usuário + histórico",
    "provider": "azure",
    "constructs": [
      "Fn.ApiGateway",
      "Fn.Lambda",
      "Cache.Redis",
      "Database.SQL"
    ],
    "tags": [
      "azure",
      "apim",
      "redis",
      "postgres",
      "session",
      "history"
    ],
    "validated": false,
    "stacks": {
      "stacks/infra-stack.ts": "import { Stack, Database, Cache } from '@iacmp/core';\n\nconst stack = new Stack('infra-stack');\n\nnew Database.SQL(stack, 'SessionDB', {\n  engine: 'postgres',\n  instanceType: 'small',\n  storageGb: 20,\n});\n\nnew Cache.Redis(stack, 'SessionCache', {\n  nodeType: 'small',\n  numCacheNodes: 1,\n});\n\nexport default stack;",
      "stacks/api-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('api-stack');\n\nconst envCommon = {\n  DB_HOST: ref('SessionDB', 'Endpoint'),\n  DB_PORT: ref('SessionDB', 'Port'),\n  DB_USER: ref('SessionDB', 'Username'),\n  DB_PASSWORD: ref('SessionDB', 'Password'),\n  DB_NAME: 'postgres',\n  REDIS_CONNECTION_STRING: ref('SessionCache', 'ConnectionString'),\n  SESSION_TTL: '3600',\n};\n\nnew Fn.Lambda(stack, 'CreateSessionFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/createSession.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  environment: envCommon,\n});\n\nnew Fn.Lambda(stack, 'GetSessionFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/getSession.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  environment: envCommon,\n});\n\nnew Fn.Lambda(stack, 'GetHistoryFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/getHistory.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  environment: envCommon,\n});\n\nnew Fn.ApiGateway(stack, 'SessionApi', {\n  name: 'session-api',\n  type: 'HTTP',\n  cors: true,\n  routes: [\n    { method: 'POST', path: '/sessions', lambdaId: 'CreateSessionFn' },\n    { method: 'GET', path: '/sessions/{sessionId}', lambdaId: 'GetSessionFn' },\n    { method: 'GET', path: '/history/{userId}', lambdaId: 'GetHistoryFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/createSession.ts": "import { Client } from 'pg';\nimport Redis from 'ioredis';\nimport { randomUUID } from 'crypto';\n\nconst redis = new Redis(process.env.REDIS_CONNECTION_STRING!);\n\nasync function getDb() {\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS session_history (\n      id SERIAL PRIMARY KEY,\n      session_id TEXT NOT NULL,\n      user_id TEXT NOT NULL,\n      data JSONB,\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n  return db;\n}\n\nexport async function handler(event: any) {\n  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const { userId, data } = body;\n  if (!userId) {\n    return {\n      statusCode: 400,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'userId é obrigatório' }),\n    };\n  }\n\n  const sessionId = randomUUID();\n  const ttl = Number(process.env.SESSION_TTL ?? 3600);\n  const sessionData = { sessionId, userId, data: data ?? {}, createdAt: new Date().toISOString() };\n\n  await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), 'EX', ttl);\n\n  const db = await getDb();\n  await db.query(\n    'INSERT INTO session_history (session_id, user_id, data) VALUES ($1, $2, $3)',\n    [sessionId, userId, JSON.stringify(data ?? {})]\n  );\n  await db.end();\n\n  return {\n    statusCode: 201,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ sessionId, expiresIn: ttl }),\n  };\n}",
      "src/getSession.ts": "import { Client } from 'pg';\nimport Redis from 'ioredis';\n\nconst redis = new Redis(process.env.REDIS_CONNECTION_STRING!);\n\nexport async function handler(event: any) {\n  const sessionId = (event.pathParameters?.sessionId) ?? (event.path || '').split('/').filter(Boolean).pop();\n  if (!sessionId) {\n    return {\n      statusCode: 400,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'sessionId é obrigatório' }),\n    };\n  }\n\n  const cached = await redis.get(`session:${sessionId}`);\n  if (cached) {\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },\n      body: cached,\n    };\n  }\n\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS session_history (\n      id SERIAL PRIMARY KEY,\n      session_id TEXT NOT NULL,\n      user_id TEXT NOT NULL,\n      data JSONB,\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n  const result = await db.query(\n    'SELECT * FROM session_history WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1',\n    [sessionId]\n  );\n  await db.end();\n\n  if (!result.rows.length) {\n    return {\n      statusCode: 404,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'Sessão não encontrada' }),\n    };\n  }\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },\n    body: JSON.stringify(result.rows[0]),\n  };\n}",
      "src/getHistory.ts": "import { Client } from 'pg';\nimport Redis from 'ioredis';\n\nconst redis = new Redis(process.env.REDIS_CONNECTION_STRING!);\n\nexport async function handler(event: any) {\n  const userId = (event.pathParameters?.userId) ?? (event.path || '').split('/').filter(Boolean).pop();\n  if (!userId) {\n    return {\n      statusCode: 400,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'userId é obrigatório' }),\n    };\n  }\n\n  const cacheKey = `history:${userId}`;\n  const cached = await redis.get(cacheKey);\n  if (cached) {\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },\n      body: cached,\n    };\n  }\n\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS session_history (\n      id SERIAL PRIMARY KEY,\n      session_id TEXT NOT NULL,\n      user_id TEXT NOT NULL,\n      data JSONB,\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n  const result = await db.query(\n    'SELECT session_id, data, created_at FROM session_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',\n    [userId]\n  );\n  await db.end();\n\n  const body = JSON.stringify(result.rows);\n  await redis.set(cacheKey, body, 'EX', 300);\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },\n    body,\n  };\n}"
    },
    "notes": [
      "Sessão criada no Redis com TTL configurável via SESSION_TTL (default 3600s); histórico persistido no PostgreSQL para consulta após expiração.",
      "getSession: Redis HIT retorna sessão ativa; MISS fallback para PG (sessão expirada ou para auditoria).",
      "getHistory: cacheia os últimos 50 registros do usuário por 5 minutos no Redis (chave 'history:{userId}').",
      "npm install: pg ioredis @types/pg"
    ]
  },
  {
    "id": "azure-combo-03c",
    "title": "Azure: APIM + Function + Redis + PostgreSQL — rate-limit por usuário + produto",
    "provider": "azure",
    "constructs": [
      "Fn.ApiGateway",
      "Fn.Lambda",
      "Cache.Redis",
      "Database.SQL"
    ],
    "tags": [
      "azure",
      "apim",
      "redis",
      "postgres",
      "rate-limit",
      "throttle"
    ],
    "validated": false,
    "stacks": {
      "stacks/infra-stack.ts": "import { Stack, Database, Cache } from '@iacmp/core';\n\nconst stack = new Stack('infra-stack');\n\nnew Database.SQL(stack, 'StoreDB', {\n  engine: 'postgres',\n  instanceType: 'small',\n  storageGb: 20,\n});\n\nnew Cache.Redis(stack, 'RateLimitCache', {\n  nodeType: 'small',\n  numCacheNodes: 1,\n});\n\nexport default stack;",
      "stacks/api-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('api-stack');\n\nconst envCommon = {\n  DB_HOST: ref('StoreDB', 'Endpoint'),\n  DB_PORT: ref('StoreDB', 'Port'),\n  DB_USER: ref('StoreDB', 'Username'),\n  DB_PASSWORD: ref('StoreDB', 'Password'),\n  DB_NAME: 'postgres',\n  REDIS_CONNECTION_STRING: ref('RateLimitCache', 'ConnectionString'),\n  RATE_LIMIT_MAX: '10',\n  RATE_LIMIT_WINDOW_SEC: '60',\n};\n\nnew Fn.Lambda(stack, 'GetProductFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/getProduct.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  environment: envCommon,\n});\n\nnew Fn.Lambda(stack, 'CreateOrderFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/createOrder.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  environment: envCommon,\n});\n\nnew Fn.ApiGateway(stack, 'StoreApi', {\n  name: 'store-api',\n  type: 'HTTP',\n  cors: true,\n  routes: [\n    { method: 'GET', path: '/products/{productId}', lambdaId: 'GetProductFn' },\n    { method: 'POST', path: '/orders', lambdaId: 'CreateOrderFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/getProduct.ts": "import { Client } from 'pg';\nimport Redis from 'ioredis';\n\nconst redis = new Redis(process.env.REDIS_CONNECTION_STRING!);\n\nasync function checkRateLimit(userId: string, key: string): Promise<boolean> {\n  const max = Number(process.env.RATE_LIMIT_MAX ?? 10);\n  const window = Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 60);\n  const rateLimitKey = `rl:${userId}:${key}`;\n  const current = await redis.incr(rateLimitKey);\n  if (current === 1) {\n    await redis.expire(rateLimitKey, window);\n  }\n  return current <= max;\n}\n\nexport async function handler(event: any) {\n  const productId = (event.pathParameters?.productId) ?? (event.path || '').split('/').filter(Boolean).pop();\n  const userId = (event.headers?.['x-user-id']) ?? (event.headers?.['X-User-Id']) ?? 'anonymous';\n\n  if (!productId) {\n    return {\n      statusCode: 400,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'productId é obrigatório' }),\n    };\n  }\n\n  const allowed = await checkRateLimit(userId, `product:${productId}`);\n  if (!allowed) {\n    return {\n      statusCode: 429,\n      headers: {\n        'Content-Type': 'application/json',\n        'Retry-After': String(process.env.RATE_LIMIT_WINDOW_SEC ?? 60),\n      },\n      body: JSON.stringify({ error: 'Rate limit excedido. Tente novamente em breve.' }),\n    };\n  }\n\n  const cacheKey = `product:${productId}`;\n  const cached = await redis.get(cacheKey);\n  if (cached) {\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },\n      body: cached,\n    };\n  }\n\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS products (\n      id SERIAL PRIMARY KEY,\n      name TEXT NOT NULL,\n      description TEXT,\n      price NUMERIC(10,2) NOT NULL,\n      stock INTEGER NOT NULL DEFAULT 0,\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n  const result = await db.query('SELECT * FROM products WHERE id = $1', [productId]);\n  await db.end();\n\n  if (!result.rows.length) {\n    return {\n      statusCode: 404,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'Produto não encontrado' }),\n    };\n  }\n\n  const body = JSON.stringify(result.rows[0]);\n  await redis.set(cacheKey, body, 'EX', 300);\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },\n    body,\n  };\n}",
      "src/createOrder.ts": "import { Client } from 'pg';\nimport Redis from 'ioredis';\n\nconst redis = new Redis(process.env.REDIS_CONNECTION_STRING!);\n\nasync function checkRateLimit(userId: string, action: string): Promise<boolean> {\n  const max = Number(process.env.RATE_LIMIT_MAX ?? 10);\n  const window = Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 60);\n  const rateLimitKey = `rl:${userId}:${action}`;\n  const current = await redis.incr(rateLimitKey);\n  if (current === 1) {\n    await redis.expire(rateLimitKey, window);\n  }\n  return current <= max;\n}\n\nexport async function handler(event: any) {\n  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const { userId, productId, quantity } = body;\n\n  if (!userId || !productId || !quantity) {\n    return {\n      statusCode: 400,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'userId, productId e quantity são obrigatórios' }),\n    };\n  }\n\n  const allowed = await checkRateLimit(userId, `order:${productId}`);\n  if (!allowed) {\n    return {\n      statusCode: 429,\n      headers: {\n        'Content-Type': 'application/json',\n        'Retry-After': String(process.env.RATE_LIMIT_WINDOW_SEC ?? 60),\n      },\n      body: JSON.stringify({ error: 'Rate limit excedido para este produto. Tente novamente em breve.' }),\n    };\n  }\n\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS products (\n      id SERIAL PRIMARY KEY,\n      name TEXT NOT NULL,\n      description TEXT,\n      price NUMERIC(10,2) NOT NULL,\n      stock INTEGER NOT NULL DEFAULT 0,\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS orders (\n      id SERIAL PRIMARY KEY,\n      user_id TEXT NOT NULL,\n      product_id INTEGER NOT NULL,\n      quantity INTEGER NOT NULL,\n      total NUMERIC(10,2),\n      status TEXT NOT NULL DEFAULT 'pending',\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n\n  const productResult = await db.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [productId]);\n  if (!productResult.rows.length) {\n    await db.end();\n    return {\n      statusCode: 404,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'Produto não encontrado' }),\n    };\n  }\n\n  const product = productResult.rows[0];\n  if (product.stock < quantity) {\n    await db.end();\n    return {\n      statusCode: 409,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'Estoque insuficiente' }),\n    };\n  }\n\n  const total = product.price * quantity;\n  const orderResult = await db.query(\n    'INSERT INTO orders (user_id, product_id, quantity, total) VALUES ($1, $2, $3, $4) RETURNING *',\n    [userId, productId, quantity, total]\n  );\n  await db.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [quantity, productId]);\n  await db.end();\n\n  await redis.del(`product:${productId}`);\n\n  return {\n    statusCode: 201,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify(orderResult.rows[0]),\n  };\n}"
    },
    "notes": [
      "Rate-limit via INCR+EXPIRE no Redis: contador por chave 'rl:{userId}:{action}' com janela fixa (RATE_LIMIT_MAX=10 requests / RATE_LIMIT_WINDOW_SEC=60s). Retorna 429 com Retry-After quando excedido.",
      "getProduct: rate-limit verificado antes do cache; produto cacheado por 5 minutos após leitura do PG (chave 'product:{productId}').",
      "createOrder: rate-limit por (userId, productId), SELECT FOR UPDATE garante consistência de estoque, invalida cache do produto após update.",
      "userId lido do header X-User-Id (case-insensitive — server.js já normaliza headers em lowercase no Azure Container Apps).",
      "npm install: pg ioredis @types/pg"
    ]
  },
  {
    "id": "azure-combo-04",
    "title": "Azure: Key Vault + Function + Service Bus Topic — worker seguro com fan-out",
    "provider": "azure",
    "constructs": [
      "Secret.Vault",
      "Fn.Lambda",
      "Messaging.Topic",
      "Fn.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "azure",
      "keyvault",
      "service-bus",
      "topic",
      "function",
      "fan-out",
      "secrets",
      "worker"
    ],
    "validated": false,
    "stacks": {
      "stacks/security/api-keys-stack.ts": "import { Stack, Secret } from '@iacmp/core';\n\nconst stack = new Stack('api-keys-stack');\n\nnew Secret.Vault(stack, 'ApiKeys', {\n  description: 'API keys de terceiros: OpenAI, SendGrid e parceiros externos',\n});\n\nexport default stack;",
      "stacks/messaging/events-topic-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('events-topic-stack');\n\nnew Messaging.Topic(stack, 'WorkerEventsTopic', {\n  displayName: 'Worker Events Fan-out',\n  subscriptions: [\n    { protocol: 'https', endpoint: 'https://downstream-a.internal/notify', filterPolicy: { type: ['result'] } },\n    { protocol: 'https', endpoint: 'https://downstream-b.internal/audit' },\n    { protocol: 'email', endpoint: 'ops@empresa.com' },\n  ],\n});\n\nexport default stack;",
      "stacks/compute/worker-stack.ts": "import { Stack, Fn, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('worker-stack');\n\nnew Fn.Lambda(stack, 'WorkerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/worker.handler',\n  code: '.',\n  timeout: 30,\n  memory: 512,\n  environment: {\n    VAULT_URI: ref('ApiKeys', 'VaultUri'),\n    TOPIC_CONNECTION_STRING: ref('WorkerEventsTopic', 'ConnectionString'),\n    TOPIC_NAME: 'WorkerEventsTopic',\n  },\n});\n\nnew Policy.IAM(stack, 'WorkerVaultPolicy', {\n  attachTo: 'WorkerFn',\n  attachType: 'lambda',\n  statements: [{\n    effect: 'Allow',\n    actions: ['keyvault:GetSecretValue'],\n    resources: [ref('ApiKeys', 'Arn')],\n  }],\n});\n\nexport default stack;",
      "stacks/network/api-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('api-stack');\n\nnew Fn.ApiGateway(stack, 'WorkerApi', {\n  name: 'worker-api',\n  type: 'HTTP',\n  cors: true,\n  routes: [\n    { method: 'POST', path: '/trigger', lambdaId: 'WorkerFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/worker.ts": "import { SecretClient } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\nimport { ServiceBusClient } from '@azure/service-bus';\n\nexport async function handler(event: any) {\n  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const { action, prompt } = body;\n\n  if (!action) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'action is required' }) };\n  }\n\n  // 1. Ler secret do Key Vault\n  const credential = new DefaultAzureCredential();\n  const secretClient = new SecretClient(process.env.VAULT_URI!, credential);\n\n  let apiKey: string;\n  try {\n    const secret = await secretClient.getSecret('openai-api-key');\n    apiKey = secret.value!;\n  } catch (err: any) {\n    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to read secret', detail: err.message }) };\n  }\n\n  // 2. Chamar API externa com o secret\n  let result: unknown;\n  try {\n    const resp = await fetch('https://api.openai.com/v1/chat/completions', {\n      method: 'POST',\n      headers: {\n        Authorization: `Bearer ${apiKey}`,\n        'Content-Type': 'application/json',\n      },\n      body: JSON.stringify({\n        model: 'gpt-4o-mini',\n        messages: [{ role: 'user', content: prompt ?? 'Hello' }],\n        max_tokens: 256,\n      }),\n    });\n    result = await resp.json();\n  } catch (err: any) {\n    return { statusCode: 502, body: JSON.stringify({ error: 'External API failed', detail: err.message }) };\n  }\n\n  // 3. Publicar evento no Service Bus Topic (fan-out)\n  const sbClient = new ServiceBusClient(process.env.TOPIC_CONNECTION_STRING!);\n  const sender = sbClient.createSender(process.env.TOPIC_NAME!);\n  try {\n    await sender.sendMessages({\n      body: JSON.stringify({ action, result, ts: new Date().toISOString() }),\n      applicationProperties: { type: 'result' },\n    });\n  } finally {\n    await sender.close();\n    await sbClient.close();\n  }\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ success: true, action }),\n  };\n}"
    },
    "notes": [
      "npm install @azure/keyvault-secrets @azure/identity @azure/service-bus",
      "O Container App precisa de Managed Identity com role 'Key Vault Secrets User' na vault ApiKeys",
      "Consumidores do tópico WorkerEventsTopic usam ServiceBusReceiver com createReceiver(topicName, subscriptionName)",
      "NUNCA use @aws-sdk/* nem @azure/data-tables para Service Bus ou Key Vault"
    ]
  },
  {
    "id": "azure-combo-04b",
    "title": "Azure: Key Vault + Function + Topic — integração com API de pagamento",
    "provider": "azure",
    "constructs": [
      "Secret.Vault",
      "Fn.Lambda",
      "Messaging.Topic",
      "Fn.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "azure",
      "keyvault",
      "service-bus",
      "topic",
      "function",
      "pagamento",
      "stripe",
      "fan-out"
    ],
    "validated": false,
    "stacks": {
      "stacks/security/payment-keys-stack.ts": "import { Stack, Secret } from '@iacmp/core';\n\nconst stack = new Stack('payment-keys-stack');\n\nnew Secret.Vault(stack, 'PaymentKeys', {\n  description: 'Chave secreta da Stripe e credenciais do gateway de pagamento',\n});\n\nexport default stack;",
      "stacks/messaging/payment-topic-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('payment-topic-stack');\n\nnew Messaging.Topic(stack, 'PaymentEventsTopic', {\n  displayName: 'Payment Events',\n  subscriptions: [\n    { protocol: 'https', endpoint: 'https://internal.empresa.com/payment-success' },\n    { protocol: 'https', endpoint: 'https://internal.empresa.com/payment-audit' },\n    { protocol: 'email', endpoint: 'financeiro@empresa.com' },\n  ],\n});\n\nexport default stack;",
      "stacks/compute/payment-worker-stack.ts": "import { Stack, Fn, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('payment-worker-stack');\n\nnew Fn.Lambda(stack, 'PaymentWorkerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/paymentWorker.handler',\n  code: '.',\n  timeout: 60,\n  memory: 512,\n  environment: {\n    PAYMENT_VAULT_URI: ref('PaymentKeys', 'VaultUri'),\n    PAYMENT_TOPIC_CONNECTION_STRING: ref('PaymentEventsTopic', 'ConnectionString'),\n    TOPIC_NAME: 'PaymentEventsTopic',\n  },\n});\n\nnew Policy.IAM(stack, 'PaymentWorkerVaultPolicy', {\n  attachTo: 'PaymentWorkerFn',\n  attachType: 'lambda',\n  statements: [{\n    effect: 'Allow',\n    actions: ['keyvault:GetSecretValue'],\n    resources: [ref('PaymentKeys', 'Arn')],\n  }],\n});\n\nexport default stack;",
      "stacks/network/payment-api-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('payment-api-stack');\n\nnew Fn.ApiGateway(stack, 'PaymentApi', {\n  name: 'payment-api',\n  type: 'HTTP',\n  cors: true,\n  routes: [\n    { method: 'POST', path: '/charge', lambdaId: 'PaymentWorkerFn' },\n    { method: 'GET', path: '/status/{chargeId}', lambdaId: 'PaymentWorkerFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/paymentWorker.ts": "import { SecretClient } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\nimport { ServiceBusClient } from '@azure/service-bus';\n\nexport async function handler(event: any) {\n  const method = event.httpMethod ?? event.method ?? 'POST';\n\n  if (method === 'GET') {\n    const chargeId = event.pathParameters?.chargeId;\n    if (!chargeId) {\n      return { statusCode: 400, body: JSON.stringify({ error: 'chargeId required' }) };\n    }\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ chargeId, status: 'pending' }),\n    };\n  }\n\n  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const { amount, currency, customerId, description } = body;\n\n  if (!amount || !currency || !customerId) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'amount, currency e customerId são obrigatórios' }) };\n  }\n\n  // 1. Ler chave Stripe do Key Vault\n  const credential = new DefaultAzureCredential();\n  const secretClient = new SecretClient(process.env.PAYMENT_VAULT_URI!, credential);\n\n  let stripeKey: string;\n  try {\n    const secret = await secretClient.getSecret('stripe-secret-key');\n    stripeKey = secret.value!;\n  } catch (err: any) {\n    return { statusCode: 500, body: JSON.stringify({ error: 'Falha ao ler credencial', detail: err.message }) };\n  }\n\n  // 2. Criar cobrança na Stripe\n  let charge: any;\n  try {\n    const stripeBody = new URLSearchParams({\n      amount: String(Math.round(amount * 100)),\n      currency,\n      customer: customerId,\n      description: description ?? 'Cobrança via iacmp worker',\n    });\n    const resp = await fetch('https://api.stripe.com/v1/charges', {\n      method: 'POST',\n      headers: {\n        Authorization: `Bearer ${stripeKey}`,\n        'Content-Type': 'application/x-www-form-urlencoded',\n      },\n      body: stripeBody.toString(),\n    });\n    charge = await resp.json();\n    if (charge.error) {\n      return { statusCode: 402, body: JSON.stringify({ error: charge.error.message }) };\n    }\n  } catch (err: any) {\n    return { statusCode: 502, body: JSON.stringify({ error: 'Stripe indisponível', detail: err.message }) };\n  }\n\n  // 3. Publicar evento de pagamento no Service Bus Topic\n  const sbClient = new ServiceBusClient(process.env.PAYMENT_TOPIC_CONNECTION_STRING!);\n  const sender = sbClient.createSender(process.env.TOPIC_NAME!);\n  try {\n    await sender.sendMessages({\n      body: JSON.stringify({\n        event: 'charge.created',\n        chargeId: charge.id,\n        amount,\n        currency,\n        customerId,\n        status: charge.status,\n        ts: new Date().toISOString(),\n      }),\n      applicationProperties: { event: 'charge.created' },\n    });\n  } finally {\n    await sender.close();\n    await sbClient.close();\n  }\n\n  return {\n    statusCode: 201,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ chargeId: charge.id, status: charge.status }),\n  };\n}"
    },
    "notes": [
      "npm install @azure/keyvault-secrets @azure/identity @azure/service-bus",
      "Armazenar o segredo com nome 'stripe-secret-key' na vault PaymentKeys via az keyvault secret set",
      "O Container App precisa de Managed Identity com role 'Key Vault Secrets User' na vault PaymentKeys",
      "Para POST /charge: body JSON com amount (float), currency (ex: 'brl'), customerId (Stripe customer ID)"
    ]
  },
  {
    "id": "azure-combo-04c",
    "title": "Azure: Key Vault + Function + Topic — webhook dispatcher seguro",
    "provider": "azure",
    "constructs": [
      "Secret.Vault",
      "Fn.Lambda",
      "Messaging.Topic",
      "Fn.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "azure",
      "keyvault",
      "service-bus",
      "topic",
      "function",
      "webhook",
      "hmac",
      "dispatcher",
      "fan-out"
    ],
    "validated": false,
    "stacks": {
      "stacks/security/webhook-secrets-stack.ts": "import { Stack, Secret } from '@iacmp/core';\n\nconst stack = new Stack('webhook-secrets-stack');\n\nnew Secret.Vault(stack, 'WebhookSecrets', {\n  description: 'Segredos HMAC para validação de webhooks de parceiros externos',\n});\n\nexport default stack;",
      "stacks/messaging/webhook-topic-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('webhook-topic-stack');\n\nnew Messaging.Topic(stack, 'WebhookDispatchTopic', {\n  displayName: 'Webhook Dispatch Fan-out',\n  subscriptions: [\n    { protocol: 'https', endpoint: 'https://handlers.internal/orders', filterPolicy: { source: ['shop'] } },\n    { protocol: 'https', endpoint: 'https://handlers.internal/payments', filterPolicy: { source: ['payment'] } },\n    { protocol: 'https', endpoint: 'https://handlers.internal/audit' },\n  ],\n});\n\nexport default stack;",
      "stacks/compute/webhook-dispatcher-stack.ts": "import { Stack, Fn, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('webhook-dispatcher-stack');\n\nnew Fn.Lambda(stack, 'WebhookDispatcherFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/webhookDispatcher.handler',\n  code: '.',\n  timeout: 15,\n  memory: 256,\n  environment: {\n    WEBHOOK_VAULT_URI: ref('WebhookSecrets', 'VaultUri'),\n    DISPATCH_TOPIC_CONNECTION_STRING: ref('WebhookDispatchTopic', 'ConnectionString'),\n    TOPIC_NAME: 'WebhookDispatchTopic',\n  },\n});\n\nnew Policy.IAM(stack, 'WebhookDispatcherVaultPolicy', {\n  attachTo: 'WebhookDispatcherFn',\n  attachType: 'lambda',\n  statements: [{\n    effect: 'Allow',\n    actions: ['keyvault:GetSecretValue'],\n    resources: [ref('WebhookSecrets', 'Arn')],\n  }],\n});\n\nexport default stack;",
      "stacks/network/webhook-api-stack.ts": "import { Stack, Fn } from '@iacmp/core';\n\nconst stack = new Stack('webhook-api-stack');\n\nnew Fn.ApiGateway(stack, 'WebhookApi', {\n  name: 'webhook-api',\n  type: 'HTTP',\n  cors: false,\n  routes: [\n    { method: 'POST', path: '/webhook/{source}', lambdaId: 'WebhookDispatcherFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/webhookDispatcher.ts": "import * as crypto from 'crypto';\nimport { SecretClient } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\nimport { ServiceBusClient } from '@azure/service-bus';\n\nconst VALID_SOURCES = ['shop', 'payment', 'crm'] as const;\ntype Source = typeof VALID_SOURCES[number];\n\nexport async function handler(event: any) {\n  const source = event.pathParameters?.source as Source | undefined;\n  if (!source || !VALID_SOURCES.includes(source)) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'source inválido. Valores aceitos: shop, payment, crm' }) };\n  }\n\n  const rawBody = typeof event.body === 'string' ? event.body : JSON.stringify(event.body ?? {});\n  const signature: string = event.headers?.['x-webhook-signature'] ?? event.headers?.['X-Webhook-Signature'] ?? '';\n\n  if (!signature) {\n    return { statusCode: 401, body: JSON.stringify({ error: 'Header x-webhook-signature ausente' }) };\n  }\n\n  // 1. Ler segredo HMAC do Key Vault (nome do segredo = webhook-hmac-{source})\n  const credential = new DefaultAzureCredential();\n  const secretClient = new SecretClient(process.env.WEBHOOK_VAULT_URI!, credential);\n\n  let hmacSecret: string;\n  try {\n    const secret = await secretClient.getSecret(`webhook-hmac-${source}`);\n    hmacSecret = secret.value!;\n  } catch (err: any) {\n    return { statusCode: 500, body: JSON.stringify({ error: 'Falha ao ler segredo HMAC', detail: err.message }) };\n  }\n\n  // 2. Validar assinatura HMAC-SHA256 com timing-safe compare\n  const expected = crypto.createHmac('sha256', hmacSecret).update(rawBody).digest('hex');\n  const sigHex = signature.replace(/^sha256=/, '');\n\n  let signatureValid = false;\n  try {\n    const sigBuffer = Buffer.from(sigHex, 'hex');\n    const expectedBuffer = Buffer.from(expected, 'hex');\n    signatureValid =\n      sigBuffer.length === expectedBuffer.length &&\n      crypto.timingSafeEqual(sigBuffer, expectedBuffer);\n  } catch {\n    signatureValid = false;\n  }\n\n  if (!signatureValid) {\n    return { statusCode: 401, body: JSON.stringify({ error: 'Assinatura inválida' }) };\n  }\n\n  // 3. Parsear payload\n  let payload: unknown;\n  try {\n    payload = JSON.parse(rawBody);\n  } catch {\n    payload = rawBody;\n  }\n\n  // 4. Publicar no Service Bus Topic com applicationProperties para filtro por subscription\n  const sbClient = new ServiceBusClient(process.env.DISPATCH_TOPIC_CONNECTION_STRING!);\n  const sender = sbClient.createSender(process.env.TOPIC_NAME!);\n  try {\n    await sender.sendMessages({\n      body: JSON.stringify({ source, payload, receivedAt: new Date().toISOString() }),\n      applicationProperties: { source },\n    });\n  } finally {\n    await sender.close();\n    await sbClient.close();\n  }\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ dispatched: true, source }),\n  };\n}"
    },
    "notes": [
      "npm install @azure/keyvault-secrets @azure/identity @azure/service-bus",
      "Cadastrar um segredo por source na vault: az keyvault secret set --vault-name <vault> --name webhook-hmac-shop --value <secret>",
      "O Container App precisa de Managed Identity com role 'Key Vault Secrets User' na vault WebhookSecrets",
      "O parceiro externo deve enviar header x-webhook-signature: sha256=<hex> com HMAC-SHA256 do body raw",
      "Consumidores do tópico filtram por applicationProperties.source via filterPolicy das subscriptions"
    ]
  },
  {
    "id": "azure-combo-05c",
    "title": "Azure: Container App + Redis + Monitor Alert — auto-scaling reativo a alarme",
    "provider": "azure",
    "constructs": [
      "Compute.Container",
      "Cache.Redis",
      "Monitoring.Alarm"
    ],
    "tags": [
      "azure",
      "container-app",
      "redis",
      "monitor-alert",
      "autoscaling",
      "scale-out",
      "cpu-scaling"
    ],
    "validated": false,
    "stacks": {
      "stacks/database/cache-stack.ts": "import { Stack, Cache } from '@iacmp/core';\nconst stack = new Stack('cache-stack');\nnew Cache.Redis(stack, 'ScalingCache', {\n  nodeType: 'small',\n  transitEncryptionEnabled: true,\n});\nexport default stack;",
      "stacks/compute/api-stack.ts": "import { Stack, Compute, ref } from '@iacmp/core';\nconst stack = new Stack('api-stack');\nnew Compute.Container(stack, 'ScalingApi', {\n  image: 'my-registry.azurecr.io/scaling-api:latest',\n  port: 3000,\n  cpu: 1,\n  memory: 2048,\n  minCapacity: 2,\n  maxCapacity: 20,\n  cpuTargetPercent: 70,\n  publicIp: true,\n  environment: {\n    REDIS_CONNECTION_STRING: ref('ScalingCache', 'ConnectionString'),\n    NODE_ENV: 'production',\n  },\n});\nexport default stack;",
      "stacks/monitoring/alarm-stack.ts": "import { Stack, Monitoring } from '@iacmp/core';\nconst stack = new Stack('alarm-stack');\nnew Monitoring.Alarm(stack, 'CpuScaleAlarm', {\n  metricName: 'CpuPercentage',\n  namespace: 'Microsoft.App/containerApps',\n  threshold: 80,\n  evaluationPeriods: 2,\n  periodSeconds: 300,\n  comparisonOperator: 'GreaterThanOrEqualToThreshold',\n  statistic: 'Average',\n  treatMissingData: 'notBreaching',\n});\nnew Monitoring.Alarm(stack, 'MemoryAlarm', {\n  metricName: 'MemoryWorkingSetBytes',\n  namespace: 'Microsoft.App/containerApps',\n  threshold: 80,\n  evaluationPeriods: 2,\n  periodSeconds: 300,\n  comparisonOperator: 'GreaterThanOrEqualToThreshold',\n  statistic: 'Average',\n  treatMissingData: 'notBreaching',\n});\nnew Monitoring.Alarm(stack, 'ErrorRateAlarm', {\n  metricName: 'Http5xxRequests',\n  namespace: 'Microsoft.App/containerApps',\n  threshold: 5,\n  evaluationPeriods: 3,\n  periodSeconds: 60,\n  comparisonOperator: 'GreaterThanOrEqualToThreshold',\n  statistic: 'Average',\n  treatMissingData: 'notBreaching',\n});\nexport default stack;"
    },
    "handlers": {
      "src/scaling-api.ts": "import express from 'express';\nimport Redis from 'ioredis';\n\nconst app = express();\napp.use(express.json());\n\nconst redis = new Redis(process.env.REDIS_CONNECTION_STRING!);\n\nfunction log(level: string, message: string, data?: Record<string, unknown>) {\n  process.stdout.write(\n    JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...data }) + '\\n'\n  );\n}\n\napp.get('/health', async (_req, res) => {\n  try {\n    await redis.ping();\n    res.json({ status: 'ok', redis: 'connected' });\n  } catch {\n    res.status(503).json({ status: 'error', redis: 'unreachable' });\n  }\n});\n\napp.get('/items', async (_req, res) => {\n  const start = Date.now();\n  try {\n    const cached = await redis.get('items:list');\n    if (cached) {\n      log('info', 'cache_hit', { key: 'items:list', durationMs: Date.now() - start });\n      return res.set('X-Cache', 'HIT').json(JSON.parse(cached));\n    }\n    const items = Array.from({ length: 10 }, (_, i) => ({\n      id: String(i + 1),\n      name: `Item ${i + 1}`,\n      stock: 100 - i * 5,\n    }));\n    await redis.set('items:list', JSON.stringify(items), 'EX', 30);\n    log('info', 'items_listed', { count: items.length, durationMs: Date.now() - start });\n    res.set('X-Cache', 'MISS').json(items);\n  } catch (err: any) {\n    log('error', 'list_error', { error: err.message });\n    res.status(500).json({ error: 'Internal server error' });\n  }\n});\n\napp.post('/items', async (req, res) => {\n  const start = Date.now();\n  try {\n    const item = { id: Date.now().toString(), ...req.body, createdAt: new Date().toISOString() };\n    await redis.set(`item:${item.id}`, JSON.stringify(item), 'EX', 3600);\n    await redis.del('items:list');\n    log('info', 'item_created', { id: item.id, durationMs: Date.now() - start });\n    res.status(201).json(item);\n  } catch (err: any) {\n    log('error', 'create_error', { error: err.message });\n    res.status(500).json({ error: 'Internal server error' });\n  }\n});\n\napp.get('/load', async (req, res) => {\n  const start = Date.now();\n  const n = parseInt((req.query.n as string) ?? '1000', 10);\n  let result = 0;\n  for (let i = 0; i < n; i++) result += Math.sqrt(i);\n  const keys = await redis.keys('item:*');\n  log('info', 'load_test', { n, keys: keys.length, durationMs: Date.now() - start });\n  res.json({ n, keys: keys.length, result: result.toFixed(4), durationMs: Date.now() - start });\n});\n\nconst port = parseInt(process.env.PORT ?? '3000', 10);\napp.listen(port, () => log('info', 'server_started', { port }));"
    },
    "notes": [
      "Compute.Container usa ingress externo nativo do Container App (publicIp:true) — nao use Fn.ApiGateway (APIM so roteia para Fn.Lambda)",
      "minCapacity:2 / maxCapacity:20 / cpuTargetPercent:70 configuram scale rules KEDA no Container App gerado pelo synth",
      "image e placeholder: substituir por URL real do ACR ou Docker Hub antes do deploy (ex: myacr.azurecr.io/scaling-api:latest)",
      "GET /load?n=<iterations> simula carga de CPU para acionar o CpuScaleAlarm e observar o scale-out",
      "npm install: express, ioredis, @types/express"
    ]
  },
  {
    "id": "azure-compute-autoscaling-1",
    "title": "VMSS simples com escalonamento por CPU",
    "provider": "azure",
    "constructs": [
      "Compute.AutoScaling"
    ],
    "tags": [
      "azure",
      "vmss",
      "autoscaling",
      "cpu-scaling",
      "ubuntu"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/vmss-cpu-stack.ts": "import { Stack, Compute } from '@iacmp/core';\n\nconst stack = new Stack('vmss-cpu');\n\nnew Compute.AutoScaling(stack, 'WebTier', {\n  instanceType: 'Standard_B2s',\n  minSize: 2,\n  maxSize: 10,\n  desiredCapacity: 2,\n  image: {\n    publisher: 'Canonical',\n    offer: '0001-com-ubuntu-server-jammy',\n    sku: '22_04-lts-gen2',\n    version: 'latest'\n  },\n  scalingPolicies: [\n    {\n      metric: 'Percentage CPU',\n      operator: 'GreaterThan',\n      threshold: 75,\n      direction: 'Increase',\n      changeCount: 1,\n      cooldown: 'PT5M'\n    },\n    {\n      metric: 'Percentage CPU',\n      operator: 'LessThan',\n      threshold: 25,\n      direction: 'Decrease',\n      changeCount: 1,\n      cooldown: 'PT10M'\n    }\n  ],\n  userDataScript: [\n    '#!/bin/bash',\n    'set -e',\n    'curl -fsSL https://deb.nodesource.com/setup_20.x | bash -',\n    'apt-get install -y nodejs',\n    'mkdir -p /opt/app',\n    'cd /opt/app',\n    'node /opt/app/server.js &'\n  ].join('\\n'),\n  tags: {\n    project: 'vmss-cpu',\n    env: 'production'\n  }\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/webServerHandler.ts": "import http from 'http';\nimport os from 'os';\nimport { cpus } from 'os';\n\nfunction getCpuUsagePercent(): number {\n  const cpuList = cpus();\n  const totalTicks = cpuList.reduce((acc, cpu) => {\n    return acc + Object.values(cpu.times).reduce((a, b) => a + b, 0);\n  }, 0);\n  const idleTicks = cpuList.reduce((acc, cpu) => acc + cpu.times.idle, 0);\n  return Math.round(((totalTicks - idleTicks) / totalTicks) * 100);\n}\n\nconst server = http.createServer((req, res) => {\n  if (req.url === '/health') {\n    res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));\n    return;\n  }\n\n  if (req.url === '/metrics') {\n    res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({\n      hostname: os.hostname(),\n      cpuUsagePercent: getCpuUsagePercent(),\n      freeMemMB: Math.round(os.freemem() / 1024 / 1024),\n      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),\n      uptimeSeconds: Math.round(os.uptime())\n    }));\n    return;\n  }\n\n  res.writeHead(200, { 'Content-Type': 'application/json' });\n  res.end(JSON.stringify({\n    message: 'VMSS instance running',\n    hostname: os.hostname(),\n    timestamp: new Date().toISOString()\n  }));\n});\n\nconst PORT = parseInt(process.env.PORT ?? '80', 10);\nserver.listen(PORT, () => {\n  console.log(`Server running on port ${PORT} — hostname: ${os.hostname()}`);\n});"
    },
    "notes": [
      "Ubuntu 22.04 LTS no Azure usa offer '0001-com-ubuntu-server-jammy' e sku '22_04-lts-gen2' — usar o alias legado 'UbuntuServer'/'22.04-LTS' causa ImageNotFound em regiões novas como Sweden Central e Poland Central.",
      "userDataScript é automaticamente codificado em base64 pelo synth antes de enviar ao ARM — passar a string já em base64 resulta em dupla codificação e o script nunca é executado na instância, sem nenhum erro visível no portal.",
      "desiredCapacity fora do intervalo [minSize, maxSize] causa falha silenciosa: o VMSS é criado com capacidade = minSize e a autoscale policy fica em estado 'degraded' sem surfaçar erro no deploy."
    ]
  },
  {
    "id": "azure-compute-container-1",
    "title": "Container App simples com APIM — Hello API",
    "provider": "azure",
    "constructs": [
      "Compute.Container",
      "Function.ApiGateway"
    ],
    "tags": [
      "azure",
      "container-apps",
      "apim",
      "hello-world",
      "simples"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/hello-api-stack.ts": "import { Stack, Compute, Fn } from '@iacmp/core';\n\nconst stack = new Stack('hello-api');\n\nnew Compute.Container(stack, 'HelloApp', {\n  image: 'node:20-alpine',\n  port: 3000,\n  environment: {\n    NODE_ENV: 'production',\n  },\n});\n\nnew Fn.ApiGateway(stack, 'HelloApi', {\n  name: 'hello-api',\n  stageName: 'api',\n  routes: [\n    { method: 'GET', path: '/hello', lambdaId: 'HelloApp' },\n    { method: 'GET', path: '/health', lambdaId: 'HelloApp' },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/helloHandler.ts": "export async function handler(event: any) {\n  const method = (event.httpMethod as string) ?? 'GET';\n  const path = (event.path as string) ?? '/';\n\n  if (path.endsWith('/health')) {\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ status: 'ok' }),\n    };\n  }\n\n  if (method === 'GET') {\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({\n        message: 'Hello from Azure Container Apps!',\n        timestamp: new Date().toISOString(),\n      }),\n    };\n  }\n\n  return {\n    statusCode: 405,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ error: 'Method not allowed' }),\n  };\n}\n"
    },
    "notes": [
      "stageName: 'api' no Fn.ApiGateway é obrigatório — string vazia causa 404 no APIM porque o path base no Azure é fixo em '/api'. Nunca omitir.",
      "O lambdaId nas rotas deve ser EXATAMENTE o id do construct Compute.Container no stack (case-sensitive). Um id errado faz o APIM apontar para um backend inexistente e retornar 500.",
      "Compute.Container já tem ingress público via Container Apps Environment (CAE) — o CAE é o load balancer. Nunca adicionar Network.LoadBalancer junto com Compute.Container: é redundante e falha no deploy.",
      "O handler recebe event.httpMethod, event.path, event.pathParameters e event.body. Retorna { statusCode, headers, body } — nunca retornar Express app diretamente.",
      "Nunca usar ref().toString(), String(ref()) ou template literal com ref() no código da stack — ref() retorna objeto opaco e essas operações produzem '[object Object]' silenciosamente."
    ]
  },
  {
    "id": "azure-compute-container-2",
    "title": "Container App com Database.SQL PostgreSQL — CRUD de tarefas",
    "provider": "azure",
    "constructs": [
      "Compute.Container",
      "Database.SQL",
      "Function.ApiGateway"
    ],
    "tags": [
      "azure",
      "container-apps",
      "postgresql",
      "flexible-server",
      "crud",
      "sql"
    ],
    "validated": false,
    "stacks": {
      "stacks/database/db-stack.ts": "import { Stack, Database } from '@iacmp/core';\n\nconst stack = new Stack('db-stack');\n\nnew Database.SQL(stack, 'AppDB', {\n  engine: 'postgres',\n});\n\nexport default stack;\n",
      "stacks/compute/tasks-api-stack.ts": "import { Stack, Compute, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('tasks-api');\n\nnew Compute.Container(stack, 'TasksApp', {\n  image: 'node:20-alpine',\n  port: 3000,\n  environment: {\n    DB_HOST: ref('AppDB', 'Endpoint'),\n    DB_PORT: ref('AppDB', 'Port'),\n    DB_USER: ref('AppDB', 'Username'),\n    DB_PASSWORD: ref('AppDB', 'Password'),\n    DB_NAME: 'postgres',\n  },\n});\n\nnew Fn.ApiGateway(stack, 'TasksApi', {\n  name: 'tasks-api',\n  stageName: 'api',\n  routes: [\n    { method: 'GET',    path: '/tasks',      lambdaId: 'TasksApp' },\n    { method: 'POST',   path: '/tasks',      lambdaId: 'TasksApp' },\n    { method: 'GET',    path: '/tasks/{id}', lambdaId: 'TasksApp' },\n    { method: 'DELETE', path: '/tasks/{id}', lambdaId: 'TasksApp' },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/tasksHandler.ts": "import { Client } from 'pg';\n\nasync function getClient() {\n  const client = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await client.connect();\n  await client.query(`\n    CREATE TABLE IF NOT EXISTS tasks (\n      id SERIAL PRIMARY KEY,\n      title TEXT NOT NULL,\n      done BOOLEAN DEFAULT false,\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n  return client;\n}\n\nexport async function handler(event: any) {\n  const method = (event.httpMethod as string) ?? 'GET';\n  const id = event.pathParameters?.id;\n  const body = event.body\n    ? (typeof event.body === 'string' ? JSON.parse(event.body) : event.body)\n    : {};\n\n  const client = await getClient();\n\n  try {\n    if (method === 'GET' && !id) {\n      const result = await client.query('SELECT * FROM tasks ORDER BY created_at DESC');\n      return {\n        statusCode: 200,\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify(result.rows),\n      };\n    }\n\n    if (method === 'GET' && id) {\n      const result = await client.query('SELECT * FROM tasks WHERE id = $1', [id]);\n      if (result.rows.length === 0) {\n        return {\n          statusCode: 404,\n          headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify({ error: 'Not found' }),\n        };\n      }\n      return {\n        statusCode: 200,\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify(result.rows[0]),\n      };\n    }\n\n    if (method === 'POST') {\n      const { title } = body;\n      const result = await client.query(\n        'INSERT INTO tasks (title) VALUES ($1) RETURNING *',\n        [title]\n      );\n      return {\n        statusCode: 201,\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify(result.rows[0]),\n      };\n    }\n\n    if (method === 'DELETE' && id) {\n      await client.query('DELETE FROM tasks WHERE id = $1', [id]);\n      return { statusCode: 204, headers: {}, body: '' };\n    }\n\n    return {\n      statusCode: 405,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'Method not allowed' }),\n    };\n  } finally {\n    await client.end();\n  }\n}\n"
    },
    "notes": [
      "DB_NAME: 'postgres' — string literal hardcoded, nunca ref(). O PostgreSQL Flexible Server cria apenas o banco 'postgres' por padrão. Usar o nome da aplicação (ex: 'tasks') causa erro 'database does not exist' no primeiro deploy.",
      "DB_USER: ref('AppDB', 'Username') — nunca hardcode 'postgres' ou 'admin'. O synth gera o usuário 'dbadmin' no Flexible Server; qualquer outro valor causa erro de autenticação.",
      "DB_PASSWORD: ref('AppDB', 'Password') — o Container Apps injeta o valor diretamente na env var. Nunca chamar o SDK do Key Vault em runtime para buscar a senha (isso é padrão AWS, não Azure).",
      "ssl: { rejectUnauthorized: false } obrigatório — o Flexible Server exige TLS mas usa certificado self-signed. Sem essa flag, a conexão é rejeitada com 'self-signed certificate'.",
      "CREATE TABLE IF NOT EXISTS deve estar em TODOS os handlers (list, create, get, delete) — o container pode receber qualquer rota no cold start, e o Flexible Server não cria tabelas automaticamente.",
      "SQL parametrizado usa $1, $2 (driver pg), nunca interpolação de string. Policy.IAM não gerar para Database.SQL no Azure — acesso é via usuário/senha nas env vars.",
      "ref() entre stacks separados funciona normalmente — o synth do iacmp resolve cross-stack refs via outputs. AppDB em db-stack.ts é referenciável em tasks-api-stack.ts com ref('AppDB', 'Endpoint')."
    ]
  },
  {
    "id": "azure-compute-container-3",
    "title": "Container App com Cache.Redis — API com cache Redis Enterprise",
    "provider": "azure",
    "constructs": [
      "Compute.Container",
      "Cache.Redis",
      "Function.ApiGateway"
    ],
    "tags": [
      "azure",
      "container-apps",
      "redis",
      "redis-enterprise",
      "cache",
      "ioredis"
    ],
    "validated": false,
    "stacks": {
      "stacks/compute/cached-api-stack.ts": "import { Stack, Compute, Cache, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('cached-api');\n\nnew Cache.Redis(stack, 'MyCache', {});\n\nnew Compute.Container(stack, 'CachedApp', {\n  image: 'node:20-alpine',\n  port: 3000,\n  environment: {\n    REDIS_CONNECTION_STRING: ref('MyCache', 'ConnectionString'),\n  },\n});\n\nnew Fn.ApiGateway(stack, 'CachedApi', {\n  name: 'cached-api',\n  stageName: 'api',\n  routes: [\n    { method: 'GET',    path: '/items/{key}', lambdaId: 'CachedApp' },\n    { method: 'PUT',    path: '/items/{key}', lambdaId: 'CachedApp' },\n    { method: 'DELETE', path: '/items/{key}', lambdaId: 'CachedApp' },\n  ],\n});\n\nexport default stack;\n"
    },
    "handlers": {
      "src/cacheHandler.ts": "import Redis from 'ioredis';\n\n// Redis Enterprise ConnectionString = 'rediss://:PASSWORD@host:10000'\n// ioredis aceita a URL diretamente — TLS e autenticação já estão no scheme rediss://\nconst redis = new Redis(process.env.REDIS_CONNECTION_STRING!);\n\nexport async function handler(event: any) {\n  const method = (event.httpMethod as string) ?? 'GET';\n  const key = event.pathParameters?.key;\n  const body = event.body\n    ? (typeof event.body === 'string' ? JSON.parse(event.body) : event.body)\n    : {};\n\n  if (!key) {\n    return {\n      statusCode: 400,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'key is required' }),\n    };\n  }\n\n  if (method === 'GET') {\n    const value = await redis.get(key);\n    if (value === null) {\n      return {\n        statusCode: 404,\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ error: 'Not found' }),\n      };\n    }\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ key, value: JSON.parse(value) }),\n    };\n  }\n\n  if (method === 'PUT') {\n    const ttl = Number(body.ttl) || 300;\n    await redis.set(key, JSON.stringify(body.value ?? body), 'EX', ttl);\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ key, stored: true }),\n    };\n  }\n\n  if (method === 'DELETE') {\n    await redis.del(key);\n    return { statusCode: 204, headers: {}, body: '' };\n  }\n\n  return {\n    statusCode: 405,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ error: 'Method not allowed' }),\n  };\n}\n"
    },
    "notes": [
      "REDIS_CONNECTION_STRING: ref('MyCache', 'ConnectionString') — o Redis Enterprise no Azure usa porta 10000 com TLS. A ConnectionString vem no formato 'rediss://:PASSWORD@host:10000'. Passe DIRETAMENTE ao new Redis(): tls e autenticação já estão no scheme rediss://.",
      "NUNCA new Redis({ host, port: 6379 }) no Azure — a porta 6379 não existe no Redis Enterprise (SKU Balanced_B0). A porta é sempre 10000 com TLS obrigatório.",
      "NUNCA split(',').find(p => p.startsWith('password=')) para extrair a senha — esse formato é do Azure Cache for Redis Standard, NÃO do Redis Enterprise. A ConnectionString do Enterprise é uma URL rediss://, não uma lista de pares chave=valor.",
      "tls: {} NÃO é necessário quando se usa a URL rediss:// — o TLS já está incluso no scheme. Se conectar via host/port separados (REDIS_HOST + REDIS_PORT), aí sim usar new Redis({ host, port: 10000, password, tls: {} }).",
      "Atributos válidos de ref() para Cache.Redis: 'Host', 'Port', 'ConnectionString'. Não existe atributo 'Password' isolado — a senha está embutida na ConnectionString.",
      "Nunca adicionar Network.LoadBalancer com Compute.Container — o Container Apps Environment já é o ingress público. O par CAE+Container App resolve roteamento HTTP sem LB externo."
    ]
  },
  {
    "id": "azure-database-documentdb-1",
    "title": "CRUD simples de notas com Container App",
    "provider": "azure",
    "constructs": [
      "Database.DocumentDB",
      "Function.Lambda",
      "Function.ApiGateway"
    ],
    "tags": [
      "azure",
      "documentdb",
      "cosmos",
      "mongodb",
      "crud",
      "container-app"
    ],
    "validated": false,
    "stacks": {
      "stacks/notes/notes-stack.ts": "import { Stack, Database, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('notes-api');\n\nnew Database.DocumentDB(stack, 'NotesDb', {});\n\nnew Fn.Lambda(stack, 'NotesHandler', {\n  runtime: 'nodejs20',\n  handler: 'src/notesHandler.ts',\n  code: 'src/',\n  environment: {\n    MONGODB_URI: ref('NotesDb', 'ConnectionString'),\n    DB_NAME: 'notesdb-db',\n  },\n});\n\nnew Fn.ApiGateway(stack, 'NotesApi', {\n  name: 'notes-api',\n  stageName: 'api',\n  cors: true,\n  routes: [\n    { method: 'GET',    path: '/notes',      lambdaId: 'NotesHandler' },\n    { method: 'POST',   path: '/notes',      lambdaId: 'NotesHandler' },\n    { method: 'GET',    path: '/notes/{id}', lambdaId: 'NotesHandler' },\n    { method: 'PUT',    path: '/notes/{id}', lambdaId: 'NotesHandler' },\n    { method: 'DELETE', path: '/notes/{id}', lambdaId: 'NotesHandler' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/notesHandler.ts": "import { MongoClient, ObjectId } from 'mongodb';\n\nlet client: MongoClient | null = null;\n\nasync function getCollection() {\n  if (!client) {\n    client = new MongoClient(process.env.MONGODB_URI!);\n    await client.connect();\n  }\n  return client.db(process.env.DB_NAME!).collection('documents');\n}\n\nexport const handler = async (event: any) => {\n  const method = event.httpMethod || event.requestContext?.http?.method || '';\n  const pathParams = event.pathParameters || {};\n  const body = event.body ? JSON.parse(event.body) : {};\n  const col = await getCollection();\n\n  try {\n    if (method === 'GET' && !pathParams.id) {\n      const notes = await col.find({}).sort({ createdAt: -1 }).toArray();\n      return ok(notes.map(n => ({ ...n, id: n._id.toString(), _id: undefined })));\n    }\n\n    if (method === 'GET' && pathParams.id) {\n      if (!ObjectId.isValid(pathParams.id)) return badRequest('ID invalido');\n      const note = await col.findOne({ _id: new ObjectId(pathParams.id) });\n      if (!note) return notFound();\n      return ok({ ...note, id: note._id.toString(), _id: undefined });\n    }\n\n    if (method === 'POST') {\n      const { title, content } = body;\n      if (!title) return badRequest('title obrigatorio');\n      const result = await col.insertOne({\n        title,\n        content: content ?? '',\n        createdAt: new Date(),\n        updatedAt: new Date(),\n      });\n      return ok({ id: result.insertedId.toString() }, 201);\n    }\n\n    if (method === 'PUT' && pathParams.id) {\n      if (!ObjectId.isValid(pathParams.id)) return badRequest('ID invalido');\n      const { _id, id, ...fields } = body;\n      await col.updateOne(\n        { _id: new ObjectId(pathParams.id) },\n        { $set: { ...fields, updatedAt: new Date() } },\n      );\n      return ok({ updated: true });\n    }\n\n    if (method === 'DELETE' && pathParams.id) {\n      if (!ObjectId.isValid(pathParams.id)) return badRequest('ID invalido');\n      await col.deleteOne({ _id: new ObjectId(pathParams.id) });\n      return ok({ deleted: true });\n    }\n\n    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };\n  } catch (err: any) {\n    console.error(err);\n    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };\n  }\n};\n\nfunction ok(data: any, status = 200) {\n  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };\n}\nfunction badRequest(msg: string) {\n  return { statusCode: 400, body: JSON.stringify({ error: msg }) };\n}\nfunction notFound() {\n  return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };\n}"
    },
    "notes": [
      "O synth gera o banco com nome `{constructId.toLowerCase()}-db` — para construct 'NotesDb' o banco e 'notesdb-db'. Hardcode DB_NAME no stack (nao no handler), pois e derivado do construct id e nao configuravel.",
      "`ref('NotesDb', 'ConnectionString')` resolve para `listConnectionStrings().connectionStrings[0].connectionString` no Bicep — inclui host, porta 10255, SSL e replica set automaticamente. Nunca montar connection string manual combinando Endpoint + Password.",
      "A collection `documents` e a unica criada pelo synth via Bicep. Collections adicionais sao criadas lazily pelo driver MongoDB ao primeiro `insertOne` — nao ha equivalente ao `CREATE TABLE IF NOT EXISTS`.",
      "Cachear o `MongoClient` fora do handler evita nova conexao TCP a cada request. O Container App mantem o processo vivo entre invocacoes, reutilizando a conexao — mesmo comportamento de Lambda warm start na AWS.",
      "Sempre validar com `ObjectId.isValid()` antes de construir `new ObjectId(id)` — a Cosmos DB MongoDB API lanca excecao do driver (nao HTTP 400) se o string nao for um ObjectId valido de 24 hex chars."
    ]
  },
  {
    "id": "azure-database-documentdb-2",
    "title": "API de usuarios com autenticacao JWT e bcrypt",
    "provider": "azure",
    "constructs": [
      "Database.DocumentDB",
      "Function.Lambda",
      "Function.ApiGateway"
    ],
    "tags": [
      "azure",
      "documentdb",
      "cosmos",
      "mongodb",
      "autenticacao",
      "jwt",
      "bcrypt"
    ],
    "validated": false,
    "stacks": {
      "stacks/auth/auth-stack.ts": "import { Stack, Database, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('auth-api');\n\nnew Database.DocumentDB(stack, 'UsersDb', {});\n\nnew Fn.Lambda(stack, 'AuthHandler', {\n  runtime: 'nodejs20',\n  handler: 'src/authHandler.ts',\n  code: 'src/',\n  environment: {\n    MONGODB_URI: ref('UsersDb', 'ConnectionString'),\n    DB_NAME: 'usersdb-db',\n    JWT_SECRET: 'troque-no-deploy-via-env-var',\n    JWT_EXPIRY: '7d',\n  },\n});\n\nnew Fn.ApiGateway(stack, 'AuthApi', {\n  name: 'auth-api',\n  stageName: 'api',\n  cors: true,\n  routes: [\n    { method: 'POST', path: '/auth/register', lambdaId: 'AuthHandler' },\n    { method: 'POST', path: '/auth/login',    lambdaId: 'AuthHandler' },\n    { method: 'GET',  path: '/auth/me',       lambdaId: 'AuthHandler' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/authHandler.ts": "import { MongoClient, ObjectId } from 'mongodb';\nimport * as bcrypt from 'bcrypt';\nimport * as jwt from 'jsonwebtoken';\n\nlet client: MongoClient | null = null;\n\nasync function getDb() {\n  if (!client) {\n    client = new MongoClient(process.env.MONGODB_URI!);\n    await client.connect();\n    // Criar indice unico no email na primeira conexao (idempotente)\n    await client\n      .db(process.env.DB_NAME!)\n      .collection('users')\n      .createIndex({ email: 1 }, { unique: true });\n  }\n  return client.db(process.env.DB_NAME!);\n}\n\nexport const handler = async (event: any) => {\n  const method = event.httpMethod || event.requestContext?.http?.method || '';\n  const path = event.path || event.rawPath || '';\n  const body = event.body ? JSON.parse(event.body) : {};\n  const db = await getDb();\n  const users = db.collection('users');\n\n  try {\n    if (method === 'POST' && path.endsWith('/register')) {\n      const { email, password, name } = body;\n      if (!email || !password) return badRequest('email e password obrigatorios');\n      const hash = await bcrypt.hash(password, 10);\n      const result = await users.insertOne({\n        email,\n        password: hash,\n        name: name ?? '',\n        createdAt: new Date(),\n      });\n      return ok({ id: result.insertedId.toString() }, 201);\n    }\n\n    if (method === 'POST' && path.endsWith('/login')) {\n      const { email, password } = body;\n      if (!email || !password) return badRequest('email e password obrigatorios');\n      const user = await users.findOne({ email });\n      if (!user) return unauthorized('Credenciais invalidas');\n      const match = await bcrypt.compare(password, user.password as string);\n      if (!match) return unauthorized('Credenciais invalidas');\n      const token = jwt.sign(\n        { sub: user._id.toString(), email: user.email },\n        process.env.JWT_SECRET!,\n        { expiresIn: (process.env.JWT_EXPIRY ?? '7d') as any },\n      );\n      return ok({ token });\n    }\n\n    if (method === 'GET' && path.endsWith('/me')) {\n      const auth = event.headers?.Authorization || event.headers?.authorization || '';\n      const token = auth.replace(/^Bearer /i, '').trim();\n      if (!token) return unauthorized('Token ausente');\n      let payload: any;\n      try {\n        payload = jwt.verify(token, process.env.JWT_SECRET!);\n      } catch {\n        return unauthorized('Token invalido ou expirado');\n      }\n      if (!ObjectId.isValid(payload.sub)) return unauthorized('Token malformado');\n      const user = await users.findOne({ _id: new ObjectId(payload.sub) });\n      if (!user) return notFound();\n      const { password: _pwd, ...profile } = user;\n      return ok({ ...profile, id: user._id.toString(), _id: undefined });\n    }\n\n    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };\n  } catch (err: any) {\n    if (err.code === 11000)\n      return { statusCode: 409, body: JSON.stringify({ error: 'Email ja cadastrado' }) };\n    console.error(err);\n    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };\n  }\n};\n\nfunction ok(data: any, status = 200) {\n  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };\n}\nfunction badRequest(msg: string) {\n  return { statusCode: 400, body: JSON.stringify({ error: msg }) };\n}\nfunction unauthorized(msg: string) {\n  return { statusCode: 401, body: JSON.stringify({ error: msg }) };\n}\nfunction notFound() {\n  return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };\n}"
    },
    "notes": [
      "A collection 'users' nao existe no Bicep gerado pelo synth — e criada lazily no primeiro `insertOne`. O indice unico de email deve ser criado no cold start via `createIndex` — chamar dentro do bloco `if (!client)` para garantir execucao unica por processo.",
      "Cosmos DB MongoDB API retorna `MongoError` com `code: 11000` para violacao de indice unico (duplicate key) — mesmo codigo do MongoDB nativo. Tratar no catch para retornar 409 em vez de 500.",
      "Nunca retornar o campo `password` (hash bcrypt) no response — usar desestruturacao `{ password: _pwd, ...profile }` para excluir antes de serializar.",
      "A connection string da Cosmos DB MongoDB API inclui `retrywrites=false` — writes nao sao automaticamente retentados pelo driver. Para operacoes criticas, implementar retry manual com backoff exponencial.",
      "O JWT_SECRET no stack e uma string literal apenas para exemplo. Em producao, usar `Secret.Vault` e ler a URI via `@azure/keyvault-secrets` + `DefaultAzureCredential` no cold start, com Policy.IAM `actions: ['secretsmanager:GetSecretValue']` apontando para o construct Secret.Vault."
    ]
  },
  {
    "id": "azure-database-documentdb-3",
    "title": "Multi-collection: catalogo e-commerce com produtos, pedidos e avaliacoes",
    "provider": "azure",
    "constructs": [
      "Database.DocumentDB",
      "Function.Lambda",
      "Function.ApiGateway"
    ],
    "tags": [
      "azure",
      "documentdb",
      "cosmos",
      "mongodb",
      "multi-collection",
      "ecommerce"
    ],
    "validated": false,
    "stacks": {
      "stacks/catalog/catalog-stack.ts": "import { Stack, Database, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('catalog-api');\n\nnew Database.DocumentDB(stack, 'CatalogDb', {});\n\nnew Fn.Lambda(stack, 'ProductsHandler', {\n  runtime: 'nodejs20',\n  handler: 'src/productsHandler.ts',\n  code: 'src/',\n  environment: {\n    MONGODB_URI: ref('CatalogDb', 'ConnectionString'),\n    DB_NAME: 'catalogdb-db',\n  },\n});\n\nnew Fn.Lambda(stack, 'OrdersHandler', {\n  runtime: 'nodejs20',\n  handler: 'src/ordersHandler.ts',\n  code: 'src/',\n  environment: {\n    MONGODB_URI: ref('CatalogDb', 'ConnectionString'),\n    DB_NAME: 'catalogdb-db',\n  },\n});\n\nnew Fn.Lambda(stack, 'ReviewsHandler', {\n  runtime: 'nodejs20',\n  handler: 'src/reviewsHandler.ts',\n  code: 'src/',\n  environment: {\n    MONGODB_URI: ref('CatalogDb', 'ConnectionString'),\n    DB_NAME: 'catalogdb-db',\n  },\n});\n\nnew Fn.ApiGateway(stack, 'CatalogApi', {\n  name: 'catalog-api',\n  stageName: 'api',\n  cors: true,\n  routes: [\n    { method: 'GET',  path: '/products',              lambdaId: 'ProductsHandler' },\n    { method: 'POST', path: '/products',              lambdaId: 'ProductsHandler' },\n    { method: 'GET',  path: '/products/{id}',         lambdaId: 'ProductsHandler' },\n    { method: 'GET',  path: '/orders',                lambdaId: 'OrdersHandler' },\n    { method: 'POST', path: '/orders',                lambdaId: 'OrdersHandler' },\n    { method: 'GET',  path: '/products/{id}/reviews', lambdaId: 'ReviewsHandler' },\n    { method: 'POST', path: '/products/{id}/reviews', lambdaId: 'ReviewsHandler' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/productsHandler.ts": "import { MongoClient, ObjectId } from 'mongodb';\n\nlet client: MongoClient | null = null;\n\nasync function getCollection() {\n  if (!client) {\n    client = new MongoClient(process.env.MONGODB_URI!);\n    await client.connect();\n    const db = client.db(process.env.DB_NAME!);\n    await db.collection('products').createIndex({ sku: 1 }, { unique: true });\n    await db.collection('products').createIndex({ category: 1, price: 1 });\n  }\n  return client.db(process.env.DB_NAME!).collection('products');\n}\n\nexport const handler = async (event: any) => {\n  const method = event.httpMethod || event.requestContext?.http?.method || '';\n  const pathParams = event.pathParameters || {};\n  const body = event.body ? JSON.parse(event.body) : {};\n  const qs = event.queryStringParameters || {};\n  const col = await getCollection();\n\n  try {\n    if (method === 'GET' && !pathParams.id) {\n      const filter: any = {};\n      if (qs.category) filter.category = qs.category;\n      if (qs.minPrice) filter.price = { $gte: Number(qs.minPrice) };\n      const products = await col.find(filter).sort({ createdAt: -1 }).limit(50).toArray();\n      return ok(products.map(p => ({ ...p, id: p._id.toString(), _id: undefined })));\n    }\n\n    if (method === 'GET' && pathParams.id) {\n      if (!ObjectId.isValid(pathParams.id)) return badRequest('ID invalido');\n      const product = await col.findOne({ _id: new ObjectId(pathParams.id) });\n      if (!product) return notFound();\n      return ok({ ...product, id: product._id.toString(), _id: undefined });\n    }\n\n    if (method === 'POST') {\n      const { name, sku, price, category, stock } = body;\n      if (!name || !sku || price == null) return badRequest('name, sku e price obrigatorios');\n      const result = await col.insertOne({\n        name,\n        sku,\n        price: Number(price),\n        category: category ?? 'geral',\n        stock: stock ?? 0,\n        createdAt: new Date(),\n      });\n      return ok({ id: result.insertedId.toString() }, 201);\n    }\n\n    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };\n  } catch (err: any) {\n    if (err.code === 11000) return { statusCode: 409, body: JSON.stringify({ error: 'SKU ja existe' }) };\n    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };\n  }\n};\n\nfunction ok(data: any, status = 200) {\n  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };\n}\nfunction badRequest(msg: string) {\n  return { statusCode: 400, body: JSON.stringify({ error: msg }) };\n}\nfunction notFound() {\n  return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };\n}",
      "src/ordersHandler.ts": "import { MongoClient, ObjectId } from 'mongodb';\n\nlet client: MongoClient | null = null;\n\nasync function getDb() {\n  if (!client) {\n    client = new MongoClient(process.env.MONGODB_URI!);\n    await client.connect();\n    const db = client.db(process.env.DB_NAME!);\n    await db.collection('orders').createIndex({ userId: 1, createdAt: -1 });\n    await db.collection('orders').createIndex({ status: 1 });\n  }\n  return client.db(process.env.DB_NAME!);\n}\n\nexport const handler = async (event: any) => {\n  const method = event.httpMethod || event.requestContext?.http?.method || '';\n  const body = event.body ? JSON.parse(event.body) : {};\n  const qs = event.queryStringParameters || {};\n  const db = await getDb();\n\n  try {\n    if (method === 'GET') {\n      const filter: any = {};\n      if (qs.userId) filter.userId = qs.userId;\n      if (qs.status) filter.status = qs.status;\n\n      const orders = await db.collection('orders').find(filter).sort({ createdAt: -1 }).limit(20).toArray();\n\n      // Join manual entre collections — $lookup tem limitacoes na Cosmos DB MongoDB API\n      const productIds = [...new Set(\n        orders.flatMap(o => ((o.items as any[]) || []).map((i: any) => i.productId)),\n      )] as string[];\n      const products = productIds.length > 0\n        ? await db.collection('products')\n            .find({ _id: { $in: productIds.filter(ObjectId.isValid).map(id => new ObjectId(id)) } })\n            .toArray()\n        : [];\n      const productMap = Object.fromEntries(products.map(p => [p._id.toString(), p]));\n\n      const enriched = orders.map(o => ({\n        ...o,\n        id: o._id.toString(),\n        _id: undefined,\n        items: ((o.items as any[]) || []).map((item: any) => ({\n          ...item,\n          product: productMap[item.productId]\n            ? { name: productMap[item.productId].name, sku: productMap[item.productId].sku }\n            : null,\n        })),\n      }));\n      return ok(enriched);\n    }\n\n    if (method === 'POST') {\n      const { userId, items } = body;\n      if (!userId || !Array.isArray(items) || items.length === 0)\n        return badRequest('userId e items obrigatorios');\n      const total = (items as any[]).reduce((acc: number, i: any) => acc + Number(i.price) * Number(i.qty), 0);\n      const result = await db.collection('orders').insertOne({\n        userId,\n        items,\n        total,\n        status: 'pending',\n        createdAt: new Date(),\n      });\n      return ok({ id: result.insertedId.toString() }, 201);\n    }\n\n    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };\n  } catch (err: any) {\n    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };\n  }\n};\n\nfunction ok(data: any, status = 200) {\n  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };\n}\nfunction badRequest(msg: string) {\n  return { statusCode: 400, body: JSON.stringify({ error: msg }) };\n}",
      "src/reviewsHandler.ts": "import { MongoClient, ObjectId } from 'mongodb';\n\nlet client: MongoClient | null = null;\n\nasync function getDb() {\n  if (!client) {\n    client = new MongoClient(process.env.MONGODB_URI!);\n    await client.connect();\n    await client.db(process.env.DB_NAME!).collection('reviews').createIndex({ productId: 1, createdAt: -1 });\n  }\n  return client.db(process.env.DB_NAME!);\n}\n\nexport const handler = async (event: any) => {\n  const method = event.httpMethod || event.requestContext?.http?.method || '';\n  const pathParams = event.pathParameters || {};\n  const body = event.body ? JSON.parse(event.body) : {};\n  const db = await getDb();\n  const reviews = db.collection('reviews');\n\n  try {\n    if (method === 'GET') {\n      if (!pathParams.id) return badRequest('ID de produto ausente');\n      const list = await reviews.find({ productId: pathParams.id }).sort({ createdAt: -1 }).limit(50).toArray();\n      const avg = list.length > 0\n        ? list.reduce((s, r) => s + Number(r.rating || 0), 0) / list.length\n        : null;\n      return ok({\n        reviews: list.map(r => ({ ...r, id: r._id.toString(), _id: undefined })),\n        averageRating: avg,\n        total: list.length,\n      });\n    }\n\n    if (method === 'POST') {\n      if (!pathParams.id) return badRequest('ID de produto ausente');\n      const { userId, rating, comment } = body;\n      if (!userId || rating == null) return badRequest('userId e rating obrigatorios');\n      const ratingNum = Number(rating);\n      if (ratingNum < 1 || ratingNum > 5) return badRequest('rating deve ser entre 1 e 5');\n      const result = await reviews.insertOne({\n        productId: pathParams.id,\n        userId,\n        rating: ratingNum,\n        comment: comment ?? '',\n        createdAt: new Date(),\n      });\n      return ok({ id: result.insertedId.toString() }, 201);\n    }\n\n    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };\n  } catch (err: any) {\n    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };\n  }\n};\n\nfunction ok(data: any, status = 200) {\n  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };\n}\nfunction badRequest(msg: string) {\n  return { statusCode: 400, body: JSON.stringify({ error: msg }) };\n}"
    },
    "notes": [
      "O synth cria somente a collection `documents` via Bicep. Collections extras (`products`, `orders`, `reviews`) sao criadas lazily pelo driver ao primeiro `insertOne` — nao ha DDL de colecao no MongoDB.",
      "Todos os handlers apontam para o mesmo construct `CatalogDb` via `ref('CatalogDb', 'ConnectionString')`, mas cada Container App mantem seu proprio `MongoClient` cacheado — processos isolados, sem pool compartilhado entre funcoes.",
      "Cosmos DB MongoDB API tem suporte restrito a `$lookup` entre collections acima de ~5k documentos (custo de RU explode). Para joins, usar fetch separado por collection e merge em memoria — como demonstrado em ordersHandler.",
      "Indices compostos criados via `createIndex` no cold start sao idempotentes — chamadas subsequentes retornam sem erro se o indice ja existe. Custo de criacao repetida e irrelevante; nao cachear com flag manual.",
      "Cosmos DB MongoDB API nao suporta transacoes multi-documento no plano Free Tier (enableFreeTier: true). Para consistencia em multiplas collections, usar documento unico com subdocumentos, ou migrar para plano Standard que habilita transacoes ACID."
    ]
  },
  {
    "id": "azure-fn-webhook",
    "title": "Azure Function — receptor de webhook GitHub com HMAC",
    "provider": "azure",
    "constructs": [
      "Secret.Vault",
      "Fn.Lambda",
      "Fn.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "function",
      "lambda",
      "webhook",
      "github",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/webhook/webhook-stack.ts": "import { Stack, Fn, Secret, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('az-webhook-stack');\n\nnew Secret.Vault(stack, 'GithubSecret', {\n  description: 'Segredo HMAC do webhook GitHub',\n});\n\nnew Fn.Lambda(stack, 'WebhookFn', {\n  runtime: 'nodejs20',\n  handler: 'src/handler.handler',\n  code: '.',\n  memory: 256,\n  timeout: 30,\n  environment: {\n    VAULT_URI: ref('GithubSecret', 'VaultUri'),\n  },\n});\n\nnew Fn.ApiGateway(stack, 'WebhookApi', {\n  name: 'az-webhook-api',\n  type: 'HTTP',\n  routes: [\n    { method: 'POST', path: '/webhook', lambdaId: 'WebhookFn' },\n  ],\n});\n\nnew Policy.IAM(stack, 'WebhookFnPolicy', {\n  attachTo: 'WebhookFn',\n  attachType: 'lambda',\n  statements: [{\n    effect: 'Allow',\n    actions: ['keyvault:GetSecretValue'],\n    resources: [ref('GithubSecret', 'Arn')],\n  }],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/handler.ts": "import { createHmac, timingSafeEqual } from 'crypto';\nimport { SecretClient } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\n\nconst SECRET_NAME = 'github-webhook-secret';\nlet cachedSecret: string | null = null;\n\nasync function getWebhookSecret(): Promise<string> {\n  if (cachedSecret) return cachedSecret;\n  const credential = new DefaultAzureCredential();\n  const client = new SecretClient(process.env.VAULT_URI!, credential);\n  const secret = await client.getSecret(SECRET_NAME);\n  cachedSecret = secret.value!;\n  return cachedSecret;\n}\n\nexport async function handler(event: any) {\n  const headers = event.headers ?? {};\n  const signature: string =\n    headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'] ?? '';\n\n  if (!signature.startsWith('sha256=')) {\n    return { statusCode: 401, body: JSON.stringify({ error: 'Missing HMAC signature' }) };\n  }\n\n  const rawBody =\n    typeof event.body === 'string' ? event.body : JSON.stringify(event.body ?? {});\n\n  let webhookSecret: string;\n  try {\n    webhookSecret = await getWebhookSecret();\n  } catch (err: any) {\n    console.error('[webhook] Key Vault error:', err.message);\n    return { statusCode: 500, body: JSON.stringify({ error: 'Secret fetch failed' }) };\n  }\n\n  const expected = 'sha256=' + createHmac('sha256', webhookSecret).update(rawBody).digest('hex');\n  const sigBuf = Buffer.from(signature);\n  const expBuf = Buffer.from(expected);\n  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {\n    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid signature' }) };\n  }\n\n  const githubEvent: string =\n    headers['x-github-event'] ?? headers['X-GitHub-Event'] ?? 'unknown';\n  const payload =\n    typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n\n  if (githubEvent === 'push') {\n    const pushedRef = payload.ref as string;\n    const commits = (payload.commits ?? []).length;\n    const repo = payload.repository?.full_name;\n    console.log(`[webhook] push repo=${repo} ref=${pushedRef} commits=${commits}`);\n  } else if (githubEvent === 'pull_request') {\n    const action = payload.action;\n    const pr = payload.pull_request?.number;\n    const repo = payload.repository?.full_name;\n    console.log(`[webhook] pull_request action=${action} pr=${pr} repo=${repo}`);\n  } else if (githubEvent === 'ping') {\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ received: true, event: 'ping', zen: payload.zen }),\n    };\n  } else {\n    console.log(`[webhook] unhandled event=${githubEvent}`);\n  }\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ received: true, event: githubEvent }),\n  };\n}"
    },
    "notes": [
      "Secret.Vault no Azure = Key Vault; handler usa @azure/keyvault-secrets + DefaultAzureCredential, NUNCA @aws-sdk/* nem Secrets Manager",
      "Policy.IAM usa actions: ['keyvault:GetSecretValue'] para RBAC do Key Vault no Azure (dataActions)",
      "timingSafeEqual evita timing attack na comparação do HMAC SHA-256",
      "Secret em cache em módulo (cachedSecret) evita chamada ao Key Vault a cada invocação do Container App",
      "VAULT_URI usa ref('GithubSecret', 'VaultUri') diretamente — NUNCA process.env.X na stack"
    ]
  },
  {
    "id": "azure-network-waf-1",
    "title": "WAF básico com OWASP 3.2 fronteando Container App",
    "provider": "azure",
    "constructs": [
      "Network.WAF",
      "Compute.Container"
    ],
    "tags": [
      "azure",
      "waf",
      "owasp",
      "container-app",
      "security"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/waf-basico.ts": "import { Stack, Network, Compute } from '@iacmp/core';\n\nconst stack = new Stack('waf-basico');\n\nnew Compute.Container(stack, 'ApiApp', {\n  image: 'node:20-alpine',\n  port: 3000,\n  cpu: 0.5,\n  memory: 1024,\n  environment: {\n    NODE_ENV: 'production',\n    PORT: '3000',\n  },\n});\n\nnew Network.WAF(stack, 'ApiWAF', {\n  mode: 'Prevention',\n  defaultAction: 'allow',\n  description: 'WAF com OWASP 3.2 e proteção contra bots',\n  rules: [\n    {\n      name: 'owasp-common',\n      priority: 10,\n      managedGroup: 'AWSManagedRulesCommonRuleSet',\n    },\n    {\n      name: 'bot-protection',\n      priority: 20,\n      managedGroup: 'AWSManagedRulesBotControlRuleSet',\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/apiHandler.ts": "import express from 'express';\n\nconst app = express();\napp.use(express.json());\n\ninterface Produto {\n  id: string;\n  nome: string;\n  preco: number;\n}\n\nconst produtos: Produto[] = [];\n\napp.get('/health', (_req, res) => {\n  res.json({ status: 'ok', timestamp: new Date().toISOString() });\n});\n\napp.get('/produtos', (_req, res) => {\n  res.json({ data: produtos, total: produtos.length });\n});\n\napp.post('/produtos', (req, res) => {\n  const { nome, preco } = req.body as { nome?: string; preco?: number };\n  if (!nome || preco == null || preco < 0) {\n    return res.status(400).json({ error: 'nome e preco (>= 0) sao obrigatorios' });\n  }\n  const produto: Produto = { id: Date.now().toString(), nome, preco };\n  produtos.push(produto);\n  res.status(201).json(produto);\n});\n\napp.get('/produtos/:id', (req, res) => {\n  const produto = produtos.find(p => p.id === req.params.id);\n  if (!produto) return res.status(404).json({ error: 'produto nao encontrado' });\n  res.json(produto);\n});\n\napp.delete('/produtos/:id', (req, res) => {\n  const idx = produtos.findIndex(p => p.id === req.params.id);\n  if (idx === -1) return res.status(404).json({ error: 'produto nao encontrado' });\n  const [removido] = produtos.splice(idx, 1);\n  res.json({ removed: removido });\n});\n\nconst port = Number(process.env.PORT ?? 3000);\napp.listen(port, () => {\n  console.log(`API rodando na porta ${port}`);\n});"
    },
    "notes": [
      "Network.WAF no Azure gera uma ApplicationGatewayWebApplicationFirewallPolicies (WAF Policy standalone). Ela NAO e automaticamente associada ao Container App — para trafego real ser filtrado, precisa de um Azure Application Gateway WAF_v2 ou Azure Front Door Premium como ponto de entrada; o synth nao cria esse gateway automaticamente.",
      "managedGroup aceita nomes AWS (ex: 'AWSManagedRulesCommonRuleSet') — o synth mapeia para OWASP 3.2 no Azure. Nao e necessario usar nomenclatura Azure nativa nos props.",
      "O campo scope ('REGIONAL'/'CLOUDFRONT') e ignorado no Azure — toda WAF Policy do App Gateway e regional por definicao. Omitir o campo nao causa erro.",
      "mode: 'Prevention' e o default no synth Azure — em 'Detection' o WAF apenas loga sem bloquear, nunca use Detection em producao sem monitoramento ativo dos logs de diagnostico.",
      "Bot protection via 'AWSManagedRulesBotControlRuleSet' mapeia para Microsoft_BotManagerRuleSet 1.0 no synth — cobre bots maliciosos mas nao substitui solucoes anti-DDoS dedicadas."
    ]
  },
  {
    "id": "azure-network-waf-2",
    "title": "WAF com regras customizadas de IP e protecao SQLi",
    "provider": "azure",
    "constructs": [
      "Network.WAF",
      "Compute.Container",
      "Database.SQL"
    ],
    "tags": [
      "azure",
      "waf",
      "custom-rules",
      "sqli",
      "ip-block",
      "container-app",
      "postgres"
    ],
    "validated": false,
    "stacks": {
      "stacks/network/waf-custom-rules.ts": "import { Stack, Network, Compute, Database, ref } from '@iacmp/core';\n\nconst stack = new Stack('waf-custom-rules');\n\nnew Database.SQL(stack, 'AppDB', {\n  engine: 'postgres',\n  instanceType: 'small',\n});\n\nnew Compute.Container(stack, 'SecureApi', {\n  image: 'node:20-alpine',\n  port: 3000,\n  cpu: 0.5,\n  memory: 1024,\n  environment: {\n    NODE_ENV: 'production',\n    PORT: '3000',\n    DB_HOST: ref('AppDB', 'Endpoint'),\n    DB_USER: ref('AppDB', 'Username'),\n    DB_PASSWORD: ref('AppDB', 'Password'),\n    DB_NAME: 'postgres',\n  },\n});\n\nnew Network.WAF(stack, 'SecureApiWAF', {\n  mode: 'Prevention',\n  defaultAction: 'allow',\n  description: 'WAF com bloqueio de IPs maliciosos e protecao SQLi',\n  rules: [\n    {\n      name: 'block-abuse-ips',\n      priority: 1,\n      action: 'block',\n      matchValues: ['198.51.100.0/24', '203.0.113.0/24'],\n      description: 'Bloqueia faixas RFC 5737 usadas em abuso e pen-test',\n    },\n    {\n      name: 'sqli-protection',\n      priority: 10,\n      managedGroup: 'AWSManagedRulesSQLiRuleSet',\n    },\n    {\n      name: 'owasp-common',\n      priority: 20,\n      managedGroup: 'AWSManagedRulesCommonRuleSet',\n    },\n    {\n      name: 'ip-reputation',\n      priority: 30,\n      managedGroup: 'AWSManagedRulesAmazonIpReputationList',\n    },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/secureApiHandler.ts": "import express from 'express';\nimport { Client } from 'pg';\n\nconst app = express();\napp.use(express.json());\n\nconst db = new Client({\n  host: process.env.DB_HOST,\n  user: process.env.DB_USER,\n  password: process.env.DB_PASSWORD,\n  database: process.env.DB_NAME ?? 'postgres',\n  ssl: { rejectUnauthorized: false },\n});\n\ndb.connect().catch(err => {\n  console.error('Falha ao conectar no banco:', err.message);\n  process.exit(1);\n});\n\nasync function ensureTable() {\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS registros (\n      id SERIAL PRIMARY KEY,\n      chave TEXT NOT NULL,\n      valor TEXT NOT NULL,\n      criado_em TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n}\n\napp.get('/health', (_req, res) => {\n  res.json({ status: 'ok', timestamp: new Date().toISOString() });\n});\n\napp.get('/registros', async (_req, res) => {\n  try {\n    await ensureTable();\n    const result = await db.query('SELECT * FROM registros ORDER BY criado_em DESC');\n    res.json({ data: result.rows, total: result.rowCount });\n  } catch (err) {\n    console.error('Erro ao listar registros:', err);\n    res.status(500).json({ error: 'erro ao listar registros' });\n  }\n});\n\napp.post('/registros', async (req, res) => {\n  const { chave, valor } = req.body as { chave?: string; valor?: string };\n  if (!chave || !valor) {\n    return res.status(400).json({ error: 'chave e valor sao obrigatorios' });\n  }\n  try {\n    await ensureTable();\n    const result = await db.query(\n      'INSERT INTO registros (chave, valor) VALUES ($1, $2) RETURNING *',\n      [chave, valor]\n    );\n    res.status(201).json(result.rows[0]);\n  } catch (err) {\n    console.error('Erro ao criar registro:', err);\n    res.status(500).json({ error: 'erro ao criar registro' });\n  }\n});\n\napp.get('/registros/:id', async (req, res) => {\n  const id = Number(req.params.id);\n  if (Number.isNaN(id)) return res.status(400).json({ error: 'id invalido' });\n  try {\n    await ensureTable();\n    const result = await db.query('SELECT * FROM registros WHERE id = $1', [id]);\n    if (result.rowCount === 0) return res.status(404).json({ error: 'nao encontrado' });\n    res.json(result.rows[0]);\n  } catch (err) {\n    console.error('Erro ao buscar registro:', err);\n    res.status(500).json({ error: 'erro ao buscar registro' });\n  }\n});\n\napp.delete('/registros/:id', async (req, res) => {\n  const id = Number(req.params.id);\n  if (Number.isNaN(id)) return res.status(400).json({ error: 'id invalido' });\n  try {\n    await ensureTable();\n    const result = await db.query('DELETE FROM registros WHERE id = $1 RETURNING *', [id]);\n    if (result.rowCount === 0) return res.status(404).json({ error: 'nao encontrado' });\n    res.json({ removed: result.rows[0] });\n  } catch (err) {\n    console.error('Erro ao deletar registro:', err);\n    res.status(500).json({ error: 'erro ao deletar registro' });\n  }\n});\n\nconst port = Number(process.env.PORT ?? 3000);\napp.listen(port, () => {\n  console.log(`SecureAPI rodando na porta ${port}`);\n});"
    },
    "notes": [
      "matchValues aceita APENAS CIDRs validos (ex: '198.51.100.0/24') — strings como 'IP', 'any', 'UNKNOWN' ou nomes de pais causam InvalidCustomRule no ARM e o deploy falha sem mensagem clara.",
      "O synth Azure usa sempre variableName: 'RemoteAddr' com operator: 'IPMatch' para custom rules — outras variaveis de match (RequestUri, QueryString, RequestHeaders) nao sao suportadas pelo synth atual e exigem extensao do constructs/network.ts no provider Azure.",
      "Custom rules com priority menor sao avaliadas PRIMEIRO pelo App Gateway WAF — coloque bloqueios de IP em priority baixa (1-5) para garantir execucao antes das managed rules.",
      "action: 'count' no Azure WAF corresponde a Log na WAF Policy — o trafego nao e bloqueado. Use 'block' em producao para qualquer regra que deva rejeitar requisicoes.",
      "Policy.IAM NAO deve ser gerada para Database.SQL no Azure — o acesso ao Flexible Server e autenticado via usuario/senha injetados como environment vars pelo Container Apps, sem IAM.",
      "DB_USER: ref('AppDB', 'Username') retorna 'dbadmin' (admin real do Flexible Server) — NUNCA hardcode 'postgres' ou 'admin', que nao existem como login no Flexible Server Azure.",
      "ssl: { rejectUnauthorized: false } e obrigatorio no driver pg para Azure Flexible Server — o certificado e autoassinado na cadeia interna e rejeita conexoes sem essa flag."
    ]
  },
  {
    "id": "azure-queue-email-sender",
    "title": "Azure Service Bus Queue — fila de envio de emails assíncronos",
    "provider": "azure",
    "constructs": [
      "Messaging.Queue",
      "Fn.Lambda"
    ],
    "tags": [
      "service-bus",
      "queue",
      "email",
      "async",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/email-queue-stack.ts": "import { Stack, Messaging, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('email-queue-stack');\n\nnew Messaging.Queue(stack, 'EmailQueue', {\n  visibilityTimeoutSeconds: 60,\n  messageRetentionSeconds: 86400,\n});\n\nnew Fn.Lambda(stack, 'EmailEnqueueFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/enqueue-email.handler',\n  code: '.',\n  environment: {\n    EMAIL_QUEUE_CONNECTION_STRING: ref('EmailQueue', 'ConnectionString'),\n    QUEUE_NAME: 'EmailQueue',\n  },\n});\n\nnew Fn.Lambda(stack, 'EmailWorkerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/email-worker.handler',\n  code: '.',\n  eventSources: [{ queueId: 'EmailQueue' }],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/enqueue-email.ts": "import { ServiceBusClient } from '@azure/service-bus';\n\nexport async function handler(event: any) {\n  const payload = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const { to, subject, body: text, templateId } = payload;\n\n  if (!to || !subject) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'to e subject são obrigatórios' }) };\n  }\n\n  const client = new ServiceBusClient(process.env.EMAIL_QUEUE_CONNECTION_STRING!);\n  const sender = client.createSender(process.env.QUEUE_NAME!);\n  try {\n    await sender.sendMessages({\n      body: JSON.stringify({ to, subject, text: text ?? '', templateId, enqueuedAt: new Date().toISOString() }),\n    });\n    return { statusCode: 202, body: JSON.stringify({ enqueued: true, to }) };\n  } finally {\n    await sender.close();\n    await client.close();\n  }\n}",
      "src/email-worker.ts": "export async function handler(event: any) {\n  for (const record of event.Records ?? []) {\n    const msg = JSON.parse(record.body) as {\n      to: string;\n      subject: string;\n      text: string;\n      templateId?: string;\n      enqueuedAt: string;\n    };\n\n    const delay = Date.now() - new Date(msg.enqueuedAt).getTime();\n    console.log(`Enviando email para ${msg.to} | assunto: \"${msg.subject}\" | delay: ${delay}ms`);\n\n    // integração real com provider de email (SendGrid, Resend, etc.)\n    // await sendgrid.send({ to: msg.to, subject: msg.subject, text: msg.text });\n  }\n  return { statusCode: 200, body: '' };\n}"
    },
    "notes": [
      "Produtor usa @azure/service-bus: ServiceBusClient(process.env.EMAIL_QUEUE_CONNECTION_STRING!) — NUNCA @azure/data-tables",
      "QUEUE_NAME na environment é string literal 'EmailQueue' (construct.id) — NUNCA concatenar com ref()",
      "Consumidor lê event.Records[].body — não abre ServiceBusReceiver; o runtime faz o poll e entrega",
      "Policy.IAM desnecessária no Azure: a connection string já autentica produtor e consumidor",
      "npm install @azure/service-bus (somente no produtor)"
    ]
  },
  {
    "id": "azure-queue-order-processing",
    "title": "Azure Service Bus Queue — processamento de pedidos com retry",
    "provider": "azure",
    "constructs": [
      "Messaging.Queue",
      "Fn.Lambda"
    ],
    "tags": [
      "service-bus",
      "queue",
      "orders",
      "retry",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/order-queue-stack.ts": "import { Stack, Messaging, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('order-queue-stack');\n\nnew Messaging.Queue(stack, 'OrderQueue', {\n  visibilityTimeoutSeconds: 120,\n  messageRetentionSeconds: 604800,\n  maxReceiveCount: 3,\n});\n\nnew Fn.Lambda(stack, 'ReceiveOrderFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/receive-order.handler',\n  code: '.',\n  environment: {\n    ORDER_QUEUE_CONNECTION_STRING: ref('OrderQueue', 'ConnectionString'),\n    QUEUE_NAME: 'OrderQueue',\n  },\n});\n\nnew Fn.Lambda(stack, 'ProcessOrderFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/process-order.handler',\n  code: '.',\n  timeout: 60,\n  eventSources: [{ queueId: 'OrderQueue' }],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/receive-order.ts": "import { ServiceBusClient } from '@azure/service-bus';\n\nexport async function handler(event: any) {\n  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const { orderId, customerId, items, total } = body;\n\n  if (!orderId || !customerId || !Array.isArray(items) || items.length === 0) {\n    return {\n      statusCode: 400,\n      body: JSON.stringify({ error: 'orderId, customerId e items são obrigatórios' }),\n    };\n  }\n\n  const client = new ServiceBusClient(process.env.ORDER_QUEUE_CONNECTION_STRING!);\n  const sender = client.createSender(process.env.QUEUE_NAME!);\n  try {\n    await sender.sendMessages({\n      body: JSON.stringify({ orderId, customerId, items, total: total ?? 0, receivedAt: new Date().toISOString() }),\n    });\n    return { statusCode: 202, body: JSON.stringify({ queued: true, orderId }) };\n  } finally {\n    await sender.close();\n    await client.close();\n  }\n}",
      "src/process-order.ts": "export async function handler(event: any) {\n  for (const record of event.Records ?? []) {\n    const order = JSON.parse(record.body) as {\n      orderId: string;\n      customerId: string;\n      items: Array<{ productId: string; qty: number; price: number }>;\n      total: number;\n      receivedAt: string;\n    };\n\n    const { orderId, customerId, items, total } = order;\n\n    for (const item of items) {\n      if (!item.productId || item.qty <= 0) {\n        // throw ativa retry automático do Service Bus (maxReceiveCount = 3)\n        throw new Error(`Item inválido no pedido ${orderId}: ${JSON.stringify(item)}`);\n      }\n    }\n\n    const itemCount = items.reduce((acc, i) => acc + i.qty, 0);\n    console.log(`Pedido ${orderId} | cliente ${customerId} | ${itemCount} itens | R$${total}`);\n\n    // integração real: reservar estoque, acionar pagamento, etc.\n    // await reserveStock(items);\n    // await triggerPayment({ orderId, customerId, total });\n  }\n  return { statusCode: 200, body: '' };\n}"
    },
    "notes": [
      "Produtor usa @azure/service-bus: ServiceBusClient(process.env.ORDER_QUEUE_CONNECTION_STRING!) — NUNCA @aws-sdk/client-sqs",
      "maxReceiveCount: 3 ativa retry automático do Service Bus; consumidor faz throw para re-enfileirar em caso de falha",
      "QUEUE_NAME na environment é string literal 'OrderQueue' — NUNCA ref() concatenado com string",
      "Consumidor não abre ServiceBusReceiver — o runtime do iacmp entrega Records no mesmo formato SQS",
      "npm install @azure/service-bus (somente no produtor)"
    ]
  },
  {
    "id": "azure-queue-pdf-generation",
    "title": "Azure Service Bus Queue — fila de geração de PDFs",
    "provider": "azure",
    "constructs": [
      "Messaging.Queue",
      "Fn.Lambda"
    ],
    "tags": [
      "service-bus",
      "queue",
      "pdf",
      "worker",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/pdf-queue-stack.ts": "import { Stack, Messaging, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('pdf-queue-stack');\n\nnew Messaging.Queue(stack, 'PdfQueue', {\n  visibilityTimeoutSeconds: 300,\n  messageRetentionSeconds: 172800,\n});\n\nnew Fn.Lambda(stack, 'RequestPdfFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/request-pdf.handler',\n  code: '.',\n  environment: {\n    PDF_QUEUE_CONNECTION_STRING: ref('PdfQueue', 'ConnectionString'),\n    QUEUE_NAME: 'PdfQueue',\n  },\n});\n\nnew Fn.Lambda(stack, 'PdfWorkerFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/pdf-worker.handler',\n  code: '.',\n  timeout: 180,\n  memory: 512,\n  eventSources: [{ queueId: 'PdfQueue' }],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/request-pdf.ts": "import { ServiceBusClient } from '@azure/service-bus';\n\nexport async function handler(event: any) {\n  const payload = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const { documentId, type, data, callbackUrl } = payload;\n\n  if (!documentId || !type || !data) {\n    return {\n      statusCode: 400,\n      body: JSON.stringify({ error: 'documentId, type e data são obrigatórios' }),\n    };\n  }\n\n  const client = new ServiceBusClient(process.env.PDF_QUEUE_CONNECTION_STRING!);\n  const sender = client.createSender(process.env.QUEUE_NAME!);\n  try {\n    await sender.sendMessages({\n      body: JSON.stringify({ documentId, type, data, callbackUrl, requestedAt: new Date().toISOString() }),\n    });\n    return { statusCode: 202, body: JSON.stringify({ queued: true, documentId }) };\n  } finally {\n    await sender.close();\n    await client.close();\n  }\n}",
      "src/pdf-worker.ts": "export async function handler(event: any) {\n  for (const record of event.Records ?? []) {\n    const job = JSON.parse(record.body) as {\n      documentId: string;\n      type: string;\n      data: Record<string, unknown>;\n      callbackUrl?: string;\n      requestedAt: string;\n    };\n\n    const { documentId, type, data, callbackUrl } = job;\n    const lag = Date.now() - new Date(job.requestedAt).getTime();\n\n    console.log(`Gerando PDF | documentId=${documentId} | type=${type} | lag=${lag}ms`);\n\n    // integração real: gerar PDF com pdfkit, puppeteer, html-pdf-node, etc.\n    // const pdfBuffer = await generatePdf(type, data);\n    // await uploadToBlob(documentId, pdfBuffer);\n    // const pdfUrl = `https://<storage>.blob.core.windows.net/pdfs/${documentId}.pdf`;\n\n    if (callbackUrl) {\n      console.log(`Notificando callback: ${callbackUrl} | documentId=${documentId}`);\n      // await fetch(callbackUrl, { method: 'POST', body: JSON.stringify({ documentId, status: 'ready' }) });\n    }\n  }\n  return { statusCode: 200, body: '' };\n}"
    },
    "notes": [
      "Produtor usa @azure/service-bus: ServiceBusClient(process.env.PDF_QUEUE_CONNECTION_STRING!) — NUNCA @azure/data-tables",
      "QUEUE_NAME na environment é string literal 'PdfQueue' (construct.id) — valores de environment são ref() ou strings literais, NUNCA process.env.X",
      "Worker com timeout: 180s e memory: 512MB para acomodar geração de PDF pesada",
      "Consumidor lê event.Records[].body — não abre ServiceBusReceiver; callbackUrl notifica o solicitante após geração",
      "npm install @azure/service-bus (somente no produtor)"
    ]
  },
  {
    "id": "azure-secret-vault-1",
    "title": "Key Vault simples com Container App lendo secret via SDK",
    "provider": "azure",
    "constructs": [
      "Secret.Vault",
      "Fn.Lambda",
      "Fn.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "azure",
      "keyvault",
      "secret",
      "container-app",
      "managed-identity",
      "rbac"
    ],
    "validated": false,
    "stacks": {
      "stacks/secret/vault-simples.ts": "import { Stack, Secret, Fn, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('vault-simples', { provider: 'azure' });\n\nconst vault = new Secret.Vault(stack, 'AppVault', {\n  description: 'Vault de segredos da aplicacao'\n});\n\nconst api = new Fn.Lambda(stack, 'ApiApp', {\n  runtime: 'nodejs20',\n  handler: 'src/secretHandler.handler',\n  code: 'src/',\n  environment: {\n    KV_URL: ref('AppVault', 'VaultUri')\n  }\n});\n\nnew Fn.ApiGateway(stack, 'ApiGw', {\n  name: 'vault-api',\n  stageName: 'api',\n  cors: true,\n  routes: [\n    { method: 'GET', path: '/secret', lambdaId: 'ApiApp' }\n  ]\n});\n\nnew Policy.IAM(stack, 'ApiVaultPolicy', {\n  attachTo: 'ApiApp',\n  attachType: 'compute',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['keyvault:getSecret'],\n      resources: [ref('AppVault', 'Arn')]\n    }\n  ]\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/secretHandler.ts": "import { SecretClient } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\n\nconst credential = new DefaultAzureCredential();\nlet secretClient: SecretClient | null = null;\n\nfunction getClient(): SecretClient {\n  if (!secretClient) {\n    const kvUrl = process.env.KV_URL;\n    if (!kvUrl) throw new Error('KV_URL nao definido');\n    secretClient = new SecretClient(kvUrl, credential);\n  }\n  return secretClient;\n}\n\nexport async function handler(req: any, res: any): Promise<void> {\n  try {\n    const client = getClient();\n    const secret = await client.getSecret('secret-value');\n    // Usa o valor do secret para chamar API externa\n    const response = await fetch('https://api.parceiro.com/dados', {\n      headers: { Authorization: `Bearer ${secret.value}` }\n    });\n    if (!response.ok) {\n      res.status(502).json({ error: 'Erro ao chamar API parceiro' });\n      return;\n    }\n    const data = await response.json();\n    res.json({ ok: true, data });\n  } catch (err: any) {\n    res.status(500).json({ error: err.message });\n  }\n}"
    },
    "notes": [
      "O atributo correto para a URL do Key Vault é 'VaultUri', NÃO 'Endpoint'. ref('AppVault','Endpoint') resolve para o ARM resource ID (ex: /subscriptions/.../vaults/kv-xxx), que é inválido como URL para o SDK.",
      "O synth cria automaticamente apenas UM secret chamado 'secret-value' com valor base64 aleatório. Não é possível configurar múltiplos secrets diferentes via props do construct.",
      "O Key Vault é criado com enableRbacAuthorization: true — acesso via RBAC, não access policies legadas. Isso é obrigatório para Policy.IAM funcionar.",
      "DefaultAzureCredential no Container App usa automaticamente a Managed Identity do Container App Environment — sem necessidade de configurar AZURE_CLIENT_ID/SECRET.",
      "Inicializar SecretClient fora do handler (singleton) é crítico — instanciar a cada request causa overhead de autenticação e pode resultar em throttling do Azure AD."
    ]
  },
  {
    "id": "azure-secret-vault-2",
    "title": "Stack multi-serviço com dois Key Vaults para secrets distintos",
    "provider": "azure",
    "constructs": [
      "Secret.Vault",
      "Fn.Lambda",
      "Fn.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "azure",
      "keyvault",
      "multi-vault",
      "container-app",
      "secrets-segregation"
    ],
    "validated": false,
    "stacks": {
      "stacks/secret/vault-multi.ts": "import { Stack, Secret, Fn, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('vault-multi', { provider: 'azure' });\n\n// Vault de credenciais de integracao (ex: chaves de API externas)\nnew Secret.Vault(stack, 'IntegVault', {\n  description: 'Credenciais de integracoes externas'\n});\n\n// Vault de tokens internos (ex: JWT signing key)\nnew Secret.Vault(stack, 'TokenVault', {\n  description: 'Tokens e chaves internas da aplicacao'\n});\n\nnew Fn.Lambda(stack, 'IntegService', {\n  runtime: 'nodejs20',\n  handler: 'src/integHandler.handler',\n  code: 'src/',\n  environment: {\n    INTEG_KV_URL: ref('IntegVault', 'VaultUri')\n  }\n});\n\nnew Fn.Lambda(stack, 'AuthService', {\n  runtime: 'nodejs20',\n  handler: 'src/authHandler.handler',\n  code: 'src/',\n  environment: {\n    TOKEN_KV_URL: ref('TokenVault', 'VaultUri')\n  }\n});\n\nnew Fn.ApiGateway(stack, 'MultiApi', {\n  name: 'multi-vault-api',\n  stageName: 'api',\n  cors: true,\n  routes: [\n    { method: 'POST', path: '/sync', lambdaId: 'IntegService' },\n    { method: 'POST', path: '/auth/token', lambdaId: 'AuthService' }\n  ]\n});\n\n// Cada servico acessa apenas seu proprio vault (principio do menor privilegio)\nnew Policy.IAM(stack, 'IntegVaultPolicy', {\n  attachTo: 'IntegService',\n  attachType: 'compute',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['keyvault:getSecret'],\n      resources: [ref('IntegVault', 'Arn')]\n    }\n  ]\n});\n\nnew Policy.IAM(stack, 'TokenVaultPolicy', {\n  attachTo: 'AuthService',\n  attachType: 'compute',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['keyvault:getSecret'],\n      resources: [ref('TokenVault', 'Arn')]\n    }\n  ]\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/integHandler.ts": "import { SecretClient } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\n\nconst credential = new DefaultAzureCredential();\nlet integClient: SecretClient | null = null;\n\nfunction getIntegClient(): SecretClient {\n  if (!integClient) {\n    const url = process.env.INTEG_KV_URL;\n    if (!url) throw new Error('INTEG_KV_URL nao definido');\n    integClient = new SecretClient(url, credential);\n  }\n  return integClient;\n}\n\nexport async function handler(req: any, res: any): Promise<void> {\n  try {\n    const client = getIntegClient();\n    // Busca credencial de integracao armazenada como 'secret-value'\n    const apiKeySecret = await client.getSecret('secret-value');\n    const apiKey = apiKeySecret.value!;\n\n    // Dispara sincronizacao com sistema externo\n    const body = req.body as { payload: unknown };\n    const resp = await fetch('https://erp.empresa.com/api/sync', {\n      method: 'POST',\n      headers: {\n        'Content-Type': 'application/json',\n        'X-Api-Key': apiKey\n      },\n      body: JSON.stringify(body.payload)\n    });\n\n    if (!resp.ok) {\n      const text = await resp.text();\n      res.status(502).json({ error: 'Falha na sincronizacao', detail: text });\n      return;\n    }\n\n    const result = await resp.json();\n    res.json({ ok: true, syncId: result.id });\n  } catch (err: any) {\n    res.status(500).json({ error: err.message });\n  }\n}",
      "src/authHandler.ts": "import { SecretClient } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\nimport { createHmac } from 'crypto';\n\nconst credential = new DefaultAzureCredential();\nlet tokenClient: SecretClient | null = null;\n\nfunction getTokenClient(): SecretClient {\n  if (!tokenClient) {\n    const url = process.env.TOKEN_KV_URL;\n    if (!url) throw new Error('TOKEN_KV_URL nao definido');\n    tokenClient = new SecretClient(url, credential);\n  }\n  return tokenClient;\n}\n\nexport async function handler(req: any, res: any): Promise<void> {\n  try {\n    const client = getTokenClient();\n    // JWT signing key armazenada como 'secret-value'\n    const signingKeySecret = await client.getSecret('secret-value');\n    const signingKey = signingKeySecret.value!;\n\n    const { userId, scope } = req.body as { userId: string; scope: string };\n    if (!userId || !scope) {\n      res.status(400).json({ error: 'userId e scope sao obrigatorios' });\n      return;\n    }\n\n    const payload = Buffer.from(JSON.stringify({\n      sub: userId,\n      scope,\n      iat: Math.floor(Date.now() / 1000),\n      exp: Math.floor(Date.now() / 1000) + 3600\n    })).toString('base64url');\n\n    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');\n    const sig = createHmac('sha256', signingKey)\n      .update(`${header}.${payload}`)\n      .digest('base64url');\n\n    res.json({ token: `${header}.${payload}.${sig}` });\n  } catch (err: any) {\n    res.status(500).json({ error: err.message });\n  }\n}"
    },
    "notes": [
      "Cada Secret.Vault gera um Key Vault separado com nome único via uniqueString — é seguro e recomendado criar múltiplos vaults por stack para isolamento de acesso.",
      "Separar vaults por responsabilidade (integrações vs tokens internos) permite aplicar Policy.IAM granular: IntegService não acessa TokenVault e vice-versa.",
      "O nome do KV gerado pelo synth segue o padrão 'kv-{id7chars}-{uniqueString}' totalizando no máximo 24 chars — nunca defina nome manualmente, o synth já garante unicidade global.",
      "Ambos os vaults criam um único secret 'secret-value' com valor aleatório. Para seeds de dados diferentes, altere o valor via az keyvault secret set após o deploy — nunca via Custom.Resource.",
      "DefaultAzureCredential compartilhada entre handlers é seguro: o objeto é thread-safe e faz cache interno do token, reduzindo chamadas ao Azure AD."
    ]
  },
  {
    "id": "azure-secret-vault-3",
    "title": "Key Vault com Policy.IAM usando dataActions explícitos para acesso SDK",
    "provider": "azure",
    "constructs": [
      "Secret.Vault",
      "Fn.Lambda",
      "Fn.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "azure",
      "keyvault",
      "policy-iam",
      "dataactions",
      "rbac",
      "data-plane"
    ],
    "validated": false,
    "stacks": {
      "stacks/secret/vault-dataactions.ts": "import { Stack, Secret, Fn, Policy, ref } from '@iacmp/core';\n\nconst stack = new Stack('vault-dataactions', { provider: 'azure' });\n\nnew Secret.Vault(stack, 'CredVault', {\n  description: 'Vault de credenciais sensiveis'\n});\n\nnew Fn.Lambda(stack, 'CredService', {\n  runtime: 'nodejs20',\n  handler: 'src/credHandler.handler',\n  code: 'src/',\n  environment: {\n    KV_URL: ref('CredVault', 'VaultUri'),\n    KV_NAME: ref('CredVault', 'Name')\n  }\n});\n\nnew Fn.ApiGateway(stack, 'CredApi', {\n  name: 'cred-api',\n  stageName: 'api',\n  cors: true,\n  routes: [\n    { method: 'GET', path: '/credentials', lambdaId: 'CredService' },\n    { method: 'GET', path: '/credentials/health', lambdaId: 'CredService' }\n  ]\n});\n\n// CORRETO: usar prefixo 'keyvault:' — o synth converte para dataActions automaticamente\n// ERRADO: usar 'Microsoft.KeyVault/vaults/secrets/getSecret/action' diretamente\n// (o synth so detecta acoes que comecem com 'keyvault:' ou 'secretsmanager:')\nnew Policy.IAM(stack, 'CredVaultPolicy', {\n  attachTo: 'CredService',\n  attachType: 'compute',\n  description: 'Permite leitura de secrets no data plane do Key Vault',\n  statements: [\n    {\n      effect: 'Allow',\n      actions: ['keyvault:getSecret'],\n      resources: [ref('CredVault', 'Arn')]\n    }\n  ]\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/credHandler.ts": "import { SecretClient, KeyVaultSecret } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\n\nconst credential = new DefaultAzureCredential();\nlet client: SecretClient | null = null;\n\nfunction getClient(): SecretClient {\n  if (!client) {\n    const url = process.env.KV_URL;\n    if (!url) throw new Error('KV_URL nao definido');\n    client = new SecretClient(url, credential);\n  }\n  return client;\n}\n\nasync function getSecretSafe(name: string): Promise<string | null> {\n  try {\n    const secret: KeyVaultSecret = await getClient().getSecret(name);\n    return secret.value ?? null;\n  } catch (err: any) {\n    // 403 = sem permissao (Policy.IAM nao aplicada ainda ou propagacao pendente)\n    // 404 = secret nao existe (ainda nao foi seed apos deploy)\n    if (err.statusCode === 403 || err.statusCode === 404) return null;\n    throw err;\n  }\n}\n\nexport async function handler(req: any, res: any): Promise<void> {\n  const path = (req.path as string) ?? '/';\n\n  if (path.endsWith('/health')) {\n    // Health check sem acesso ao vault\n    res.json({\n      ok: true,\n      vault: process.env.KV_NAME,\n      vaultUrl: process.env.KV_URL\n    });\n    return;\n  }\n\n  try {\n    // O synth auto-cria o secret 'secret-value' com valor base64 aleatorio\n    const value = await getSecretSafe('secret-value');\n    if (value === null) {\n      res.status(503).json({\n        error: 'Secret nao disponivel',\n        hint: 'Verifique Policy.IAM e aguarde propagacao do RBAC (pode levar ate 5 min)'\n      });\n      return;\n    }\n\n    // Demonstra uso do valor: retorna hash, nao o valor bruto\n    const { createHash } = await import('crypto');\n    const fingerprint = createHash('sha256').update(value).digest('hex').slice(0, 8);\n\n    res.json({\n      ok: true,\n      secretName: 'secret-value',\n      fingerprint,\n      vault: process.env.KV_NAME\n    });\n  } catch (err: any) {\n    res.status(500).json({ error: err.message });\n  }\n}"
    },
    "notes": [
      "CRITICO — dataActions vs actions: Key Vault secret read é operacao de DATA PLANE, exige 'dataActions' no roleDefinition Bicep, NÃO 'actions'. Se usar 'actions' com 'Microsoft.KeyVault/vaults/secrets/getSecret/action', a role e criada mas o SDK recebe 403 em runtime.",
      "O synth detecta automaticamente o prefixo 'keyvault:' e converte para dataActions: 'Microsoft.KeyVault/vaults/secrets/getSecret/action'. Nunca coloque a action Azure completa diretamente no Policy.IAM — ela cai no fallback 'Microsoft.Resources/subscriptions/resourceGroups/read' e nao funciona.",
      "Propagacao do RBAC no Azure pode levar ate 5 minutos apos o deploy. O handler deve tratar 403 graciosamente (nao como erro fatal) nas primeiras chamadas pos-deploy.",
      "ref('CredVault', 'Name') resolve para o nome gerado do KV (ex: 'kv-credvau-abc123') — util para exibir no health check ou logs sem expor a URL completa.",
      "O Key Vault e criado com enableSoftDelete: false — em producao real considere habilitar para prevenir delecao acidental, mas isso requer configuracao manual pos-deploy pois o construct nao expoe essa prop."
    ]
  },
  {
    "id": "azure-sql-analytics",
    "title": "Azure PostgreSQL — agregações e relatórios analíticos",
    "provider": "azure",
    "constructs": [
      "Database.SQL",
      "Function.Lambda"
    ],
    "tags": [
      "sql",
      "postgresql",
      "analytics",
      "reports",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/analytics-stack.ts": "import { Stack, Fn, Database, ref } from '@iacmp/core';\n\nconst stack = new Stack('analytics-reports');\n\nnew Database.SQL(stack, 'AppDB', { engine: 'postgres', size: 'small' });\n\nnew Fn.Lambda(stack, 'AnalyticsApiFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/analytics.handler',\n  code: '.',\n  environment: {\n    DB_HOST: ref('AppDB', 'Endpoint'),\n    DB_PORT: ref('AppDB', 'Port'),\n    DB_USER: ref('AppDB', 'Username'),\n    DB_PASSWORD: ref('AppDB', 'Password'),\n    DB_NAME: 'postgres',\n  },\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/analytics.ts": "import { Client } from 'pg';\n\nasync function getClient() {\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS events (\n      id SERIAL PRIMARY KEY,\n      event_type TEXT NOT NULL,\n      user_id TEXT,\n      amount NUMERIC(10,2),\n      metadata JSONB,\n      occurred_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n  return db;\n}\n\nexport async function handler(event: any) {\n  const method = event.httpMethod ?? event.method ?? 'GET';\n  const path = event.path ?? event.rawPath ?? '';\n  const qs = event.queryStringParameters ?? {};\n  const body = event.body\n    ? typeof event.body === 'string' ? JSON.parse(event.body) : event.body\n    : {};\n\n  const db = await getClient();\n\n  try {\n    if (method === 'POST' && path.endsWith('/events')) {\n      const { event_type, user_id, amount, metadata } = body;\n      if (!event_type) return { statusCode: 400, body: JSON.stringify({ error: 'event_type is required' }) };\n      const r = await db.query(\n        'INSERT INTO events (event_type, user_id, amount, metadata) VALUES ($1, $2, $3, $4) RETURNING *',\n        [event_type, user_id ?? null, amount ?? null, metadata ? JSON.stringify(metadata) : null]\n      );\n      return { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.rows[0]) };\n    }\n\n    if (method === 'GET' && path.endsWith('/by-type')) {\n      const r = await db.query(`\n        SELECT event_type, COUNT(*) AS total, COALESCE(SUM(amount), 0) AS revenue\n        FROM events\n        GROUP BY event_type\n        ORDER BY total DESC\n      `);\n      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.rows) };\n    }\n\n    if (method === 'GET' && path.endsWith('/by-day')) {\n      const days = parseInt(qs.days ?? '30', 10);\n      const r = await db.query(\n        `SELECT DATE(occurred_at) AS day, COUNT(*) AS total, COALESCE(SUM(amount), 0) AS revenue\n         FROM events\n         WHERE occurred_at >= NOW() - ($1 || ' days')::INTERVAL\n         GROUP BY day\n         ORDER BY day DESC`,\n        [days]\n      );\n      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.rows) };\n    }\n\n    if (method === 'GET' && path.endsWith('/top-users')) {\n      const limit = parseInt(qs.limit ?? '10', 10);\n      const r = await db.query(\n        `SELECT user_id, COUNT(*) AS events, COALESCE(SUM(amount), 0) AS total_amount\n         FROM events\n         WHERE user_id IS NOT NULL\n         GROUP BY user_id\n         ORDER BY total_amount DESC\n         LIMIT $1`,\n        [limit]\n      );\n      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.rows) };\n    }\n\n    if (method === 'GET' && (path.endsWith('/summary') || path.endsWith('/reports'))) {\n      const r = await db.query(`\n        SELECT\n          COUNT(*) AS total_events,\n          COUNT(DISTINCT user_id) AS unique_users,\n          COALESCE(SUM(amount), 0) AS total_revenue,\n          COALESCE(AVG(amount), 0) AS avg_amount,\n          MIN(occurred_at) AS first_event,\n          MAX(occurred_at) AS last_event\n        FROM events\n      `);\n      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.rows[0]) };\n    }\n\n    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };\n  } finally {\n    await db.end();\n  }\n}"
    },
    "notes": [
      "DB_NAME sempre 'postgres' — o PostgreSQL Flexible Server não cria bancos extras por padrão",
      "DB_USER via ref('AppDB','Username') — nunca hardcode do nome de usuário",
      "CREATE TABLE IF NOT EXISTS no cold start — o handler de ingestão e os de relatório criam a tabela se não existir",
      "ssl:{rejectUnauthorized:false} obrigatório no Azure PostgreSQL Flexible Server",
      "Queries parametrizadas ($1, $2...) — nunca interpolação de string com inputs externos",
      "Sem Policy.IAM — acesso ao PostgreSQL é por usuário/senha via env vars"
    ]
  },
  {
    "id": "azure-sql-orders-api",
    "title": "Azure PostgreSQL — API de pedidos com tabelas orders/items",
    "provider": "azure",
    "constructs": [
      "Database.SQL",
      "Function.Lambda"
    ],
    "tags": [
      "sql",
      "postgresql",
      "orders",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/orders-stack.ts": "import { Stack, Fn, Database, ref } from '@iacmp/core';\n\nconst stack = new Stack('orders-api');\n\nnew Database.SQL(stack, 'AppDB', { engine: 'postgres', size: 'small' });\n\nnew Fn.Lambda(stack, 'OrdersApiFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/orders.handler',\n  code: '.',\n  environment: {\n    DB_HOST: ref('AppDB', 'Endpoint'),\n    DB_PORT: ref('AppDB', 'Port'),\n    DB_USER: ref('AppDB', 'Username'),\n    DB_PASSWORD: ref('AppDB', 'Password'),\n    DB_NAME: 'postgres',\n  },\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/orders.ts": "import { Client } from 'pg';\n\nasync function getClient() {\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS orders (\n      id SERIAL PRIMARY KEY,\n      customer_name TEXT NOT NULL,\n      status TEXT NOT NULL DEFAULT 'pending',\n      total NUMERIC(10,2) NOT NULL DEFAULT 0,\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS order_items (\n      id SERIAL PRIMARY KEY,\n      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,\n      product_name TEXT NOT NULL,\n      quantity INTEGER NOT NULL DEFAULT 1,\n      unit_price NUMERIC(10,2) NOT NULL\n    )\n  `);\n  return db;\n}\n\nexport async function handler(event: any) {\n  const method = event.httpMethod ?? event.method ?? 'GET';\n  const path = event.path ?? event.rawPath ?? '';\n  const id = event.pathParameters?.id ?? path.split('/').filter(Boolean).pop();\n  const body = event.body\n    ? typeof event.body === 'string' ? JSON.parse(event.body) : event.body\n    : {};\n\n  const db = await getClient();\n\n  try {\n    if (method === 'GET' && id && path.includes('/items')) {\n      const r = await db.query('SELECT * FROM order_items WHERE order_id = $1', [id]);\n      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.rows) };\n    }\n\n    if (method === 'GET' && id) {\n      const r = await db.query('SELECT * FROM orders WHERE id = $1', [id]);\n      if (r.rows.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Order not found' }) };\n      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.rows[0]) };\n    }\n\n    if (method === 'GET') {\n      const r = await db.query('SELECT * FROM orders ORDER BY created_at DESC');\n      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.rows) };\n    }\n\n    if (method === 'POST') {\n      const { customer_name, items = [] } = body;\n      if (!customer_name) return { statusCode: 400, body: JSON.stringify({ error: 'customer_name is required' }) };\n\n      const orderRes = await db.query(\n        \"INSERT INTO orders (customer_name, status) VALUES ($1, 'pending') RETURNING *\",\n        [customer_name]\n      );\n      const order = orderRes.rows[0];\n\n      let total = 0;\n      for (const item of items) {\n        const { product_name, quantity = 1, unit_price } = item;\n        await db.query(\n          'INSERT INTO order_items (order_id, product_name, quantity, unit_price) VALUES ($1, $2, $3, $4)',\n          [order.id, product_name, quantity, unit_price]\n        );\n        total += quantity * unit_price;\n      }\n\n      await db.query('UPDATE orders SET total = $1 WHERE id = $2', [total, order.id]);\n      order.total = total;\n\n      return { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order) };\n    }\n\n    if (method === 'PATCH' && id) {\n      const { status } = body;\n      const r = await db.query(\n        'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',\n        [status, id]\n      );\n      if (r.rows.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Order not found' }) };\n      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.rows[0]) };\n    }\n\n    if (method === 'DELETE' && id) {\n      await db.query('DELETE FROM orders WHERE id = $1', [id]);\n      return { statusCode: 204, body: '' };\n    }\n\n    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };\n  } finally {\n    await db.end();\n  }\n}"
    },
    "notes": [
      "DB_NAME sempre 'postgres' — o PostgreSQL Flexible Server não cria bancos extras por padrão",
      "DB_USER via ref('AppDB','Username') — nunca hardcode do nome de usuário",
      "CREATE TABLE IF NOT EXISTS em todos os handlers — cold start pode ser o primeiro acesso",
      "ssl:{rejectUnauthorized:false} obrigatório — o servidor Azure exige TLS mas usa cert auto-assinado",
      "Sem Policy.IAM — acesso ao PostgreSQL é por usuário/senha via env vars, não IAM"
    ]
  },
  {
    "id": "azure-sql-users-auth",
    "title": "Azure PostgreSQL — autenticação de usuários com bcrypt",
    "provider": "azure",
    "constructs": [
      "Database.SQL",
      "Function.Lambda"
    ],
    "tags": [
      "sql",
      "postgresql",
      "auth",
      "users",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/auth-stack.ts": "import { Stack, Fn, Database, ref } from '@iacmp/core';\n\nconst stack = new Stack('users-auth');\n\nnew Database.SQL(stack, 'AppDB', { engine: 'postgres', size: 'small' });\n\nnew Fn.Lambda(stack, 'AuthApiFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/auth.handler',\n  code: '.',\n  environment: {\n    DB_HOST: ref('AppDB', 'Endpoint'),\n    DB_PORT: ref('AppDB', 'Port'),\n    DB_USER: ref('AppDB', 'Username'),\n    DB_PASSWORD: ref('AppDB', 'Password'),\n    DB_NAME: 'postgres',\n  },\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/auth.ts": "import { Client } from 'pg';\nimport * as bcrypt from 'bcrypt';\n\nconst SALT_ROUNDS = 10;\n\nasync function getClient() {\n  const db = new Client({\n    host: process.env.DB_HOST,\n    port: Number(process.env.DB_PORT ?? 5432),\n    user: process.env.DB_USER,\n    password: process.env.DB_PASSWORD,\n    database: process.env.DB_NAME ?? 'postgres',\n    ssl: { rejectUnauthorized: false },\n  });\n  await db.connect();\n  await db.query(`\n    CREATE TABLE IF NOT EXISTS users (\n      id SERIAL PRIMARY KEY,\n      email TEXT UNIQUE NOT NULL,\n      password_hash TEXT NOT NULL,\n      name TEXT,\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    )\n  `);\n  return db;\n}\n\nexport async function handler(event: any) {\n  const method = event.httpMethod ?? event.method ?? 'GET';\n  const path = event.path ?? event.rawPath ?? '';\n  const body = event.body\n    ? typeof event.body === 'string' ? JSON.parse(event.body) : event.body\n    : {};\n\n  const db = await getClient();\n\n  try {\n    if (method === 'POST' && path.endsWith('/register')) {\n      const { email, password, name } = body;\n      if (!email || !password) {\n        return { statusCode: 400, body: JSON.stringify({ error: 'email and password are required' }) };\n      }\n\n      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);\n      if (existing.rows.length > 0) {\n        return { statusCode: 409, body: JSON.stringify({ error: 'Email already registered' }) };\n      }\n\n      const password_hash = await bcrypt.hash(password, SALT_ROUNDS);\n      const r = await db.query(\n        'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',\n        [email, password_hash, name ?? null]\n      );\n\n      return { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.rows[0]) };\n    }\n\n    if (method === 'POST' && path.endsWith('/login')) {\n      const { email, password } = body;\n      if (!email || !password) {\n        return { statusCode: 400, body: JSON.stringify({ error: 'email and password are required' }) };\n      }\n\n      const r = await db.query('SELECT * FROM users WHERE email = $1', [email]);\n      if (r.rows.length === 0) {\n        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid credentials' }) };\n      }\n\n      const user = r.rows[0];\n      const valid = await bcrypt.compare(password, user.password_hash);\n      if (!valid) {\n        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid credentials' }) };\n      }\n\n      return {\n        statusCode: 200,\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ id: user.id, email: user.email, name: user.name }),\n      };\n    }\n\n    if (method === 'GET') {\n      const r = await db.query('SELECT id, email, name, created_at FROM users ORDER BY created_at DESC');\n      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.rows) };\n    }\n\n    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };\n  } finally {\n    await db.end();\n  }\n}"
    },
    "notes": [
      "DB_NAME sempre 'postgres' — o PostgreSQL Flexible Server não cria bancos extras por padrão",
      "DB_USER via ref('AppDB','Username') — nunca hardcode do nome de usuário",
      "CREATE TABLE IF NOT EXISTS na inicialização do client — evita 'relation does not exist' no primeiro cold start",
      "ssl:{rejectUnauthorized:false} obrigatório no Azure PostgreSQL Flexible Server",
      "password_hash nunca retorna ao cliente — SELECT retorna apenas id, email, name",
      "Sem Policy.IAM — autenticação é por usuário/senha via env vars"
    ]
  },
  {
    "id": "azure-topic-order-events",
    "title": "Azure Service Bus Topic — pub/sub de eventos de pedido",
    "provider": "azure",
    "constructs": [
      "Messaging.Topic",
      "Function.Lambda",
      "Function.ApiGateway"
    ],
    "tags": [
      "service-bus",
      "topic",
      "pubsub",
      "orders",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/messaging/order-events-topic-stack.ts": "import { Stack, Messaging } from '@iacmp/core';\n\nconst stack = new Stack('order-events-topic-stack');\n\nnew Messaging.Topic(stack, 'OrderEventsTopic', {\n  subscriptions: [\n    { name: 'inventory-sub', filterPolicy: { eventType: ['order.created', 'order.cancelled'] } },\n    { name: 'payment-sub', filterPolicy: { eventType: ['order.created'] } },\n    { name: 'notification-sub' },\n  ],\n});\n\nexport default stack;",
      "stacks/compute/order-publisher-stack.ts": "import { Stack, Fn, ref } from '@iacmp/core';\n\nconst stack = new Stack('order-publisher-stack');\n\nnew Fn.Lambda(stack, 'OrderPublisherFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/orderPublisher.handler',\n  code: '.',\n  environment: {\n    ORDER_EVENTS_TOPIC_CONNECTION_STRING: ref('OrderEventsTopic', 'ConnectionString'),\n    TOPIC_NAME: 'OrderEventsTopic',\n  },\n});\n\nnew Fn.Lambda(stack, 'InventorySubscriberFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/inventorySubscriber.handler',\n  code: '.',\n  environment: {\n    ORDER_EVENTS_TOPIC_CONNECTION_STRING: ref('OrderEventsTopic', 'ConnectionString'),\n    TOPIC_NAME: 'OrderEventsTopic',\n    SUBSCRIPTION_NAME: 'inventory-sub',\n  },\n});\n\nnew Fn.ApiGateway(stack, 'OrderApi', {\n  name: 'order-api',\n  type: 'HTTP',\n  cors: true,\n  routes: [\n    { method: 'POST', path: '/orders', lambdaId: 'OrderPublisherFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/orderPublisher.ts": "import { ServiceBusClient } from '@azure/service-bus';\n\nexport async function handler(event: any) {\n  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});\n  const { customerId, items, totalAmount } = body;\n\n  if (!customerId || !Array.isArray(items) || items.length === 0) {\n    return { statusCode: 400, body: JSON.stringify({ error: 'customerId e items são obrigatórios' }) };\n  }\n\n  const orderId = `ord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;\n  const orderEvent = {\n    orderId,\n    customerId,\n    items,\n    totalAmount: totalAmount ?? items.reduce((sum: number, i: any) => sum + (i.price * i.qty), 0),\n    eventType: 'order.created',\n    createdAt: new Date().toISOString(),\n  };\n\n  const client = new ServiceBusClient(process.env.ORDER_EVENTS_TOPIC_CONNECTION_STRING!);\n  const sender = client.createSender(process.env.TOPIC_NAME!);\n  try {\n    await sender.sendMessages({\n      body: JSON.stringify(orderEvent),\n      applicationProperties: { eventType: 'order.created' },\n    });\n  } finally {\n    await sender.close();\n    await client.close();\n  }\n\n  return { statusCode: 201, body: JSON.stringify({ orderId, status: 'created' }) };\n}",
      "src/inventorySubscriber.ts": "import { ServiceBusClient } from '@azure/service-bus';\n\nexport async function handler(event: any) {\n  const client = new ServiceBusClient(process.env.ORDER_EVENTS_TOPIC_CONNECTION_STRING!);\n  const receiver = client.createReceiver(process.env.TOPIC_NAME!, process.env.SUBSCRIPTION_NAME!);\n  const processed: string[] = [];\n\n  try {\n    const messages = await receiver.receiveMessages(10, { maxWaitTimeInMs: 5000 });\n    for (const msg of messages) {\n      const order = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;\n      if (order.eventType === 'order.created') {\n        for (const item of order.items) {\n          console.log(`[inventory] reservando ${item.qty}x ${item.productId} para pedido ${order.orderId}`);\n        }\n      } else if (order.eventType === 'order.cancelled') {\n        for (const item of order.items) {\n          console.log(`[inventory] devolvendo ${item.qty}x ${item.productId} — pedido ${order.orderId} cancelado`);\n        }\n      }\n      await receiver.completeMessage(msg);\n      processed.push(order.orderId);\n    }\n  } finally {\n    await receiver.close();\n    await client.close();\n  }\n\n  return { statusCode: 200, body: JSON.stringify({ processed }) };\n}"
    },
    "notes": [
      "Produtor usa createSender(topicName) — NUNCA createSender(subscriptionName)",
      "Cada subscriber lê de sua própria subscription via createReceiver(topicName, subscriptionName)",
      "NUNCA use eventSources para Messaging.Topic no Azure — eventSources é exclusivo de Messaging.Queue",
      "ref('OrderEventsTopic', 'ConnectionString') resolve para a connection string do namespace Service Bus via listKeys()",
      "npm install @azure/service-bus"
    ]
  },
  {
    "id": "azure-vault-api-keys",
    "title": "Azure Key Vault — gerenciamento de API keys de terceiros",
    "provider": "azure",
    "constructs": [
      "Secret.Vault",
      "Fn.Lambda",
      "Fn.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "key-vault",
      "secrets",
      "api-keys",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/vault-stack.ts": "import { Stack, ref, Secret, Fn, Policy } from '@iacmp/core';\n\nconst stack = new Stack('api-keys-vault');\n\nnew Secret.Vault(stack, 'ApiKeysVault', {\n  description: 'API keys para serviços de terceiros (Stripe, SendGrid, Twilio)',\n});\n\nnew Fn.Lambda(stack, 'GetApiKeyFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/getApiKey.handler',\n  code: '.',\n  environment: {\n    KV_URL: ref('ApiKeysVault', 'Endpoint'),\n  },\n});\n\nnew Fn.ApiGateway(stack, 'ApiKeysApi', {\n  name: 'api-keys-api',\n  cors: true,\n  routes: [\n    { method: 'GET', path: '/keys/{service}', lambdaId: 'GetApiKeyFn' },\n  ],\n});\n\nnew Policy.IAM(stack, 'ApiKeysPolicy', {\n  attachTo: 'GetApiKeyFn',\n  attachType: 'lambda',\n  statements: [{\n    effect: 'Allow',\n    actions: ['keyvault:GetSecretValue'],\n    resources: [ref('ApiKeysVault', 'Arn')],\n  }],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/getApiKey.ts": "import { SecretClient } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\n\nconst ALLOWED_SERVICES = ['stripe', 'sendgrid', 'twilio'];\n\nlet client: SecretClient | null = null;\n\nfunction getClient(): SecretClient {\n  if (!client) {\n    const kvUrl = process.env.KV_URL;\n    if (!kvUrl) throw new Error('KV_URL não configurada');\n    client = new SecretClient(kvUrl, new DefaultAzureCredential());\n  }\n  return client;\n}\n\nexport async function handler(event: any) {\n  const service = event.pathParameters?.service as string | undefined;\n\n  if (!service || !ALLOWED_SERVICES.includes(service)) {\n    return {\n      statusCode: 400,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: `Serviço inválido. Permitidos: ${ALLOWED_SERVICES.join(', ')}` }),\n    };\n  }\n\n  try {\n    const secret = await getClient().getSecret(`${service}-api-key`);\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({\n        service,\n        key: secret.value,\n        version: secret.properties.version,\n        expiresOn: secret.properties.expiresOn ?? null,\n        updatedOn: secret.properties.updatedOn ?? null,\n      }),\n    };\n  } catch (error: any) {\n    if (error.code === 'SecretNotFound') {\n      return {\n        statusCode: 404,\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ error: `API key não encontrada para: ${service}` }),\n      };\n    }\n    return {\n      statusCode: 500,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: error.message }),\n    };\n  }\n}"
    },
    "notes": [
      "Policy.IAM usa dataActions (não actions) para Key Vault no Azure — keyvault:GetSecretValue é convertido pelo synth para Microsoft.KeyVault/vaults/secrets/getSecret/action no RBAC do Azure",
      "KV_URL: ref('ApiKeysVault', 'Endpoint') — nunca ref().toString() nem string literal no environment da stack",
      "Handler usa @azure/keyvault-secrets + SecretClient + DefaultAzureCredential — nunca @aws-sdk/*",
      "SecretClient é instanciado fora do handler (cold start apenas) para reutilizar a conexão entre invocações",
      "Secrets nomeados por convenção: {service}-api-key (ex: stripe-api-key, sendgrid-api-key)"
    ]
  },
  {
    "id": "azure-vault-cert-management",
    "title": "Azure Key Vault — gerenciamento de certificados TLS",
    "provider": "azure",
    "constructs": [
      "Secret.Vault",
      "Fn.Lambda",
      "Fn.ApiGateway",
      "Policy.IAM"
    ],
    "tags": [
      "key-vault",
      "certificates",
      "tls",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/vault-stack.ts": "import { Stack, ref, Secret, Fn, Policy } from '@iacmp/core';\n\nconst stack = new Stack('cert-management-vault');\n\nnew Secret.Vault(stack, 'CertVault', {\n  description: 'Certificados TLS, chaves privadas e metadados de domínios',\n});\n\nnew Fn.Lambda(stack, 'GetCertInfoFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/certInfo.handler',\n  code: '.',\n  environment: {\n    KV_URL: ref('CertVault', 'Endpoint'),\n  },\n});\n\nnew Fn.Lambda(stack, 'ListCertsFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/listCerts.handler',\n  code: '.',\n  environment: {\n    KV_URL: ref('CertVault', 'Endpoint'),\n    VAULT_NAME: ref('CertVault', 'Name'),\n  },\n});\n\nnew Fn.ApiGateway(stack, 'CertApi', {\n  name: 'cert-management-api',\n  cors: true,\n  routes: [\n    { method: 'GET', path: '/certs', lambdaId: 'ListCertsFn' },\n    { method: 'GET', path: '/certs/{domain}', lambdaId: 'GetCertInfoFn' },\n  ],\n});\n\nnew Policy.IAM(stack, 'CertInfoPolicy', {\n  attachTo: 'GetCertInfoFn',\n  attachType: 'lambda',\n  statements: [{\n    effect: 'Allow',\n    actions: ['keyvault:GetSecretValue'],\n    resources: [ref('CertVault', 'Arn')],\n  }],\n});\n\nnew Policy.IAM(stack, 'ListCertsPolicy', {\n  attachTo: 'ListCertsFn',\n  attachType: 'lambda',\n  statements: [{\n    effect: 'Allow',\n    actions: ['keyvault:GetSecretValue'],\n    resources: [ref('CertVault', 'Arn')],\n  }],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/certInfo.ts": "import { SecretClient } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\nimport { X509Certificate } from 'crypto';\n\nlet client: SecretClient | null = null;\n\nfunction getClient(): SecretClient {\n  if (!client) {\n    const kvUrl = process.env.KV_URL;\n    if (!kvUrl) throw new Error('KV_URL não configurada');\n    client = new SecretClient(kvUrl, new DefaultAzureCredential());\n  }\n  return client;\n}\n\nfunction parseCertPem(pem: string): Record<string, unknown> {\n  const cert = new X509Certificate(pem);\n  const now = new Date();\n  const expiresAt = new Date(cert.validTo);\n  const daysUntilExpiry = Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));\n  return {\n    subject: cert.subject,\n    issuer: cert.issuer,\n    validFrom: cert.validFrom,\n    validTo: cert.validTo,\n    serialNumber: cert.serialNumber,\n    daysUntilExpiry,\n    expired: daysUntilExpiry < 0,\n    expiringSoon: daysUntilExpiry >= 0 && daysUntilExpiry <= 30,\n  };\n}\n\nexport async function handler(event: any) {\n  const domain = event.pathParameters?.domain as string | undefined;\n  if (!domain) {\n    return {\n      statusCode: 400,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: 'Parâmetro domain é obrigatório' }),\n    };\n  }\n\n  const secretName = `cert-${domain.replace(/\\./g, '-')}`;\n\n  try {\n    const secret = await getClient().getSecret(secretName);\n    if (!secret.value) {\n      return {\n        statusCode: 404,\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ error: `Certificado não encontrado para domínio: ${domain}` }),\n      };\n    }\n\n    let certInfo: Record<string, unknown>;\n    try {\n      certInfo = parseCertPem(secret.value);\n    } catch {\n      certInfo = { raw: true, storedAt: secret.properties.updatedOn };\n    }\n\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ domain, ...certInfo }),\n    };\n  } catch (error: any) {\n    if (error.code === 'SecretNotFound') {\n      return {\n        statusCode: 404,\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ error: `Certificado não encontrado para domínio: ${domain}` }),\n      };\n    }\n    return {\n      statusCode: 500,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: error.message }),\n    };\n  }\n}",
      "src/listCerts.ts": "import { SecretClient } from '@azure/keyvault-secrets';\nimport { DefaultAzureCredential } from '@azure/identity';\n\nlet client: SecretClient | null = null;\n\nfunction getClient(): SecretClient {\n  if (!client) {\n    const kvUrl = process.env.KV_URL;\n    if (!kvUrl) throw new Error('KV_URL não configurada');\n    client = new SecretClient(kvUrl, new DefaultAzureCredential());\n  }\n  return client;\n}\n\nexport async function handler(event: any) {\n  try {\n    const secrets: Array<{ name: string; enabled: boolean; expiresOn: Date | null; updatedOn: Date | null }> = [];\n\n    for await (const secret of getClient().listPropertiesOfSecrets()) {\n      if (!secret.name?.startsWith('cert-')) continue;\n      secrets.push({\n        name: secret.name,\n        enabled: secret.enabled ?? false,\n        expiresOn: secret.expiresOn ?? null,\n        updatedOn: secret.updatedOn ?? null,\n      });\n    }\n\n    const now = new Date();\n    const enriched = secrets.map(s => ({\n      ...s,\n      domain: s.name.replace(/^cert-/, '').replace(/-/g, '.'),\n      expired: s.expiresOn ? s.expiresOn < now : false,\n      expiringSoon: s.expiresOn\n        ? s.expiresOn > now && (s.expiresOn.getTime() - now.getTime()) < 30 * 24 * 60 * 60 * 1000\n        : false,\n    }));\n\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ certificates: enriched, total: enriched.length }),\n    };\n  } catch (error: any) {\n    return {\n      statusCode: 500,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ error: error.message }),\n    };\n  }\n}"
    },
    "notes": [
      "Policy.IAM usa dataActions para Key Vault — nunca actions no nível de management plane; keyvault:GetSecretValue é convertido pelo synth Azure para Microsoft.KeyVault/vaults/secrets/getSecret/action",
      "KV_URL: ref('CertVault', 'Endpoint') no environment da stack — nunca string literal nem process.env no arquivo de stack",
      "Handler usa @azure/keyvault-secrets + SecretClient + DefaultAzureCredential — nunca @aws-sdk/*",
      "Certificados armazenados como secrets com prefixo cert-{domínio-com-hífens} (ex: cert-api-exemplo-com para api.exemplo.com)",
      "parseCertPem usa X509Certificate do módulo crypto nativo do Node — sem dependência extra para parsing de certificados PEM",
      "listPropertiesOfSecrets() retorna um AsyncIterableIterator — iterar com for await..of, filtrar pelo prefixo cert-"
    ]
  },
  {
    "id": "azure-vm-bastion",
    "title": "Azure VM — bastion host (jumpbox) para acesso seguro",
    "provider": "azure",
    "constructs": [
      "Compute.Instance",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup"
    ],
    "tags": [
      "vm",
      "bastion",
      "security",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/bastion-host.ts": "import { Stack, Network, Compute } from '@iacmp/core';\n\nconst stack = new Stack('bastion-host', { provider: 'azure', region: 'eastus' });\n\nconst vpc = new Network.VPC(stack, 'SecureVPC', {\n  cidr: '10.0.0.0/16',\n  maxAzs: 2,\n});\n\nconst publicSubnet = new Network.Subnet(stack, 'PublicSubnet', {\n  vpcId: vpc.vpcId as unknown as string,\n  cidr: '10.0.0.0/24',\n  public: true,\n});\n\nconst privateSubnet = new Network.Subnet(stack, 'PrivateSubnet', {\n  vpcId: vpc.vpcId as unknown as string,\n  cidr: '10.0.1.0/24',\n  public: false,\n});\n\nconst bastionSG = new Network.SecurityGroup(stack, 'BastionSG', {\n  vpcId: vpc.vpcId as unknown as string,\n  description: 'Bastion — SSH público de entrada',\n  ingressRules: [\n    { protocol: 'tcp', fromPort: 22, toPort: 22, cidr: '0.0.0.0/0', description: 'SSH público' },\n  ],\n  egressRules: [\n    { protocol: '-1', fromPort: 0, toPort: 0, cidr: '10.0.0.0/16', description: 'Rede interna' },\n  ],\n});\n\nconst privateSG = new Network.SecurityGroup(stack, 'PrivateSG', {\n  vpcId: vpc.vpcId as unknown as string,\n  description: 'VMs privadas — SSH só via bastion',\n  ingressRules: [\n    { protocol: 'tcp', fromPort: 22, toPort: 22, sourceSecurityGroupId: 'BastionSG', description: 'SSH via bastion' },\n  ],\n});\n\nnew Compute.Instance(stack, 'BastionVM', {\n  instanceType: 'small',\n  image: 'ubuntu-22.04',\n  subnetId: publicSubnet.subnetId as unknown as string,\n  securityGroupIds: [bastionSG.groupId as unknown as string],\n  userData: `#!/bin/bash\napt-get update -y\napt-get install -y fail2ban ufw\nufw default deny incoming\nufw default allow outgoing\nufw allow 22/tcp\nufw --force enable\nsystemctl enable fail2ban\nsystemctl start fail2ban\necho 'AllowUsers azureuser' >> /etc/ssh/sshd_config\necho 'MaxAuthTries 3' >> /etc/ssh/sshd_config\necho 'PermitRootLogin no' >> /etc/ssh/sshd_config\nsystemctl reload sshd`,\n} as any);\n\nnew Compute.Instance(stack, 'AppVM', {\n  instanceType: 'medium',\n  image: 'ubuntu-22.04',\n  subnetId: privateSubnet.subnetId as unknown as string,\n  securityGroupIds: [privateSG.groupId as unknown as string],\n  userData: `#!/bin/bash\napt-get update -y\napt-get install -y nodejs npm git curl build-essential`,\n} as any);\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "Compute.Instance é VM — instala software via userData; não há handler JS.",
      "BastionVM fica em subnet pública; AppVM em subnet privada — acesso SSH só via bastion.",
      "sourceSecurityGroupId referencia o id lógico do construct (string), não um ref().",
      "subnetId e securityGroupIds recebem Refs convertidas com 'as unknown as string'.",
      "Props extras (userData) requerem 'as any' até ComputeInstanceProps ser estendida."
    ]
  },
  {
    "id": "azure-vm-nginx-server",
    "title": "Azure VM — servidor Nginx com userData",
    "provider": "azure",
    "constructs": [
      "Compute.Instance",
      "Network.VPC",
      "Network.Subnet",
      "Network.SecurityGroup"
    ],
    "tags": [
      "vm",
      "nginx",
      "compute",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/nginx-server.ts": "import { Stack, Network, Compute } from '@iacmp/core';\n\nconst stack = new Stack('nginx-server', { provider: 'azure', region: 'eastus' });\n\nconst vpc = new Network.VPC(stack, 'WebVPC', {\n  cidr: '10.0.0.0/16',\n  maxAzs: 2,\n});\n\nconst subnet = new Network.Subnet(stack, 'WebSubnet', {\n  vpcId: vpc.vpcId as unknown as string,\n  cidr: '10.0.1.0/24',\n  public: true,\n});\n\nconst sg = new Network.SecurityGroup(stack, 'WebSG', {\n  vpcId: vpc.vpcId as unknown as string,\n  description: 'HTTP, HTTPS e SSH interno',\n  ingressRules: [\n    { protocol: 'tcp', fromPort: 80,  toPort: 80,  cidr: '0.0.0.0/0',    description: 'HTTP' },\n    { protocol: 'tcp', fromPort: 443, toPort: 443, cidr: '0.0.0.0/0',    description: 'HTTPS' },\n    { protocol: 'tcp', fromPort: 22,  toPort: 22,  cidr: '10.0.0.0/16', description: 'SSH interno' },\n  ],\n});\n\nnew Compute.Instance(stack, 'NginxVM', {\n  instanceType: 'medium',\n  image: 'ubuntu-22.04',\n  subnetId: subnet.subnetId as unknown as string,\n  securityGroupIds: [sg.groupId as unknown as string],\n  userData: `#!/bin/bash\napt-get update -y\napt-get install -y nginx\ncat > /var/www/html/index.html <<'HTMLEOF'\n<!DOCTYPE html><html><body><h1>Nginx — Azure VM</h1></body></html>\nHTMLEOF\nsystemctl enable nginx\nsystemctl start nginx`,\n} as any);\n\nexport default stack;"
    },
    "handlers": {},
    "notes": [
      "Compute.Instance é VM — instala software via userData; não há handler JS.",
      "subnetId e securityGroupIds recebem Refs convertidas com 'as unknown as string' — nunca strings literais hardcoded.",
      "Props extras (userData) requerem 'as any' até ComputeInstanceProps ser estendida.",
      "Nunca usar ref().toString() nem concatenar ref() em strings de ambiente."
    ]
  },
  {
    "id": "azure-waf-api-protection",
    "title": "Azure WAF — proteção de API contra OWASP Top 10",
    "provider": "azure",
    "constructs": [
      "Network.WAF",
      "Function.ApiGateway",
      "Function.Lambda"
    ],
    "tags": [
      "waf",
      "owasp",
      "security",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/security/waf-api-stack.ts": "import { Stack, Network, Fn, ref } from '@iacmp/core';\nconst stack = new Stack('waf-api-protection');\n\nnew Network.WAF(stack, 'ApiWafPolicy', {\n  mode: 'Prevention',\n  defaultAction: 'allow',\n  rules: [\n    {\n      name: 'OWASPCommon',\n      priority: 1,\n      managedGroup: 'AWSManagedRulesCommonRuleSet',\n      description: 'Proteção OWASP Top 10 — SQLi, XSS, LFI',\n    },\n    {\n      name: 'SQLiProtection',\n      priority: 2,\n      managedGroup: 'AWSManagedRulesSQLiRuleSet',\n      description: 'Regras específicas para SQL Injection',\n    },\n    {\n      name: 'BadInputs',\n      priority: 3,\n      managedGroup: 'AWSManagedRulesKnownBadInputsRuleSet',\n      description: 'Inputs maliciosos conhecidos',\n    },\n  ],\n  description: 'WAF Policy OWASP para API pública',\n});\n\nnew Fn.Lambda(stack, 'ItemsApiFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/itemsApi.handler',\n  code: '.',\n  environment: {\n    WAF_POLICY_NAME: ref('ApiWafPolicy', 'Name'),\n  },\n});\n\nnew Fn.ApiGateway(stack, 'ItemsApiGw', {\n  name: 'items-waf-api',\n  type: 'REST',\n  stageName: 'prod',\n  cors: true,\n  wafAclId: 'ApiWafPolicy',\n  routes: [\n    { method: 'GET', path: '/items', lambdaId: 'ItemsApiFn' },\n    { method: 'GET', path: '/items/{id}', lambdaId: 'ItemsApiFn' },\n    { method: 'POST', path: '/items', lambdaId: 'ItemsApiFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/itemsApi.ts": "const items: Array<{ id: string; name: string; createdAt: string }> = [];\n\nexport async function handler(event: any) {\n  const method = event.httpMethod || event.requestContext?.http?.method || 'GET';\n  const rawPath = event.path || event.rawPath || '/';\n  const segments = rawPath.split('/').filter(Boolean);\n  const id = segments.length >= 2 ? segments[1] : null;\n\n  if (method === 'GET' && !id) {\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ items }),\n    };\n  }\n\n  if (method === 'GET' && id) {\n    const item = items.find(i => i.id === id);\n    if (!item) {\n      return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };\n    }\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify(item),\n    };\n  }\n\n  if (method === 'POST') {\n    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;\n    if (!body?.name) {\n      return { statusCode: 400, body: JSON.stringify({ error: 'name is required' }) };\n    }\n    const item = {\n      id: Date.now().toString(),\n      name: String(body.name),\n      createdAt: new Date().toISOString(),\n    };\n    items.push(item);\n    return {\n      statusCode: 201,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify(item),\n    };\n  }\n\n  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };\n}"
    },
    "notes": [
      "Network.WAF no Azure gera Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies; managedGroup:'AWSManagedRulesCommonRuleSet' mapeia para OWASP 3.2 e managedGroup:'AWSManagedRulesSQLiRuleSet' também mapeia para OWASP 3.2",
      "wafAclId no Fn.ApiGateway deve ser o id literal do construct Network.WAF (string, não ref()) — é o único vínculo entre a WAF Policy e o API Management",
      "NUNCA matchValues:['IP'] — string 'IP' é inválida no Azure; matchValues aceita apenas CIDRs no formato '10.0.0.0/8'",
      "ref('ApiWafPolicy','Name') retorna o nome do recurso WAF Policy no Azure; ref('ApiWafPolicy','PolicyId') retorna o ARM resource ID"
    ]
  },
  {
    "id": "azure-waf-geo-block",
    "title": "Azure WAF — bloqueio geográfico de países não autorizados",
    "provider": "azure",
    "constructs": [
      "Network.WAF",
      "Function.ApiGateway",
      "Function.Lambda"
    ],
    "tags": [
      "waf",
      "geo-block",
      "security",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/security/waf-geo-block-stack.ts": "import { Stack, Network, Fn, ref } from '@iacmp/core';\nconst stack = new Stack('waf-geo-block');\n\nnew Network.WAF(stack, 'GeoWafPolicy', {\n  mode: 'Prevention',\n  defaultAction: 'allow',\n  rules: [\n    {\n      name: 'BlockHighRiskRegion1',\n      priority: 1,\n      action: 'block',\n      matchValues: ['5.8.0.0/13', '46.243.0.0/16', '91.108.0.0/16'],\n      description: 'Bloqueia CIDRs de regiões não autorizadas — grupo 1',\n    },\n    {\n      name: 'BlockHighRiskRegion2',\n      priority: 2,\n      action: 'block',\n      matchValues: ['185.220.0.0/16', '195.62.0.0/15', '212.193.0.0/18'],\n      description: 'Bloqueia CIDRs de regiões não autorizadas — grupo 2',\n    },\n    {\n      name: 'OWASPBase',\n      priority: 10,\n      managedGroup: 'AWSManagedRulesCommonRuleSet',\n      description: 'Proteção base OWASP além do bloqueio geográfico',\n    },\n  ],\n  description: 'WAF Policy com bloqueio geográfico por CIDR + OWASP base',\n});\n\nnew Fn.Lambda(stack, 'GeoApiFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/geoApi.handler',\n  code: '.',\n  environment: {\n    WAF_POLICY_ID: ref('GeoWafPolicy', 'PolicyId'),\n  },\n});\n\nnew Fn.ApiGateway(stack, 'GeoApiGw', {\n  name: 'geo-filtered-api',\n  type: 'REST',\n  stageName: 'prod',\n  cors: false,\n  wafAclId: 'GeoWafPolicy',\n  routes: [\n    { method: 'GET', path: '/status', lambdaId: 'GeoApiFn' },\n    { method: 'ANY', path: '/{proxy+}', lambdaId: 'GeoApiFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/geoApi.ts": "export async function handler(event: any) {\n  const method = event.httpMethod || event.requestContext?.http?.method || 'GET';\n  const rawPath = event.path || event.rawPath || '/';\n  const sourceIp =\n    event.requestContext?.identity?.sourceIp ||\n    event.requestContext?.http?.sourceIp ||\n    'unknown';\n\n  // Requisições de regiões bloqueadas são barradas pelo WAF antes de chegar aqui\n  console.log(JSON.stringify({\n    method,\n    path: rawPath,\n    sourceIp,\n    timestamp: new Date().toISOString(),\n    message: 'Request allowed — passed WAF geo policy',\n  }));\n\n  if (method === 'GET' && rawPath.endsWith('/status')) {\n    return {\n      statusCode: 200,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({\n        status: 'ok',\n        region: 'allowed',\n        sourceIp,\n        timestamp: new Date().toISOString(),\n      }),\n    };\n  }\n\n  return {\n    statusCode: 200,\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({\n      requestId: event.requestContext?.requestId || null,\n      path: rawPath,\n      method,\n    }),\n  };\n}"
    },
    "notes": [
      "Network.WAF no Azure usa operator IPMatch com RemoteAddr para custom rules — matchValues DEVEM ser CIDRs válidos (ex: '5.8.0.0/13'); NUNCA a string 'IP'",
      "Padrão blocklist: defaultAction:'allow' + regras com action:'block' e matchValues com CIDRs das regiões proibidas; padrão allowlist seria defaultAction:'block' + regras action:'allow'",
      "Para GeoMatch nativo no Azure (bloqueio por código de país), é necessário extensão do synth; o construct atual aproxima via CIDRs de ASNs conhecidos",
      "wafAclId no Fn.ApiGateway é o id literal do construct Network.WAF — o synth Azure cria a associação entre a WAF Policy e o API Management"
    ]
  },
  {
    "id": "azure-waf-rate-limit",
    "title": "Azure WAF — rate limiting por IP para prevenir DDoS",
    "provider": "azure",
    "constructs": [
      "Network.WAF",
      "Function.ApiGateway",
      "Function.Lambda"
    ],
    "tags": [
      "waf",
      "rate-limit",
      "ddos",
      "azure"
    ],
    "validated": false,
    "stacks": {
      "stacks/security/waf-rate-limit-stack.ts": "import { Stack, Network, Fn, ref } from '@iacmp/core';\nconst stack = new Stack('waf-rate-limit');\n\nnew Network.WAF(stack, 'RateLimitWafPolicy', {\n  mode: 'Prevention',\n  defaultAction: 'allow',\n  rules: [\n    {\n      name: 'RateLimitPerIp',\n      priority: 1,\n      rateLimit: 100,\n      action: 'block',\n      description: 'Bloqueia IPs que excedem 100 requisições em 5 minutos',\n    },\n    {\n      name: 'OWASPCommon',\n      priority: 2,\n      managedGroup: 'AWSManagedRulesCommonRuleSet',\n      description: 'Proteção base OWASP para ataques na camada de aplicação',\n    },\n    {\n      name: 'BotControl',\n      priority: 3,\n      managedGroup: 'AWSManagedRulesBotControlRuleSet',\n      description: 'Bloqueio de bots e crawlers maliciosos (Azure BotManager 1.0)',\n    },\n  ],\n  description: 'WAF Policy com rate limiting por IP e proteção anti-DDoS',\n});\n\nnew Fn.Lambda(stack, 'PublicApiFn', {\n  runtime: 'nodejs20',\n  handler: 'dist/publicApi.handler',\n  code: '.',\n  environment: {\n    WAF_POLICY_NAME: ref('RateLimitWafPolicy', 'Name'),\n    RATE_LIMIT: '100',\n  },\n});\n\nnew Fn.ApiGateway(stack, 'PublicApiGw', {\n  name: 'rate-limited-api',\n  type: 'REST',\n  stageName: 'prod',\n  cors: true,\n  throttlingBurstLimit: 50,\n  throttlingRateLimit: 20,\n  wafAclId: 'RateLimitWafPolicy',\n  routes: [\n    { method: 'GET', path: '/data', lambdaId: 'PublicApiFn' },\n    { method: 'POST', path: '/data', lambdaId: 'PublicApiFn' },\n  ],\n});\n\nexport default stack;"
    },
    "handlers": {
      "src/publicApi.ts": "export async function handler(event: any) {\n  const method = event.httpMethod || event.requestContext?.http?.method || 'GET';\n  const rawPath = event.path || event.rawPath || '/';\n  const rateLimit = parseInt(process.env.RATE_LIMIT || '100', 10);\n\n  if (method === 'GET' && rawPath.endsWith('/data')) {\n    return {\n      statusCode: 200,\n      headers: {\n        'Content-Type': 'application/json',\n        'X-Rate-Limit': String(rateLimit),\n        'X-Rate-Limit-Window': '300s',\n      },\n      body: JSON.stringify({\n        data: [\n          { id: '1', value: 'record-a', timestamp: new Date().toISOString() },\n          { id: '2', value: 'record-b', timestamp: new Date().toISOString() },\n        ],\n        total: 2,\n      }),\n    };\n  }\n\n  if (method === 'POST') {\n    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;\n    if (!body?.value) {\n      return {\n        statusCode: 400,\n        body: JSON.stringify({ error: 'value is required' }),\n      };\n    }\n    return {\n      statusCode: 201,\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({\n        id: Date.now().toString(),\n        value: String(body.value),\n        createdAt: new Date().toISOString(),\n      }),\n    };\n  }\n\n  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };\n}"
    },
    "notes": [
      "rateLimit no rule é filtrado no synth Azure atual (rules.filter(!r.rateLimit)) — para rate limiting efetivo combine rateLimit na WAF rule com throttlingBurstLimit/throttlingRateLimit no Fn.ApiGateway",
      "managedGroup:'AWSManagedRulesBotControlRuleSet' mapeia para Microsoft_BotManagerRuleSet 1.0 no Azure — útil para bloquear bots DDoS na camada de aplicação",
      "NUNCA matchValues:['IP'] — se precisar de regra customizada de IP use CIDRs válidos como '203.0.113.0/24'; a string 'IP' é inválida no Azure WAF",
      "wafAclId:'RateLimitWafPolicy' no Fn.ApiGateway é o único mecanismo de associação entre a WAF Policy e o API Management no Azure; omitir esse campo deixa o WAF órfão"
    ]
  }
];
