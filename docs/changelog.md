# Changelog

---

## [2.3.0] — 2026-07-23

Release consolidando distribuição, aprendizado e robustez.

- **Distribuição npm da knowledge base** — corpus (126 exemplos) + seed movidos para `@iacmp/knowledge` (fonte única "corpus + retrieval + seed"), embutido no bundle do CLI e semeado no 1º uso (`ensureSeeded`). Pacote publicado pela primeira vez.
- **`@iacmp/runtime`** (facade) — handlers usam `table`/`blob` agnósticos; adaptador por cloud resolvido no deploy. Pacote publicado pela primeira vez.
- **Loop de aprendizado (Modo 1)** — opt-in `knowledge.autolearn: "local"`: após um deploy inédito bem-sucedido, o CLI oferece gravar o padrão na base local (preview + confirmação).
- **Qualidade da geração** — guard de env vars cobre handlers aninhados; validador anti-monólito (rejeita stack com 4+ domínios de infra); template `fullstack` separado por domínio.
- **Robustez de deploy/destroy** — pré-flight de export cross-stack (AWS); destroy limpa órfãos com confirmação (RG vazio no Azure, buckets Retain no AWS); mensagem de erro de deploy não crava "autenticação"; compila handlers aninhados sozinho.
- **APIM compartilhado (Azure)** — `azure.sharedApim` no iacmp.json referencia um APIM existente (elimina o piso de ~30-45min por projeto).

Pacotes: `@iacmp/core` 2.3.0 · `@iacmp/runtime` 0.2.0 · `@iacmp/knowledge` 2.3.0 · `iacmp` 2.3.0 · `@iacmp/mcp` 0.2.0.

---

## [1.2.0] — 2026-06-29

Refactor de abstração do core: conhecimento de domínio migrado do prompt da IA para código
testável (validação semântica, defaults derivados, perfil de ambiente). Erros que antes só
apareciam no deploy real agora são bloqueados em synth-time ou eliminados na origem.

> **Nota de versão:** a `1.1.0` publicada no npm ficou defasada do código do monorepo (mesma
> versão, conteúdos diferentes — ex: engines Aurora ausentes na publicada). Este bump para
> `1.2.0` realinha a versão ao conteúdo. Republicar no npm para que `npm install` traga o código atual.

### Adicionado

- **Validação semântica (`@iacmp/core` → `validateSemantics`)** — roda em synth-time e bloqueia,
  antes do deploy: Security Group sem a porta do engine do banco que protege, RDS/DocumentDB sem
  cobertura de ≥2 AZs, `maxAzs > 0` coexistindo com subnets explícitas (conflito de CIDR), CIDR de
  subnet fora do CIDR da VPC, e referências (`vpcId`/`subnetIds`/`securityGroupIds`) a constructs
  inexistentes. O loop de auto-correção do `iacmp ai` captura e reenvia esses erros.
- **Normalização de defaults (`applyEnvironmentDefaults`)** — preenche automaticamente, antes do
  synth: `availabilityZone` distinto por subnet (derivado da região) e a porta do engine no Security
  Group do banco. Elimina na origem os dois bugs de deploy mais recorrentes.
- **Perfil de ambiente (`EnvironmentProfile`, `accountTier` no `iacmp.json`)** — defaults de RDS
  (backup, criptografia) derivam do tier (`free` → 0/false, `standard` → 7/true). Trocar de conta
  free para standard passa a ser mudança de configuração, não de código.
- **Conhecimento de domínio (`@iacmp/core/knowledge`)** — fonte única de verdade para portas por
  engine SQL e requisitos de AZ, consumida pela validação e pelos defaults.
- **Referências dinâmicas de banco no synth AWS** — env vars `AppDB.Endpoint`/`Port`/`Password`/
  `SecretArn` resolvem para `Fn::ImportValue`/`Fn::GetAtt`/`{{resolve:secretsmanager}}`, sem hardcode
  de endpoint ou senha. Destrava destroy+recreate sem edição manual.
- **`iacmp init` template `blank` (padrão)** — `iacmp init` sem `--template` cria projeto vazio (sem
  scaffold), ideal para o fluxo `iacmp ai`. O HelloWorld antigo virou `--template hello` (opt-in).

### Corrigido

- **Inferência de relação no diagrama** — env hint intra-stack só cria relação quando o valor da env
  var referencia o recurso (antes linkava por tipo, gerando ruído ou perdendo relações reais).

## Em desenvolvimento

### Bateria de testes e2e reais na AWS (2026-06-23)

Implementação de ~40 testes de integração que fazem deploy/destroy real de stacks CloudFormation
na AWS, cobrindo todos os 32 tipos de construct suportados. Cada teste usa `AWS_PROFILE=iacmp-e2e`
(usuário IAM dedicado com política restrita) e verifica `StackStatus === 'CREATE_COMPLETE'`.

#### Adicionado

- **`packages/e2e-aws/`** — novo pacote com 12 suites e2e (testes `00` a `11`) cobrindo VPC,
  SecurityGroup, SQS, SNS, S3, EFS, Glacier, Lambda, ApiGateway, EventBridge, DynamoDB, RDS MySQL,
  EC2, AutoScaling, ECS Fargate, ALB, WAF, CloudFront, IAM Role, SecretsManager, CloudWatch Alarm,
  CloudWatch Dashboard, LogGroup, StepFunctions, ElastiCache Redis, Custom.Resource SSM e Route53.
- **`docs/iam-policy.json`** — política IAM mínima para uso do `iacmp` em produção, com `ssm:*`
  completo e deny explícito de operações perigosas (criação de usuários, billing, organizations).
- **`iacmp doctor` — checagem de permissões IAM** — novo check `checkAwsIamPermissions()` verifica
  `sts:GetCallerIdentity`, `lambda:ListFunctions` e `apigateway:GetRestApis`; reporta permissões
  faltando com hint para `docs/iam-policy.json`.

#### Corrigido no synth AWS (`packages/providers/aws/src/synth/cloudformation.ts`)

- **SQS/SNS FifoQueue/FifoTopic** — AWS rejeita `FifoQueue: false`; a propriedade agora é omitida
  quando `false` e só incluída quando `true`.
- **EventBridge Rule criada antes do Bus** — usar string `busName` não criava dependência implícita;
  corrigido para `{ Ref: busId }` em buses não-default.
- **StepFunctions `Resource` em estados não-Task** — CloudFormation rejeita `Resource` em estados
  do tipo `Pass`, `Wait`, `Choice` etc.; a propriedade agora é incluída só em `Task`.
- **StepFunctions `LoggingConfiguration` sem Destinations** — `Level: 'ERROR'` sem ao menos um
  destination é inválido; bloco removido (logging é opt-in via props).
- **RDS `BackupRetentionPeriod`** — default alterado de `7` para `0` (desabilita backup automático);
  contas free tier rejeitam qualquer valor > 0.
- **RDS `StorageEncrypted`** — default alterado de `true` para `false`; agora opt-in via
  `storageEncrypted: true`. Adicionado `storageEncrypted?` em `DatabaseSQLProps`.
- **RDS `EngineVersion` desatualizada** — versões `8.0.36` (MySQL), `15.4` (PostgreSQL) e
  `10.11.6` (MariaDB) não existem mais na região us-east-1; atualizadas para `8.0.46`, `17.10` e
  `11.8.8` respectivamente.
- **DocumentDB `BackupRetentionPeriod`** — default alterado de `7` para `1`.
- **AutoScaling `LaunchConfiguration` deprecado** — `AWS::AutoScaling::LaunchConfiguration` foi
  removido de contas novas; migrado para `AWS::EC2::LaunchTemplate`.
- **AutoScaling sem `AvailabilityZones`** — CFN rejeita ASG sem subnets nem AZs; adicionado
  `AvailabilityZones: { 'Fn::GetAZs': '' }` como fallback quando `subnetIds` não é fornecido.
- **ECS Service com `subnetIds` vazio** — Fargate rejeita service sem subnets; o `Service` agora
  só é gerado quando `subnetIds.length > 0`.
- **ElastiCache Memcached `VpcSecurityGroupIds`** — `AWS::ElastiCache::CacheCluster` exige
  `VpcSecurityGroupIds` em contas VPC-only; adicionado suporte à prop `securityGroupIds` no synth.
- **SecretsManager nome colide entre runs** — secret name fixo causava falha no segundo deploy;
  corrigido para `{ 'Fn::Sub': '${AWS::StackName}-<id>-db-password' }`.
- **`DeletionPolicy` default para RDS e DocDB** — alterado de `Snapshot` para `Delete` para
  evitar `DELETE_FAILED` quando o recurso não chegou a ser criado com sucesso.

#### Corrigido no deploy AWS (`packages/cli/src/deploy/aws.ts`)

- **ROLLBACK_COMPLETE cleanup síncrono** — quando uma stack está em estado `ROLLBACK_COMPLETE`,
  `ROLLBACK_FAILED` ou `UPDATE_ROLLBACK_FAILED`, o deploy agora deleta e aguarda a conclusão
  via `execFileSync` antes de tentar criar novamente, evitando race conditions.

#### Skips justificados (testes marcados como `test.skip`)

- **DocumentDB** — engine não disponível em contas free tier (só aurora-postgresql)
- **EKS** — $0.10/hr pelo control plane independente do free tier
- **ACM Certificate** — validação DNS demora; sem domínio real registrado o recurso nunca sai de `CREATE_IN_PROGRESS`
- **ElastiCache Memcached** — `VpcSecurityGroupIds` exige GroupId real; `{ Ref }` de SecurityGroup
  sem VpcId explícito retorna GroupName nessa conta, causando erro de validação

---

Higiene de DevEx, CI e documentação a partir da auditoria
(`docs/report.md`):

### Adicionado

- **`Database.DynamoDB` ganha `partitionKeyType`/`sortKeyType`** — o tipo do atributo da chave era sempre hardcoded
  como `'S'` (string) na AWS (CloudFormation) e no Terraform, mesmo quando a aplicação usa uma chave numérica. Isso
  causava `ValidationException: Type mismatch` em runtime sempre que o handler enviasse um número numa chave
  declarada como string. Agora `partitionKeyType`/`sortKeyType` (e o equivalente por GSI) aceitam `'S' | 'N' | 'B'`,
  com `'S'` como padrão (compatível com stacks existentes). Azure (Cosmos DB Table API) e GCP (Bigtable/Firestore) não
  precisam do fix — são schemaless, sem declaração de tipo por atributo.
- **Fix: `iacmp ai` reportava dependências como "faltando" mesmo quando já estavam instaladas no projeto** —
  o validador de TypeScript (`packages/ai/src/parser/validator.ts`) escrevia os arquivos gerados e rodava `tsc` num
  diretório temporário em `os.tmpdir()`, fora da árvore do projeto — mas a resolução de módulos do TypeScript/Node
  sobe diretórios procurando `node_modules`, então um tmpDir fora do projeto nunca via as dependências reais já
  instaladas (ex: `@aws-sdk/client-dynamodb`). Qualquer import de pacote de terceiros era reportado como erro de
  "Cannot find module", e a IA interpretava isso como "preciso instalar essa dependência" mesmo quando ela já estava
  no `package.json`/`node_modules` do usuário. Agora o diretório temporário de validação é criado DENTRO do projeto
  (`<projeto>/.iacmp-validate-*`, limpo após validar, adicionado ao `.gitignore` gerado pelo `iacmp init`), então a
  resolução de módulos encontra o `node_modules` real do projeto.
- **`iacmp ls --status` mostra quais stacks já estão deployadas de verdade, não só as definidas localmente** — antes, `ls` só listava
  os arquivos em `stacks/`, sem nenhuma noção do que existe de fato na nuvem (confuso após um `destroy`: a stack continua aparecendo,
  porque é o arquivo `.ts` local que `ls` lista, não o estado remoto). A nova flag consulta o provider configurado
  (`getExecutor`/`describeStatus`, novo método opcional em `DeployExecutor`) e mostra `[deployado: <status nativo>]` ou
  `[não deployado]` por stack — implementado para AWS (`cloudformation describe-stacks`) e Azure (`az stack group show`); GCP usa um
  check de existência simples (`deploymentExists`, sem status detalhado); Terraform não implementa (opera no diretório inteiro como
  um state único, sem stack individual) — `ls --status` avisa que não é suportado para esses casos e cai para a listagem local, sem
  travar. Sem a flag, `iacmp ls` continua exatamente como antes (sem chamadas de rede).
- **`iacmp deploy` (AWS) detecta recursos órfãos antes de criar a stack, e corrige a Role IAM inexistente do `Fn.Lambda`** —
  dois problemas reais de deploy de ponta a ponta:
  - `Function.Lambda` sempre gerava `Role: arn:...:role/LambdaExecutionRole` — uma role que o iacmp nunca cria. Todo
    deploy falhava com "The role defined for the function cannot be assumed by Lambda." Agora
    (`packages/providers/aws/src/synth/cloudformation.ts`) a Lambda referencia a role real criada por um `Policy.IAM`
    (`attachType: 'lambda'`) que a aponte — local via `Fn::GetAtt`, cross-stack via `Fn::ImportValue` de um
    `Outputs`/`Export` novo no `Policy.IAM` — e, sem nenhum `Policy.IAM` correspondente, gera uma role mínima padrão
    inline (`AWSLambdaBasicExecutionRole`), pra toda Lambda ser sempre deployável.
  - Recursos com `DeletionPolicy: Retain`/`Snapshot` (ex: `Database.DynamoDB`) sobrevivem à destruição da stack — uma
    stack anterior destruída pode deixar um recurso vivo, órfão, fora do controle do CloudFormation. Um deploy
    seguinte tentando recriar esse recurso falhava com um erro confuso só visível depois de tentar criar o changeset
    (`AWS::EarlyValidation::ResourceExistenceCheck`). `iacmp deploy` agora checa isso ANTES, de forma genérica via AWS
    Cloud Control API (`get-resource`/`delete-resource` — funciona pra qualquer `Type` do CloudFormation, não amarrado
    a um serviço específico): se encontrar conflito, mostra um aviso claro e pergunta antes de apagar (default não);
    se o usuário recusar, pula só aquela stack e continua o deploy das demais, em vez de abortar tudo.
- **Fix: `Fn.ApiGateway` (REST v1) sem `description` falhava no deploy real** — `AWS::ApiGateway::RestApi` rejeita
  `Description: ''` com `400 (Description cannot be an empty string)`; o gerador sempre mandava string vazia quando o
  usuário não definia `description`. Agora a propriedade é omitida quando ausente, em vez de enviada vazia
  (`packages/providers/aws/src/synth/cloudformation.ts`).
- **`Testing.loadStack`/`findResource` em `@iacmp/core` + `iacmp ai` agora gera o código do handler junto com `Fn.Lambda`** —
  dois problemas reais encontrados ao testar deploy de ponta a ponta:
  - `iacmp ai` gerava a stack de `Fn.Lambda` (`code: 'dist/'`) mas nunca o
    código de handler em si — o `dist/` nunca existia, e o deploy falhava ao
    empacotar. O prompt (`packages/ai/src/prompts/system-prompt.ts`) agora
    instrui a sempre gerar também o arquivo `.ts` do handler na raiz do
    projeto (caminho derivado de `handler: '<arquivo>.<export>'`,
    convenção de `rootDir: '.'` do `iacmp init`), priorizando lógica real
    quando o pedido descreve o que a função faz, com placeholder
    (`{ statusCode: 200, ... }`) só quando não há lógica de negócio descrita.
  - A IA tinha alucinado uma API de teste inexistente (`Testing.loadStack`,
    `Testing.describe/it/expect`, `stack.findResource`) num arquivo de teste
    gerado — nada disso existia em `@iacmp/core`, e o prompt não tinha
    nenhuma instrução sobre geração de testes. Implementado de verdade:
    `Testing.loadStack(caminho)` (novo, `packages/core/src/testing.ts`)
    carrega a stack exportada por um arquivo (relativo à raiz do projeto) e
    retorna `.findResource(id)` (`BaseConstruct | undefined`). O prompt
    passou a documentar essa API real e a instruir o uso de
    `describe`/`it`/`expect` do Jest direto (globais), e a nunca inventar
    métodos/namespaces inexistentes em qualquer arquivo gerado.
- **Fix: `Code` da Lambda resolvia para o diretório errado no deploy AWS** —
  `aws cloudformation package` resolve caminhos relativos do `Code` em
  relação ao diretório do TEMPLATE (`synth-out/aws/`), não à raiz do
  projeto onde o `dist/` realmente vive (ao lado de `stacks/`). O deploy
  falhava com `Parameter Code of resource ... refers to a file or folder
  that does not exist .../synth-out/aws/dist` mesmo com `dist/` existindo
  no projeto. O executor AWS (`packages/cli/src/deploy/aws.ts`) agora
  reescreve esses caminhos para absoluto (relativo a `cwd`) num template
  intermediário antes de empacotar — validado com upload real pro S3.
- **`Fn.ApiGateway` na AWS: REST v1 real, permissão de Lambda e referência
  entre stacks** — três bugs corrigidos em `packages/providers/aws/src/synth/cloudformation.ts`
  que impediam o deploy real de qualquer API Gateway, incluindo o template
  padrão do `iacmp init`:
  - `type: 'REST'` (o default) gerava recursos `AWS::ApiGatewayV2::*`
    (API Gateway v2/HTTP), incompatíveis com `AWS::ApiGateway::RestApi`
    (v1). Agora gera o modelo v1 completo: árvore de `Resource` por
    segmento de path (deduplicada entre rotas), `Method` com integração
    `AWS_PROXY` aninhada, `Deployment`+`Stage` corretos, `Authorizer` v1 e
    CORS via `OPTIONS`+`MOCK`.
  - Nunca era gerada a `AWS::Lambda::Permission` que libera o API Gateway a
    invocar a Lambda (REST e HTTP) — toda chamada à API dava Access Denied.
    Agora gerada uma vez por par (API, Lambda), mesmo quando a mesma função
    atende várias rotas.
  - `Function.Lambda` referenciada por `Function.ApiGateway` em **outra**
    stack/arquivo (o padrão recomendado: Lambda em `stacks/compute/`, API
    em `stacks/network/`) gerava `Fn::Sub: '${lambdaId.Arn}'`, que só
    resolve dentro do mesmo template — CloudFormation rejeitava com
    `references invalid resource attribute`. `iacmp synth` agora carrega
    todas as stacks do projeto antes de sintetizar (mesmo com `--stack`
    filtrando o que é gravado) e resolve automaticamente: referência local
    continua direta, referência cross-stack vira `Fn::ImportValue` de um
    `Outputs`/`Export` (`<stack>-<lambdaId>-Arn`) que toda `Function.Lambda`
    passa a exportar. Erro claro de synth se a Lambda referenciada não
    existir em nenhuma stack do projeto.
  - `iacmp deploy`/`destroy` ordenam as stacks pela dependência de
    export/import detectada nos templates (`orderByDependency`, em
    `synth-out.ts`) — quem exporta sobe antes de quem importa no deploy, e
    é destruído depois no destroy. Sem isso, mesmo com a referência correta,
    o deploy real falharia com "export not found" ao subir a API antes da
    Lambda.
  - Escopo: só AWS nesta entrega. Azure tem suspeita do mesmo bug de
    referência cross-stack via `reference(resourceId(...))`, não investigada
    ainda — GCP e Terraform não têm esse problema (GCP usa URL HTTPS
    previsível, Terraform opera no diretório inteiro como um state único).
- **Listagem raiz do `--help` mostra um exemplo por comando** — nova classe
  `IacmpHelp` (`packages/cli/src/help.ts`, registrada via `oclif.helpClass`
  no `package.json`) sobrescreve a formatação de comandos do oclif para
  incluir o primeiro `static examples` de cada comando direto em `iacmp`
  (sem args) ou `iacmp --help`, em vez de só a descrição de uma linha. O
  `--help` por comando individual continua mostrando todos os exemplos.
  Corrigido também um bug relacionado: o `build` do CLI não regenerava
  `oclif.manifest.json` (só o `prepack` fazia isso), então comandos
  modificados localmente podiam mostrar `--help` com flags/exemplos
  desatualizados; agora `npm run build` sempre regenera o manifest.
- **`iacmp deploy`/`iacmp destroy` fazem deploy real** — deixam de ser
  simulação (dry-run forçado) e passam a chamar a CLI nativa de cada provider
  via subprocess: `aws cloudformation package`+`deploy` (AWS, criando e
  reusando automaticamente um bucket S3 próprio,
  `iacmp-deploy-artifacts-<conta>-<região>`, para o código de Lambda),
  `az stack group create`/`delete` (Azure, via Deployment Stacks),
  `gcloud deployment-manager deployments create`/`update` (GCP, escolhendo
  automaticamente entre criar e atualizar) e `terraform init`+`apply`/`destroy`
  (Terraform, operando no diretório `synth-out/terraform/` inteiro). Nova flag
  `--dry-run` em ambos os comandos mostra os comandos exatos sem executar
  nada. Novos campos opcionais `resourceGroup` (Azure) e `projectId` (GCP) no
  `iacmp.json`. `iacmp doctor` ganha checagens (+ `--fix`) para Azure CLI,
  gcloud CLI e Terraform CLI. Corrigido também um bug de codegen na AWS: o
  `Code` da Lambda gerava `{ ZipFile: '<caminho-local>' }` (formato inválido
  para deploy real — `ZipFile` espera código inline, não um caminho); agora
  gera o caminho como string simples, formato que `aws cloudformation
  package` reconhece e resolve para S3. **Limitação conhecida:** apenas AWS
  tem o empacotamento de código de função corrigido nesta entrega — Azure
  (Function App), GCP (Cloud Functions) e Terraform ainda não anexam código
  funcional ao recurso criado; correção planejada para a próxima etapa, após
  validação manual desta entrega.
- **Fix:** `aws cloudformation package`/`deploy` não têm um equivalente ao
  `--resolve-s3` do AWS SAM CLI — o `package` exige `--s3-bucket` explícito
  sempre (confundido inicialmente com o SAM CLI, que tem essa flag). O
  executor AWS agora resolve a conta via `aws sts get-caller-identity`,
  deriva um nome determinístico de bucket e cria esse bucket automaticamente
  (`aws s3 mb`) na primeira vez, se ainda não existir, antes do `package`.
- **`.github/workflows/ci.yml`** — pipeline de CI no GitHub Actions com matrix
  de Node 20.x, cache `.turbo/` e `npm cache`, rodando `typecheck`, `test` e
  `build` via Turborepo.
- **`LICENSE`** — arquivo MIT na raiz (DOC-05/DX-06). Copiado para
  `packages/cli/` e `packages/core/` no `prepack` para acompanhar os pacotes
  publicados no npm.
- **`CONTRIBUTING.md`** — stub na raiz apontando para `docs/contribuindo.md`.
- **`.env.example`** — template versionado com `ANTHROPIC_API_KEY` e
  `GITHUB_TOKEN` documentados.
- Versões alinhadas em `1.1.0` em todos os 10 `package.json` do workspace
  (DOC-04). Antes alguns ainda estavam em `1.0.0`.
- Documentação de **todos os 13 namespaces** de constructs em
  `docs/constructs.md` (DOC-06) — antes só 5 estavam documentados.

### Corrigido

- `iacmp.json` malformado agora **propaga erro** em `loadPlugins` em vez de
  cair silenciosamente em `[]` (ARCH-07). Plugins com export ambíguo
  (`default` vs `module.exports`) são normalizados via `m.default ?? m`.
- `packages/cli/package.json` ganha `LICENSE` em `files` e cópia automática
  no `prepack` — antes o pacote npm ia sem licença apesar do `"license":"MIT"`.
- `turbo.json`: a task `test` deixa de depender de `build` (ARCH-09) — ts-jest
  opera sobre `src` direto. `outputs` da `test` agora cobrem `coverage/**` e
  `inputs` listam `src/**`, `test/**`, `tsconfig.*.json`, `jest.config.*` e
  `package.json` para caching efetivo (DX-09).
- `MVP-STATUS.md` virou pointer para README/changelog (DOC-01). Antes dizia
  "apenas AWS" e cravava paths `/Users/cmelo/`.
- `docs/faq.md`, `docs/manual-de-uso.md`, `docs/providers.md` agora descrevem
  o layout real `synth-out/<provider>/<stack>.<ext>` (DOC-08) e o uso de
  `ts-node` (DOC-09) — o synth registra ts-node quando disponível no projeto,
  não automaticamente.
- `docs/estudo-rag.md` reformulado como "Arquitetura (estado atual)" + seção
  "Próximos passos" (DOC-03). Boa parte do que era "plano" já existe.
- `docs/contribuindo.md`: exemplo de "novo construct" reescrito para o padrão
  real (namespace, `*Props`, `implements BaseConstruct`, `stack.addConstruct`)
  copiando `cache.ts` (DOC-07). URL de clone padronizada para
  `https://github.com/Claudio-Fontes/iacmp` (DOC-12).
- `docs/manual-de-uso.md`: removida contradição "Fase 3 vs Disponível" em
  `iacmp ai` (DOC-11).
- README: índice de docs lista todos os 10 arquivos em `docs/` (antes faltavam
  3); URLs do GitHub alinhadas (DOC-12).

### Higiene

- `.gitignore` cobre `.iacmp/` (SEC-08), `tmp/` e `.DS_Store` (DX-05). Removido
  `tmp/test-init-compute/**` do índice via `git rm --cached`.

---

## [1.1.0] — 2026-06-13

Templates no `init`, auditorias e diagramas de arquitetura.

### Adicionado

- **`iacmp init --template <nome>`** — 6 templates de stack embutidos no CLI: `default`, `rds`, `webapp`, `network`, `serverless`, `fullstack`. O nome do projeto é interpolado automaticamente. Funciona após `npm install -g iacmp` sem dependência de paths externos.
- **`iacmp init --list`** — lista todos os templates com descrição e constructs incluídos.
- **`iacmp diagram`** — gera diagramas de arquitetura a partir das stacks do projeto
  - `--format structurizr` (padrão) — gera `diagrams/workspace.dsl` com styles C4, `autoLayout` e relações inferidas marcadas
  - `--format mermaid` — gera `diagrams/workspace.md` com blocos `graph TD` por stack, emojis por tipo e legenda de recursos; renderizado automaticamente no GitHub/GitLab/Notion
  - `--stack <nome>` — filtra uma stack específica
  - `--out <dir>` — diretório de saída configurável (padrão: `diagrams/`)
  - Módulo interno `src/diagram/` com `model.ts`, `builder.ts`, `structurizr.ts` e `mermaid.ts`
  - Inferência conservadora: VPC única → seta tracejada para os demais constructs, rotulada como `[inferred]`
- **5 comandos de auditoria** com relatórios Markdown em `audit/`
  - `iacmp audit-security` — acesso público, versionamento, Multi-AZ, memória Lambda, CIDR
  - `iacmp audit-ha` — Single-AZ em banco/VPC, instância sem redundância, Lambda/S3 como HA nativa
  - `iacmp audit-dr` — score /10 com checklist, versionamento, Multi-AZ, rede multi-AZ
  - `iacmp audit-improvements` — sugestões de performance e arquitetura com impacto e esforço
  - `iacmp audit-all` — roda os 4 em sequência
- **`docs/plano-diagramas-stacks.md`** — plano de arquitetura revisado com decisões de estrutura, roadmap de formatos e critérios de aceite

---

## [1.0.0] — 2026-06-13

Fase 5 — Produção.

### Adicionado

- **Testes de integração** — suite Jest com ts-jest cobrindo todos os providers nativos
  - `packages/core/test/stack.test.ts` — 7 testes: Stack e todos os constructs (Compute, Storage, Network, Database, Fn)
  - `packages/providers/aws/test/cloudformation.test.ts` — 8 testes: CloudFormation, mapeamento de tipos, versioning, VPC, RDS, Lambda
  - `packages/providers/azure/test/arm.test.ts` — 2 testes: ARM Template, VM e Storage Account
  - `packages/providers/terraform/test/hcl.test.ts` — 3 testes: blocos HCL, aws_instance, aws_s3_bucket
  - Pipeline `test` adicionado ao `turbo.json` e `npm test` à raiz
- **Documentação completa**
  - `docs/arquitetura.md` — arquitetura interna do monorepo, fluxo de `iacmp synth`, fluxo de `iacmp ai`, plugin system e guia de novo provider
  - `docs/faq.md` — 10 perguntas frequentes cobrindo ts-node, API keys, deploy real, synth-out, múltiplas stacks, providers customizados
  - `docs/publicacao-npm.md` — guia de publicação no npm com checklist e comandos
- **Exemplos de projetos reais** em `examples/`
  - `examples/webapp/` — site estático com VPC, bucket público e bucket privado
  - `examples/database/` — banco RDS Multi-AZ com VPC e réplica
  - `examples/network/` — rede completa com VPC, bastion e app server
  - Todos funcionais: `iacmp synth` gera CloudFormation JSON válido
- **Versão 1.0.0** em todos os packages do monorepo
- **`iacmp synth`** — busca `ts-node` em diretórios pai (suporte a monorepo e exemplos sem node_modules local)

---

## [0.4.0] — 2026-06-13

Fase 4 — DX & Ecossistema.

### Adicionado

- **`@iacmp/plugin-sdk`** — SDK para criação de providers customizados por terceiros
  - `plugin.ts` — interfaces `IacmpProvider` e `IacmpPlugin` + função `definePlugin()`
  - `loader.ts` — `loadPlugins()`: lê campo `plugins` do `iacmp.json` e carrega providers via `require()` com debounce de erros
- **`@iacmp/dashboard`** — pacote do dashboard web de visualização de stacks
  - `server.ts` — servidor HTTP nativo (sem dependências externas)
  - `ui.ts` — geração de HTML com tema escuro, cards por stack, tabela de recursos, tudo inline
  - `index.ts` — `startDashboard()` exportável
- **`@iacmp/registry`** — cliente do registry de constructs da comunidade
  - `registry.json` — registry local com 3 constructs de exemplo: `WebApp.Static`, `Queue.SQS`, `Auth.Cognito`
  - `client.ts` — `listConstructs()` e `searchConstructs(term)`
- **`iacmp watch`** — novo comando CLI
  - Monitora `stacks/` recursivamente com `fs.watch()` nativo
  - Debounce de 300ms para evitar synths duplicados em saves rápidos
  - Executa `iacmp synth` automaticamente ao detectar mudanças
  - Imprime timestamp `[HH:MM:SS]`, nome do arquivo alterado e resultado (✓/✗)
- **`iacmp dashboard`** — novo comando CLI
  - Serve dashboard HTTP na porta configurável (padrão: 4000)
  - Lê `synth-out/` e exibe stacks e recursos em tempo real
  - Flag `--open` para abrir o browser automaticamente
- **`iacmp registry`** — novo comando CLI
  - `iacmp registry list` — lista todos os constructs em tabela formatada
  - `iacmp registry search <termo>` — filtra por nome, pacote ou descrição
- **Plugin system no `iacmp synth`** — integração com plugins carregados
  - Se o provider não for nativo, busca em plugins carregados via `loadPlugins()`
  - Plugin de exemplo em `examples/plugin-exemplo/` (Digital Ocean simulado)
- **CI/CD gerado pelo `iacmp init`**
  - `.github/workflows/iacmp.yml` — GitHub Actions: checkout, setup-node, `npm ci`, `iacmp synth`, `npm test`
  - `.gitlab-ci.yml` — GitLab CI: image node:20, script: `npm ci`, `iacmp synth`, `npm test`
- **`iacmp doctor`** — nova verificação de plugins
  - Se `iacmp.json` tiver campo `plugins`, lista cada plugin e indica se foi carregado com sucesso

---

## [0.3.0] — 2026-06-13

Fase 3 — Módulo AI.

### Adicionado

- **`@iacmp/ai`** — pacote com toda a lógica de geração de stacks via IA
  - `providers/base.ts` — interfaces `AIProvider`, `AIMessage`, `AIResponse`
  - `providers/anthropic.ts` — `AnthropicProvider` com suporte a chat e streaming (modelo `claude-sonnet-4-6`)
  - `providers/copilot.ts` — `CopilotProvider` via GitHub Copilot API (`gpt-4o`, SSE streaming)
  - `prompts/system-prompt.ts` — system prompt completo com instruções de geração, migração, documentação e otimização de custo; placeholder `{PROJECT_CONTEXT}` substituído em runtime
  - `parser/code-extractor.ts` — extrai e valida JSON do response da IA (suporte a JSON puro, blocos markdown e heurística `{...}`)
  - `parser/validator.ts` — valida TypeScript gerado com `tsc --noEmit` em diretório temporário
  - `chat/session.ts` — `ChatSession` com histórico de mensagens
  - `chat/renderer.ts` — spinner, explicação, warnings, next steps e streaming chunk-a-chunk
  - `tools/diff-renderer.ts` — diff colorido de arquivos novos/modificados com aprovação via `readline`
  - `tools/file-writer.ts` — escreve arquivos após aprovação do diff; suporte a `--dry-run`
  - `tools/context-reader.ts` — lê `iacmp.json` e stacks existentes para injetar contexto no prompt
  - `tools/synth-runner.ts` — executa `iacmp synth` após geração
- **`iacmp ai`** — novo comando CLI
  - Modo comando único: `iacmp ai "descrição"` — gera stack, valida, exibe diff, pede aprovação
  - Modo chat: `iacmp ai --chat` — loop interativo com comandos `/sair` e `/limpar`
  - Flag `--dry-run` — exibe arquivos que seriam gerados sem salvar nada
  - Flag `--provider` — sobrescreve provider do `iacmp.json`
  - Retry automático em caso de erro TypeScript (1 tentativa)
  - Detecção de provider: `ANTHROPIC_API_KEY` tem prioridade sobre `GITHUB_TOKEN`
  - Mensagem de erro clara quando nenhuma API key está configurada

---

## [0.2.0] — 2026-06-13

Fase 2 — Multi-cloud.

### Adicionado

- **`@iacmp/provider-azure`** — síntese de constructs para ARM Template JSON
  - `Compute.Instance` → `Microsoft.Compute/virtualMachines`
  - `Storage.Bucket` → `Microsoft.Storage/storageAccounts` (kind `StorageV2`)
  - `Network.VPC` → `Microsoft.Network/virtualNetworks`
  - `Database.SQL` → `Microsoft.Sql/servers` + `Microsoft.Sql/servers/databases`
  - `Fn.Lambda` → `Microsoft.Web/sites` (kind `functionapp`)
- **`@iacmp/provider-gcp`** — síntese de constructs para GCP Deployment Manager JSON
  - `Compute.Instance` → `compute.v1.instance`
  - `Storage.Bucket` → `storage.v1.bucket`
  - `Network.VPC` → `compute.v1.network`
  - `Database.SQL` → `sqladmin.v1beta4.instance`
  - `Fn.Lambda` → `cloudfunctions.v2.function`
- **`@iacmp/provider-terraform`** — síntese de constructs para HCL (`.tf`)
  - `Compute.Instance` → `resource "aws_instance"`
  - `Storage.Bucket` → `resource "aws_s3_bucket"`
  - `Network.VPC` → `resource "aws_vpc"`
  - `Database.SQL` → `resource "aws_db_instance"`
  - `Fn.Lambda` → `resource "aws_lambda_function"`
- **`iacmp diff`** — compara synth anterior com o atual, exibe diff colorido linha a linha
- **`iacmp synth`** — suporte a providers `azure`, `gcp` e `terraform` (além de `aws`)
- **`iacmp deploy`** — mensagens específicas por provider
- **`iacmp init --language python`** — cria `stacks/exemplo_stack.py` como placeholder para Fase 3
- **`iacmp init --provider`** — flag para definir provider padrão no `iacmp.json`

---

## [0.1.0] — 2026-06-13

Primeira versão do iacmp — MVP da Fase 1.

### Adicionado

- Monorepo com Turborepo (`@iacmp/core`, `@iacmp/provider-aws`, `iacmp`)
- **`@iacmp/core`** — 5 constructs agnósticos ao provider:
  - `Compute.Instance` — máquinas virtuais
  - `Storage.Bucket` — object storage
  - `Network.VPC` — redes privadas virtuais
  - `Database.SQL` — bancos relacionais gerenciados
  - `Fn.Lambda` — funções serverless
- **`@iacmp/provider-aws`** — síntese de constructs para CloudFormation JSON
- **CLI `iacmp`** com 6 comandos:
  - `iacmp init` — inicializa projeto com `iacmp.json` e `stacks/`
  - `iacmp synth` — sintetiza stacks para o formato nativo do provider
  - `iacmp deploy` — faz deploy das stacks no provider
  - `iacmp destroy` — destrói a infraestrutura (com confirmação)
  - `iacmp ls` — lista stacks do projeto
  - `iacmp doctor` — verifica ambiente e dependências
- Documentação inicial: manual de uso, referência de constructs, referência de providers, guia de contribuição

### Limitações desta versão

- `deploy` e `destroy` são simulados — sem chamadas reais à AWS
- Apenas provider AWS disponível
- `iacmp ai` (geração por IA) disponível na Fase 3
- Providers Azure, GCP e Terraform disponíveis na Fase 2

---

## Próximas versões (planejado)

### [0.2.0] — Fase 2 · Multi-cloud

- Provider Azure (Bicep / ARM Template)
- Provider GCP (Deployment Manager)
- Provider Terraform (HCL via CDKTF)
- `iacmp diff` — visualiza diferenças antes do deploy
- `iacmp doctor` com checagem de Azure CLI e gcloud

### [0.3.0] — Fase 3 · Módulo AI

- `iacmp ai "descrição"` — gera stack via IA (Claude / GitHub Copilot)
- `iacmp ai --chat` — modo chat interativo
- `iacmp ai --dry-run` — prévia sem escrever arquivos
- Diff colorido com aprovação obrigatória antes de salvar arquivos gerados
- `ANTHROPIC_API_KEY` obrigatório a partir desta versão para `iacmp ai`

### [0.4.0] — Fase 4 · DX & Ecossistema

- `iacmp watch` — hot deploy ao detectar mudanças
- Plugin system para providers customizados
- Registry de constructs da comunidade
- Integrações com GitHub Actions e GitLab CI
