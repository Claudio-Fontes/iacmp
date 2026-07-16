import { AIGeneratedResponse } from '@iacmp/ai';

export interface GeneratedFile {
  path: string;
  content: string;
}

// Prompt de auto-revisão: a IA critica a própria resposta contra o pedido,
// focando nos modos de falha que TS/synth NÃO pegam (erros de intenção).
export const REVIEW_PROMPT = (fileCount: number): string =>
  `Antes de finalizar, revise sua resposta anterior como um engenheiro sênior revisando um Pull Request, comparando-a com o pedido ORIGINAL do usuário. Verifique CADA item:\n` +
  `1. REQUISITOS: todo requisito explícito do pedido está implementado? Liste mentalmente o que faltou.\n` +
  `1b. SEPARAÇÃO POR CAMADA: os recursos estão divididos em múltiplas stacks por camada (network/database/compute/security/...), NÃO tudo num arquivo só? Se houver VPC+banco+lambdas+secret juntos num único arquivo, SEPARE em stacks distintas nas subpastas corretas.\n` +
  `2. PONTO DE ENTRADA HTTP (crítico): uma "API REST/HTTP" servida por Lambdas EXIGE um Fn.ApiGateway com routes[] apontando para cada lambdaId. Se NENHUM arquivo tiver Fn.ApiGateway, a API está INCOMPLETA — CRIE stacks/network/api-gateway-stack.ts com Fn.ApiGateway (type: 'HTTP', cors: true, e uma rota por método/Lambda). NUNCA use Network.LoadBalancer para isso (ALB é para containers/EC2).\n` +
  `3. CRUD COMPLETO: todas as operações pedidas (listar, obter, criar, atualizar, deletar) existem e estão wireadas nas rotas.\n` +
  `4. SCHEMA E SQL: a tabela tem TODOS os campos da spec; o handler de listagem cria a tabela (CREATE TABLE IF NOT EXISTS) com todos os campos; INSERT/UPDATE leem e escrevem todos os campos; a contagem de colunas BATE com a de valores ($1,$2,...); SQL parametrizado.\n` +
  `5. REFERÊNCIAS: env vars de banco usam o id real do Database (ex: AppDB.Endpoint); rotas usam os lambdaId reais.\n` +
  `6. IAM: toda Lambda que acessa um serviço AWS (DynamoDB, S3, SQS, SNS, Secrets Manager, etc.) TEM uma Policy.IAM anexada (attachTo) com as actions mínimas necessárias? Sem isso a Lambda dá AccessDenied em runtime. Se faltar, ADICIONE a Policy.IAM.\n` +
  `6a. IAM — ACTIONS VÁLIDAS: use APENAS ações reais da AWS. Erros comuns: \`dynamodb:ScanItem\` NÃO EXISTE — use \`dynamodb:Scan\`; \`s3:Get\` NÃO EXISTE — use \`s3:GetObject\`. Se encontrar ação inválida, CORRIJA.\n` +
  `6b. IAM — ARN em resources[]: NUNCA coloque string literal como \`'BucketName/*'\` ou \`'TableName/index/*'\`. Use SEMPRE \`ref('X','Arn')\` — o synth/CFN resolve para o ARN real. Para sub-recursos (objetos S3, GSI), use array: \`resources: [ref('Bucket','Arn'), ref('Bucket','Arn') + '/*']\`.\n` +
  `6c. SQS EVENT SOURCE: se um Lambda tem \`eventSources: [{ queueId: '...' }]\`, a Policy.IAM DEVE incluir \`sqs:ReceiveMessage\`, \`sqs:DeleteMessage\` e \`sqs:GetQueueAttributes\` com \`resources: [ref('Queue','Arn')]\`. Sem essas permissões o Event Source Mapping falha silenciosamente.\n` +
  `7. UUID NO CREATE: o handler de criação (POST/create) gera o ID INTERNAMENTE com crypto.randomUUID() — NUNCA espera que o cliente mande um "id" no body. Verifique: o handler tem algo como \`const id = crypto.randomUUID();\` (ou uuid lib) antes do PutItem/INSERT? Se não, CORRIJA.\n` +
  `8. DYNAMODB UPDATE — ExpressionAttributeNames OBRIGATÓRIO: o handler de update usa o padrão \`#f0 = :v0\` (com ExpressionAttributeNames mapeando os alias)? Se usar \`SET fieldName = :fieldName\` direto (sem alias #), CORRIJA — \`item\`, \`name\`, \`value\`, \`status\` e outros são palavras reservadas e quebram em runtime.\n\n` +
  `Se encontrar QUALQUER defeito, retorne o JSON COMPLETO CORRIGIDO com os ${fileCount} arquivo(s) (todos, não só os corrigidos). Se estiver tudo perfeito, retorne exatamente o mesmo JSON. Responda APENAS com o JSON, sem texto antes ou depois.`;

// DOIS MUNDOS SEPARADOS (regra do usuário): no Azure, NENHUM @aws-sdk é aceito.
// O shim (azure-dynamo-shim) foi a decisão ANTIGA — hoje o caminho é o helper
// nativo src/tables.ts (@azure/data-tables). Qualquer @aws-sdk num handler Azure
// é erro e deve virar o SDK Azure nativo (DynamoDB→./tables, S3→storage-blob,
// SQS→service-bus, secret→env var).
function usesAwsSdk(content: string): boolean {
  return /@aws-sdk\//.test(content);
}

// Dicas Azure POR SERVIÇO — o exemplo principal (sdkExample) é focado no
// datastore; secret/fila/tópico precisam do equivalente Azure nativo, senão o
// modelo insiste no @aws-sdk (client-secrets-manager/client-sqs/client-sns) e o
// loop não converge. NUNCA misturar: no Azure é Key Vault (via env var) e Service Bus.
function azureServiceHints(handlerFiles: GeneratedFile[]): string {
  const blob = handlerFiles.map(f => f.content).join('\n');
  const hints: string[] = [];
  if (/@aws-sdk\/client-secrets-manager/.test(blob)) {
    hints.push(
      `SECRET (Key Vault): NUNCA leia secret via SDK no handler. O valor do Secret.Vault chega como ENV VAR — ` +
      `no Fn.Lambda declare environment: { MEU_SECRET: ref('NomeDoSecretVault','SecretValue') } e no handler leia process.env.MEU_SECRET. ` +
      `REMOVA @aws-sdk/client-secrets-manager (e não use @azure/keyvault-secrets).`,
    );
  }
  if (/@aws-sdk\/client-sqs/.test(blob)) {
    hints.push(
      `FILA (Service Bus): use @azure/service-bus, NUNCA @aws-sdk/client-sqs. ` +
      `Env: FILA_CONNECTION: ref('NomeDaFila','ConnectionString'). Handler: ` +
      `import { ServiceBusClient } from '@azure/service-bus'; ` +
      `const sb = new ServiceBusClient(process.env.FILA_CONNECTION!); await sb.createSender('NomeDaFila').sendMessages({ body: obj });`,
    );
  }
  if (/@aws-sdk\/client-sns/.test(blob)) {
    hints.push(
      `TÓPICO (Service Bus topic): use @azure/service-bus (createSender do tópico), NUNCA @aws-sdk/client-sns. ` +
      `Env: TOPIC_CONNECTION: ref('NomeDoTopico','ConnectionString').`,
    );
  }
  if (/@aws-sdk\/client-s3|s3-request-presigner/.test(blob)) {
    hints.push(`BLOB (Storage): use @azure/storage-blob (BlobServiceClient.fromConnectionString), NUNCA @aws-sdk/client-s3. Env: BLOB_CONNECTION: ref('NomeDoBucket','ConnectionString').`);
  }
  return hints.length ? `\n\nSERVIÇOS ESPECÍFICOS — troque cada @aws-sdk pelo equivalente Azure NATIVO:\n- ${hints.join('\n- ')}` : '';
}

/**
 * Detector programático de SDK errado nos handlers Azure. Retorna a mensagem de
 * correção (com o SDK certo pro datastore do projeto) ou null se tudo ok.
 * Roda INDEPENDENTE do TS: o SDK errado costuma SER a causa do erro de compilação
 * (ex: TableClient.getSignedUrl não existe num cenário de blob).
 * DynamoDB AWS SDK é aceito (shim de deploy) — só flaga SDKs AWS não-shimmados.
 */
export function buildAzureSdkCorrection(files: GeneratedFile[]): string | null {
  const stacksBlob = files.filter(f => f.path.startsWith('stacks/')).map(f => f.content).join('\n');
  const hasDynamo = stacksBlob.includes('Database.DynamoDB');
  const sqlOnly = stacksBlob.includes('Database.SQL') && !hasDynamo;
  const blobOnly = stacksBlob.includes('Storage.Bucket') && !hasDynamo && !stacksBlob.includes('Database.SQL');
  const handlerFiles = files.filter(f => (f.path.startsWith('src/') || f.path.endsWith('.ts')) && !f.path.startsWith('stacks/'));
  // Dois mundos separados: QUALQUER @aws-sdk num handler Azure é erro (inclui
  // client/lib-dynamodb — o caminho é o helper ./tables, não o shim).
  const awsSdkFiles = handlerFiles.filter(f => usesAwsSdk(f.content));
  // data-tables/cosmos só é correto com Database.DynamoDB — em SQL (→pg) ou
  // blob (→storage-blob) é o SDK errado.
  const wrongTableFiles = (sqlOnly || blobOnly)
    ? handlerFiles.filter(f => f.content.includes('@azure/data-tables') || f.content.includes('@azure/cosmos'))
    : [];
  if (awsSdkFiles.length === 0 && wrongTableFiles.length === 0) return null;
  const fileList = [...new Set([...awsSdkFiles, ...wrongTableFiles].map(f => f.path))].join(', ');
  const sdkExample = sqlOnly
    ? `Reescreva APENAS esses handlers usando o driver pg (o banco é PostgreSQL flexible server):\n` +
      `\`\`\`typescript\n` +
      `import { Client } from 'pg';\n` +
      `const db = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME ?? 'postgres', ssl: { rejectUnauthorized: false } });\n` +
      `\`\`\`\n\n` +
      `Env vars: DB_HOST: ref('AppDB','Endpoint'), DB_PORT: ref('AppDB','Port'), DB_USER: ref('AppDB','Username'), DB_PASSWORD: ref('AppDB','Password').\n` +
      `NUNCA @azure/data-tables/@azure/cosmos (é Cosmos, outro produto) nem @aws-sdk/*.`
    : blobOnly
    ? `Este projeto é de ARQUIVOS/BLOB (Storage.Bucket, sem banco). Reescreva APENAS esses handlers com @azure/storage-blob (presigned = SAS URL). Use fromConnectionString (NÃO invente BLOB_KEY placeholder) e crie o container:\n` +
      `\`\`\`typescript\n` +
      `import { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } from '@azure/storage-blob';\n` +
      `const svc = BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION!);\n` +
      `const container = svc.getContainerClient('uploads'); await container.createIfNotExists();\n` +
      `const cred = svc.credential as StorageSharedKeyCredential;\n` +
      `// SAS: generateBlobSASQueryParameters({ containerName:'uploads', blobName, permissions: BlobSASPermissions.parse('cw'), expiresOn: new Date(Date.now()+3e5) }, cred).toString()\n` +
      `// list: for await (const b of container.listBlobsFlat()){...}  // delete: await container.deleteBlob(name)\n` +
      `\`\`\`\n\n` +
      `Env var ÚNICA: BLOB_CONNECTION: ref('<Bucket>','ConnectionString'). NÃO gere BLOB_KEY/BLOB_ACCOUNT/COSMOS_CONNECTION/TABLE_NAME. NUNCA @azure/data-tables/@azure/cosmos nem @aws-sdk/*.`
    : `Reescreva APENAS esses handlers usando o helper './tables' (injetado pelo iacmp — NÃO importe @azure/data-tables direto):\n` +
      `\`\`\`typescript\n` +
      `import { table } from './tables';\n` +
      `const items = table('items');\n` +
      `// items.get(id)->obj|null  put(id,fields,{ifNotExists})  update(id,patch)  increment(id,field)  del(id)  list()  listByPrefix(pfx)\n` +
      `\`\`\`\n\n` +
      `Env vars no Fn.Lambda: COSMOS_CONNECTION: ref('ItemsTable','ConnectionString'), TABLE_NAME: ref('ItemsTable','Name'). NUNCA @aws-sdk/* nem TableClient/getEntity cru.`;
  return `ERRO AZURE: os handlers ${fileList} usam o SDK errado para o datastore deste projeto.\n\n` +
    sdkExample + azureServiceHints(handlerFiles) + `\n\n` +
    `Retorne o JSON completo com TODOS os ${files.length} arquivo(s) da resposta anterior (corrija os handlers + as env vars dos Fn.Lambda nas stacks).`;
}

/**
 * Guard: em projeto Azure com Database.DynamoDB, o iacmp injeta src/tables.ts
 * (helper nativo). Os handlers DEVEM usá-lo — mas o modelo teima em escrever
 * @azure/data-tables/TableClient cru, reintroduzindo os bugs de getEntity/OData.
 * Detecta handlers (não o próprio tables.ts) que usam o SDK cru e força a
 * correção para o helper. Retorna a mensagem, ou null se todos já usam o helper.
 */
export function buildAzureTablesHelperCorrection(files: GeneratedFile[]): string | null {
  const stacksBlob = files.filter(f => f.path.startsWith('stacks/')).map(f => f.content).join('\n');
  if (!stacksBlob.includes('Database.DynamoDB')) return null;
  const handlers = files.filter(f =>
    (f.path.startsWith('src/') || f.path.endsWith('.ts')) &&
    !f.path.startsWith('stacks/') &&
    f.path !== 'src/tables.ts',
  );
  const offenders = handlers.filter(f =>
    f.content.includes('@azure/data-tables') || /\bTableClient\b/.test(f.content),
  );
  if (offenders.length === 0) return null;
  const list = [...new Set(offenders.map(f => f.path))].join(', ');
  return `ERRO AZURE: os handlers ${list} usam @azure/data-tables/TableClient DIRETAMENTE. ` +
    `Este projeto JÁ TEM o helper nativo src/tables.ts — os handlers DEVEM usá-lo, NUNCA o SDK cru ` +
    `(o SDK cru reintroduz os bugs de getEntity flat/.value, 404 que lança e campos OData).\n\n` +
    `Reescreva CADA handler de Database.DynamoDB assim:\n` +
    "```typescript\n" +
    "import { table } from './tables';\n" +
    "const items = table('items');   // 'items' = partição da tabela lógica\n" +
    "// items.get(id) -> objeto com .id, ou null (nunca lança 404)\n" +
    "// items.put(id, fields, { ifNotExists: true }) -> false se já existe\n" +
    "// items.update(id, patch) | items.increment(id, 'campo') | items.del(id) | items.list() | items.listByPrefix('pref#')\n" +
    "```\n\n" +
    `REMOVA todo import de '@azure/data-tables' e todo uso de TableClient/getEntity/createEntity/updateEntity/deleteEntity dos handlers. ` +
    `NÃO altere src/tables.ts (é do iacmp). Retorne o JSON completo com TODOS os ${files.length} arquivo(s).`;
}

// Monta o hint de correção para erros de compilação TypeScript. Prioriza o
// detector de SDK errado no Azure (buildAzureSdkCorrection) — @aws-sdk/* é a
// causa mais comum de "Cannot find module" em projetos Azure e o hint genérico
// (data-tables) seria o SDK ERRADO para blob. Sem match Azure, monta o hint
// ciente do datastore (SQL→pg, blob→storage-blob, senão data-tables/Cosmos).
export function buildTsErrorHint(iacProvider: string, files: GeneratedFile[]): string {
  const azureSdkFirst = iacProvider === 'azure' ? buildAzureSdkCorrection(files) : null;
  if (azureSdkFirst) {
    return `\n\n${azureSdkFirst}`;
  }
  const stacksBlob = files.filter(f => f.path.startsWith('stacks/')).map(f => f.content).join('\n');
  const hasDynamo = stacksBlob.includes('Database.DynamoDB');
  const hasSql = stacksBlob.includes('Database.SQL');
  const hasBlob = stacksBlob.includes('Storage.Bucket');
  return iacProvider === 'azure'
    ? (hasSql && !hasDynamo
      ? `\n\nEste projeto Azure usa Database.SQL (PostgreSQL flexible server) — os handlers usam o driver pg NORMAL:\n` +
        `  import { Client } from 'pg';\n` +
        `  const db = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME ?? 'postgres', ssl: { rejectUnauthorized: false } });\n` +
        `NUNCA use @azure/data-tables (é Cosmos DB Table, outro produto) nem @aws-sdk/*.`
      : (hasBlob && !hasDynamo)
      ? `\n\nEste projeto Azure é de ARQUIVOS/BLOB (Storage.Bucket). Use @azure/storage-blob:\n` +
        `  import { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } from '@azure/storage-blob';\n` +
        `  const svc = BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION!);\n` +
        `  const container = svc.getContainerClient('uploads'); await container.createIfNotExists();\n` +
        `NUNCA use @azure/data-tables (é NoSQL Cosmos, não blob) nem @aws-sdk/*.`
      : `\n\nEste projeto usa Azure Container Apps — use APENAS @azure/data-tables para acesso a Cosmos DB:\n` +
        `  import { TableClient } from '@azure/data-tables';\n` +
        `  const client = TableClient.fromConnectionString(process.env.COSMOS_CONNECTION!, process.env.TABLE_NAME!);\n` +
        `NUNCA use @aws-sdk/* (DynamoDBClient, etc.) — não funciona no Azure.`)
    : ``;
}

// Mensagem de retry para erros de compilação TypeScript na geração inicial.
export function buildTsErrorCorrection(errors: string[], iacProvider: string, files: GeneratedFile[], originalFileCount: number): string {
  return `Erros TypeScript:\n${errors.join('\n')}\n\n` +
    `Corrija e retorne o JSON completo de novo, com TODOS os ${originalFileCount} arquivo(s) da resposta anterior ` +
    `(não só o(s) que tinha(m) erro) — os arquivos que já estavam corretos devem vir de volta sem alteração.` +
    buildTsErrorHint(iacProvider, files);
}

// Mensagem para o caso em que o synth passou mas os handlers têm erros de TS
// (o build do deploy vai falhar). Não é classificado por datastore.
export function buildHandlerTsCorrection(errors: string[], fileCount: number): string {
  return `O synth passou, mas os handlers têm erros de TypeScript (o build do deploy vai falhar):\n\n${errors.join('\n')}\n\n` +
    `Corrija e retorne o JSON completo com TODOS os ${fileCount} arquivo(s) da resposta anterior. ` +
    `Lembre: DynamoDBClient vem de '@aws-sdk/client-dynamodb'; GetCommand/PutCommand/QueryCommand/ScanCommand vêm de '@aws-sdk/lib-dynamodb' e exigem DynamoDBDocumentClient.from(new DynamoDBClient({})).`;
}

/**
 * Classifica o erro do `iacmp synth` e monta a mensagem de correção apropriada.
 * Cada classe de erro exige uma instrução DIFERENTE: dependência circular pede
 * reestruturação (mover o par acoplado, sem virar monolito); process.env omitido
 * pede correção SÓ do handler (estrutura de stacks está certa); handler sem
 * arquivo de origem pede CRIAR os src/ faltantes (não mexer no campo handler);
 * o genérico pede mudar o trecho apontado sem repetir o mesmo código.
 */
export function classifySynthError(output: string, files: GeneratedFile[], attempt: number, maxRetries: number): string {
  const fileCount = files.length;
  const suffix = `\nRetorne o JSON completo com TODOS os ${fileCount} arquivo(s) (tentativa ${attempt} de ${maxRetries}).`;

  // Erros exclusivos: exigem reestruturação completa — retornam imediatamente sozinhos.
  if (/[Dd]epend[êe]ncia circular entre stacks/.test(output)) {
    return `O comando "iacmp synth" falhou com DEPENDÊNCIA CIRCULAR entre stacks:\n\n${output}\n\n` +
      `Isso NÃO se conserta mudando uma linha: é preciso REESTRUTURAR os arquivos. ` +
      `MOVA para a MESMA stack APENAS o par de constructs com referência mútua apontado acima ` +
      `(tipicamente o Storage.Bucket com \`eventNotifications\` + a Fn.Lambda-alvo + a Policy.IAM dela). ` +
      `NÃO junte tudo num arquivo só: os DEMAIS recursos (VPC/subnets, DynamoDB/RDS, buckets SEM trigger) ` +
      `CONTINUAM cada um em sua própria stack separada — a Lambda os referencia cross-stack via \`ref(...)\` em env vars (dependência unidirecional, sem ciclo). ` +
      `Um único arquivo com VPC+buckets+banco+Lambda é MONOLITO e será rejeitado. ` +
      `CRÍTICO para o handler: quando bucket-trigger e Lambda estão na MESMA stack, o nome do bucket vem do EVENTO (não de env var): ` +
      `\`const bucket = record.s3.bucket.name\` — NÃO use process.env.RAW_BUCKET_NAME (essa env var é omitida pelo synth). ` +
      `Se a reestruturação eliminar algum arquivo de stack antigo, liste-o em \`deletions\` (não deixe stack órfã). ` +
      `Retorne o JSON completo com o novo conjunto de arquivos (tentativa ${attempt} de ${maxRetries}).`;
  }
  if (/usa process\.env\.\w+ mas essa env var é omitida pelo synth/.test(output)) {
    return `O synth detectou que um handler usa process.env que foi omitido pelo synth:\n\n${output}\n\n` +
      `ATENÇÃO: a estrutura dos arquivos de stack ESTÁ CORRETA — NÃO mova constructs, NÃO reorganize os arquivos em stacks/. ` +
      `Corrija APENAS o handler em src/: ` +
      `ANTES: \`const bucket = process.env.RAW_BUCKET_NAME!\` ` +
      `DEPOIS: \`const bucket = record.s3.bucket.name\` (o nome do bucket-trigger vem SEMPRE do evento S3). ` +
      `A key continua: \`const key = decodeURIComponent(record.s3.object.key.replace(/\\+/g, ' '))\`. ` +
      `Buckets de SAÍDA (outra stack, sem trigger) PODEM continuar como env var: \`process.env.PROCESSED_BUCKET_NAME\`. ` +
      `Retorne o JSON completo com TODOS os ${fileCount} arquivo(s) mas altere APENAS os handlers src/ (tentativa ${attempt} de ${maxRetries}).`;
  }

  // Erros combináveis: coletados todos de uma vez para o modelo corrigir numa rodada.
  const corrections: string[] = [];

  if (/env vars com ID l[oó]gico em vez de ref\(\)/.test(output)) {
    const fixes = [...output.matchAll(/Lambda "([^"]+)": environment\.(\w+) = '([^']+)' [^.]+\. Use ref\('([^']+)', '([^']+)'\)/g)]
      .map(m => `  ANTES: ${m[2]}: '${m[3]}'\n  DEPOIS: ${m[2]}: ref('${m[4]}', '${m[5]}')`);
    const fixBlock = fixes.length > 0 ? fixes.join('\n') : '  (veja os pares Lambda/env var apontados acima)';
    corrections.push(
      `[PROBLEMA: env vars com ID lógico em vez de ref()]\n` +
      `Corrija APENAS as linhas de environment apontadas. NÃO altere resources, attachTo nem Policy.IAM:\n` +
      `${fixBlock}\n` +
      `Regra: em environment{}, NUNCA use string literal de construct ID:\n` +
      `  TABLE_NAME: ref('ItemsTable', 'Name'), QUEUE_URL: ref('MyQueue', 'QueueUrl'), REDIS_HOST: ref('MyCache', 'Endpoint')`
    );
  }
  if (/env vars com atributo errado em ref\(\)/.test(output)) {
    const fixes = [...output.matchAll(/Lambda "([^"]+)": environment\.(\w+) usa ref\('([^']+)', '(\w+)'\) mas o sufixo "\w+" exige atributo '(\w+)'\./g)]
      .map(m => `  ANTES: ${m[2]}: ref('${m[3]}', '${m[4]}')\n  DEPOIS: ${m[2]}: ref('${m[3]}', '${m[5]}')`);
    const fixBlock = fixes.length > 0 ? fixes.join('\n') : '  (veja os pares apontados acima)';
    corrections.push(
      `[PROBLEMA: atributo errado em ref()]\n` +
      `Troque o atributo do ref() nas linhas apontadas:\n` +
      `${fixBlock}\n` +
      `  TABLE_NAME → 'Name', QUEUE_URL → 'QueueUrl', TOPIC_ARN → 'TopicArn'. 'Arn' é EXCLUSIVO de resources[] em Policy.IAM.`
    );
  }
  if (/partitionKeyType\/sortKeyType 'N' detectado/.test(output)) {
    corrections.push(
      `[PROBLEMA: partitionKeyType 'N']\n` +
      `Troque para 'S' (ou omita — default é 'S'). IDs de CRUD são SEMPRE string (UUID, path param).`
    );
  }
  if (/Handlers de CREATE com body\.id sem UUID detectados/.test(output)) {
    corrections.push(
      `[PROBLEMA: handler de CREATE lê body.id sem gerar UUID]\n` +
      `  ANTES: const id = body.id;\n` +
      `  DEPOIS: const id = crypto.randomUUID();\n` +
      `O ID DEVE ser gerado pelo backend — nunca vir do cliente.`
    );
  }
  if (/Handlers de UPDATE sem ExpressionAttributeNames detectados/.test(output)) {
    corrections.push(
      `[PROBLEMA: handler de UPDATE sem ExpressionAttributeNames]\n` +
      `Use SEMPRE o padrão com alias:\n` +
      `  const fields = Object.entries(body).filter(([k]) => k !== 'id');\n` +
      `  const expr = 'SET ' + fields.map(([k], i) => \`#f\${i} = :v\${i}\`).join(', ');\n` +
      `  const names = {}; const vals = {};\n` +
      `  fields.forEach(([k,v],i) => { names[\`#f\${i}\`]=k; vals[\`:v\${i}\`]=v; });\n` +
      `  UpdateExpression: expr, ExpressionAttributeNames: names, ExpressionAttributeValues: vals\n` +
      `NUNCA escreva SET fieldName = :value direto — qualquer campo pode ser palavra reservada.`
    );
  }
  if (/ref is not defined|Cannot find name ['"]ref['"]/.test(output)) {
    const affectedFiles = [...output.matchAll(/[•·*\-]\s*([\w/.-]+\.ts):\s*(?:ref is not defined|Cannot find name .ref.)/g)]
      .map(m => m[1]);
    const fileList = affectedFiles.length > 0 ? affectedFiles.join(', ') : '(stacks listadas acima)';
    corrections.push(
      `[PROBLEMA: \`ref\` não importado em ${fileList}]\n` +
      `  ANTES: import { Stack, Fn, Policy } from '@iacmp/core';\n` +
      `  DEPOIS: import { Stack, Fn, Policy, ref } from '@iacmp/core';\n` +
      `Toda stack que chama ref() DEVE importá-lo de @iacmp/core.`
    );
  }

  if (corrections.length > 0) {
    const header = corrections.length > 1
      ? `O synth detectou ${corrections.length} PROBLEMAS — corrija TODOS de uma vez:\n\n${output}\n\n`
      : `O synth detectou um problema:\n\n${output}\n\n`;
    return header + corrections.join('\n\n') + suffix;
  }

  if (/n[ãa]o tem arquivo de origem|Handler\(s\) de Lambda sem arquivo de origem/.test(output)) {
    const missingSrc = [
      ...new Set([...output.matchAll(/esperado (src\/[\w./-]+\.ts)/g)].map(m => m[1])),
    ];
    const list = missingSrc.length > 0
      ? missingSrc.map(p => `  • ${p}`).join('\n')
      : '  • (veja os caminhos src/ apontados no erro acima)';
    corrections.push(
      `[PROBLEMA: handlers de Lambda sem arquivo de origem]\n` +
      `CRIE cada arquivo de handler abaixo, exportando a função \`handler\`:\n${list}\n` +
      `NÃO altere o campo "handler" nas stacks — o path está CORRETO; o que falta é o arquivo src/.`
    );
  }

  if (corrections.length > 0) {
    const header = corrections.length > 1
      ? `O synth detectou ${corrections.length} PROBLEMAS — corrija TODOS de uma vez:\n\n${output}\n\n`
      : `O synth detectou um problema:\n\n${output}\n\n`;
    return header + corrections.join('\n\n') + suffix;
  }

  return `O comando "iacmp synth" falhou com o seguinte erro:\n\n${output}\n\n` +
    `A geração anterior está ERRADA no ponto apontado acima — NÃO retorne o mesmo código: ` +
    `MUDE especificamente o trecho que causa o erro (tentativa ${attempt} de ${maxRetries}). ` +
    `Corrija os arquivos e retorne o JSON completo com TODOS os ${fileCount} arquivo(s) da resposta anterior.`;
}
