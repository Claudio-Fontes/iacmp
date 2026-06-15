# Gerenciamento de Segredos e Certificados — Secrets Manager, Key Vault, Secret Manager

### AWS Secrets Manager: rotação, integração RDS, versionamento, cross-account, replicação

**Rotação automática**
Lambda function invocada pelo Secrets Manager via scheduled rotation. Quatro etapas do ciclo de rotação:
1. `createSecret`: cria nova versão do segredo com label `AWSPENDING`
2. `setSecret`: aplica a nova credencial no serviço de destino (ex: altera senha no RDS)
3. `testSecret`: valida que a nova credencial funciona
4. `finishSecret`: promove `AWSPENDING` para `AWSCURRENT`, versão anterior passa a `AWSPREVIOUS`

Rotação configurável: por número de dias ou por expressão cron. AWS fornece Lambda blueprints para RDS MySQL/PostgreSQL/Oracle, Redshift e DocumentDB — basta referenciar o blueprint no `RotationLambdaARN`.

**Integração nativa com bancos gerenciados**
- RDS/Aurora: rotação single-user (altera senha do mesmo usuário) ou alternating-user (alterna entre dois usuários — elimina downtime durante rotação)
- Redshift: rotação via blueprint gerenciado
- DocumentDB: rotação via blueprint gerenciado
- Para RDS com Proxy: o Proxy busca credencial do Secrets Manager automaticamente — aplicação nunca manipula a senha diretamente

**Versionamento**
Todo segredo mantém versões identificadas por `VersionId` (UUID) e `VersionStages` (labels):
- `AWSCURRENT`: versão ativa atual
- `AWSPENDING`: versão sendo rotacionada (temporária durante rotação)
- `AWSPREVIOUS`: versão imediatamente anterior (grace period para conexões em andamento)

Versões antigas (sem staging label) são retidas por padrão e podem ser acessadas por `VersionId`. Limpar versões antigas via `UpdateSecretVersionStage` removendo labels ou via `PutSecretValue` que move `AWSPREVIOUS` automaticamente.

**Cross-account access**
Resource-based policy no segredo permite acesso de outra conta AWS. Conta B assume role com permissão, a resource policy do segredo na conta A permite `secretsmanager:GetSecretValue` para o ARN do role da conta B. Criptografia: o KMS key usada no segredo deve também ter key policy permitindo o role da conta B usar `kms:Decrypt`.

**Replicação multi-region**
`AddReplicaRegions` replica o segredo para outras regiões. Réplica é read-only — escrita sempre na região primária, replicação assíncrona para secundárias. Latência de replicação: segundos. Caso de uso: aplicações multi-region que precisam de latência baixa para `GetSecretValue`. Failover: `StopReplicationToReplica` promove réplica a segredo primário independente.

**Custo**
- $0,40 por segredo por mês
- $0,05 por 10.000 chamadas de API
- 30 dias de free trial por segredo novo
- Rotação não tem custo adicional além do custo de execução da Lambda

### AWS Parameter Store vs Secrets Manager

| Critério | Parameter Store (Standard) | Parameter Store (Advanced) | Secrets Manager |
|---|---|---|---|
| Custo | Gratuito | $0,05/parâmetro/mês | $0,40/segredo/mês |
| Rotação automática | Não | Não | Sim (via Lambda) |
| Criptografia | KMS (SecureString) | KMS (SecureString) | KMS (obrigatório) |
| Versionamento | Sim (últimas 100 versões) | Sim | Sim (ilimitado) |
| Cross-account | Não nativo | Não | Sim (resource policy) |
| Replicação multi-region | Não | Não | Sim |
| Tamanho máx do valor | 4 KB | 8 KB | 64 KB |
| Throughput | 40 TPS (padrão) / 1.000 (burst) | 1.000 TPS | 2.500 TPS |
| Integração RDS/Redshift | Não | Não | Nativa |
| Referência em CloudFormation | `resolve:ssm` / `resolve:ssm-secure` | Sim | `resolve:secretsmanager` |

**Quando usar Parameter Store**:
- Configurações de aplicação não sensíveis (URLs, flags, versões de artefatos)
- Segredos simples que não precisam de rotação automática
- Hierarquia de configuração via paths (`/app/prod/db_host`)
- Custo é fator crítico e volume de segredos é alto

**Quando usar Secrets Manager**:
- Credenciais de banco que precisam de rotação automática
- Segredos compartilhados entre contas AWS
- Requisito de auditoria de acesso com granularidade por versão
- Integração nativa com RDS Proxy

**GetSecretValue vs GetParameter**: ambas suportam cache client-side. AWS Secrets Manager tem SDK com caching nativo (Java, Python). Para Parameter Store, use SSM Agent ou implemente cache manual com TTL.

### Azure Key Vault: secrets, keys, certificates, RBAC, soft-delete, HSM

**Tipos de objetos**

*Secrets*: valores opacos (connection strings, API keys, passwords). Versionamento automático — cada atualização cria nova versão. Versões têm `enabled`, `notBefore`, `expires` configuráveis. Máximo de 25.000 secrets por vault.

*Keys*: chaves criptográficas RSA (2048, 3072, 4096 bits) ou EC (P-256, P-384, P-521, P-256K). Operações: encrypt, decrypt, sign, verify, wrapKey, unwrapKey. A chave privada nunca sai do vault — operações criptográficas executadas dentro do HSM. Exportável apenas se criada como `exportable`.

*Certificates*: X.509 com gerenciamento de lifecycle completo. Integração com DigiCert e GlobalSign para emissão e renovação automática. Auto-renewal configurável (renovar N dias antes da expiração). Notificação via Event Grid quando certificado expira ou é renovado.

**Access Policies vs RBAC**

*Access Policies (modelo legado)*: permissões concedidas por objeto tipo (secrets, keys, certificates) com granularidade de operação. Principal (usuário, grupo, SP, managed identity) recebe conjunto de permissões no vault inteiro. Limite de 1.024 access policies por vault.

*Azure RBAC (recomendado)*: roles do Azure RBAC aplicados no vault ou em objetos individuais. Roles built-in:
- `Key Vault Administrator`: acesso total a todos os objetos
- `Key Vault Secrets Officer`: CRUD em secrets
- `Key Vault Secrets User`: apenas leitura de secrets (GetSecret)
- `Key Vault Crypto Officer`: CRUD em keys
- `Key Vault Crypto User`: operações criptográficas (encrypt, sign, etc.) sem acesso ao material da chave
- `Key Vault Certificate Officer`: CRUD em certificates
- `Key Vault Reader`: metadados (sem acesso aos valores)

RBAC permite escopo por objeto individual (ex: permissão somente para `/secrets/db-password`). Vantagem crítica sobre Access Policies que são por vault.

**Soft-delete + Purge Protection**
- Soft-delete: objetos deletados entram em estado `deleted` e são retidos por 7-90 dias configuráveis. Recuperáveis via `Recover`. Habilitado por padrão desde 2020, não pode ser desabilitado.
- Purge Protection: impede purge permanente durante o período de retenção. Uma vez habilitado, não pode ser desabilitado. Obrigatório para compliance (impede exclusão irreversível mesmo por administradores). Com purge protection habilitado, o vault também não pode ser excluído permanentemente durante o período de retenção.

**Managed HSM**
Hardware Security Module dedicado (FIPS 140-2 Level 3). Sem multi-tenancy — HSM exclusivo. Controle total das security policies (Security Domain). Keys nunca saem do HSM em plaintext, nem para a Microsoft. Custo: ~$5.000-7.000/mês. Casos de uso: regulatórios com requisito de HSM dedicado (PCI DSS, FIPS), operações de alto volume de crypto.

**Key Vault Standard vs Premium**
- Standard: chaves protegidas por software (não HSM)
- Premium: chaves protegidas por HSM (FIPS 140-2 Level 2), suporte a HSM-backed keys

| | Standard | Premium |
|---|---|---|
| Keys | Software-protected | HSM-protected disponível |
| Custo (ops) | $0,03/10.000 | $0,03/10.000 |
| Custo (chave RSA/mês) | $0,03 | $0,03 (software) / $1,00 (HSM) |

**Private Link**: acessa Key Vault via endpoint privado na VNet. DNS privado resolve para IP interno. Requer desabilitar acesso público ou configurar firewall de IP. Throttling: 2.000 operações por vault por 10 segundos para secrets/certificates; 1.500 para keys HSM.

### GCP Secret Manager: versões, rotação, replication, CMEK

**Estrutura de objetos**
- Secret: container nomeado com metadados e configuração de replicação. Labels para organização e billing.
- SecretVersion: versão imutável do valor. Estado: `ENABLED`, `DISABLED`, `DESTROYED`. Destruição remove o payload mas mantém metadados de auditoria.
- Acesso: `accessSecretVersion(name: "projects/proj/secrets/db-pass/versions/latest")` retorna a versão mais recente habilitada.

**Rotação (Pub/Sub notification)**
Secret Manager não rota automaticamente — ele notifica via Pub/Sub que a rotação é necessária. Configure `rotation.nextRotationTime` e `rotation.rotationPeriod` no secret. Quando `nextRotationTime` é atingido, Pub/Sub publica evento no tópico configurado. Cloud Function ou Cloud Run assina o tópico, cria nova versão do segredo, atualiza o recurso de destino e incrementa `nextRotationTime`. Mais flexível que Secrets Manager (rotação customizável) mas requer mais implementação.

**Replication**

*Automatic replication*: GCP replica o payload em múltiplas regiões automaticamente (distribuição gerenciada pelo GCP). Sem controle de onde os dados repousam — inadequado para compliance geográfico estrito.

*User-managed replication*: especifique as regiões exatas onde o payload será replicado (ex: `us-central1`, `europe-west1`). Necessário para data residency compliance (GDPR, LGPD com dados sensíveis).

| | Automatic | User-managed |
|---|---|---|
| Controle de localização | Nenhum | Total |
| Compliance geográfico | Não garante | Garante |
| CMEK | Não suportado | Sim (por região) |
| Disponibilidade | Alta (multi-region automático) | Depende das regiões escolhidas |

**CMEK (Customer-Managed Encryption Keys)**
Disponível apenas com user-managed replication. Uma chave Cloud KMS por região de replicação. O Secret Manager usa a chave KMS para criptografar o payload antes de armazenar. Revogando acesso ao KMS key, o Secret Manager perde acesso ao payload. Latência adicional de ~10ms para operações de acesso (chamada ao KMS).

**IAM roles**
- `roles/secretmanager.admin`: CRUD em secrets e versões
- `roles/secretmanager.secretAccessor`: acesso ao payload (necessário para aplicações)
- `roles/secretmanager.secretVersionManager`: criar/destruir versões sem acessar payload
- `roles/secretmanager.viewer`: metadados sem payload

**Custo GCP Secret Manager**
- $0,06 por versão ativa por mês
- 6 versões ativas por mês gratuitas
- $0,03 por 10.000 operações de acesso

### ACM (AWS Certificate Manager): DNS validation vs email, wildcard, ALB/CloudFront

**Emissão de certificados**
ACM provê certificados SSL/TLS gratuitos (sem custo para certificados públicos em serviços AWS). Autoridade: Amazon Trust Services (cross-signed com Starfield G2). Validade: 13 meses, renovação automática gerenciada pelo ACM.

**Validação DNS**
Adicione registro CNAME no DNS (`_<hash>.domain.com CNAME _<hash>.acm-validations.aws`). Validação persiste enquanto o registro existir — renovações automáticas futuras não requerem ação. Recomendado para automação (Route 53 pode ser atualizado automaticamente pelo Console/CDK/Terraform).

**Validação por email**
Email enviado para contatos do WHOIS e endereços padronizados (admin@, webmaster@, etc.). Requer ação manual em cada renovação (não é automaticamente renovado). Use apenas quando DNS validation não é viável.

**Certificados wildcard**
`*.domain.com` cobre apenas um nível de subdomínio. Cobre `api.domain.com` mas não `v1.api.domain.com`. Para múltiplos níveis, adicione SANs (Subject Alternative Names) adicionais ou use certificados separados.

**Integração**
- CloudFront: certificado deve estar em `us-east-1` (requisito do CloudFront, independente da região da distribuição)
- ALB/API Gateway/NLB: certificado na mesma região do recurso
- Não exportável: ACM não permite exportar a chave privada para certificados públicos. Para uso fora da AWS (ex: servidor EC2 via NGINX sem ELB), emita via ACM Private CA ou use Let's Encrypt

**ACM Private CA**
Autoridade certificadora privada gerenciada. Custo: $400/mês por CA + $0,75 por certificado privado emitido. Casos de uso: mTLS entre serviços internos, certificados de dispositivos IoT, PKI corporativa. Certificados privados podem ser exportados (chave privada inclusa).

### Integração com aplicações: SDK, sidecar, CSI driver, env injection

**SDK direto**
Chamada à API do secrets manager no startup da aplicação. Implemente cache com TTL para evitar latência em cada request. Pattern recomendado: cache com refresh periódico — busca segredo no início, armazena em memória com TTL de 5 minutos, renova assincronamente antes do TTL expirar para evitar latência de cache miss em produção.

**Sidecar / Init Container (Kubernetes)**
Init container roda antes do container principal, busca secrets e escreve em volume compartilhado (`emptyDir` ou `tmpfs`). Container principal lê do filesystem. Vantagem: aplicação não precisa conhecer a API do secrets manager. HashiCorp Vault Agent usa este padrão.

**CSI Driver — Secrets Store CSI Driver**
Driver Kubernetes que monta secrets como volumes de filesystem ou projeta como variáveis de ambiente. Providers: AWS (aws-secrets-manager), Azure (azure keyvault), GCP (gcp-secret-manager). Rotação: `SecretProviderClass` com `autoRotation: true` atualiza o volume quando o segredo muda no provider (polling interval configurável). Evita restart do pod para rotação.

**External Secrets Operator (ESO)**
Controller Kubernetes que sincroniza secrets do provider para `Secret` objects nativos do Kubernetes. `ExternalSecret` CRD mapeia secret do provider para Secret Kubernetes. Vantagem: aplicação usa `envFrom` ou volume normal sem saber que veio de Secrets Manager. Desvantagem: secret existe no etcd do Kubernetes (criptografia do etcd é responsabilidade do cluster).

**Variáveis de ambiente — anti-padrão para secrets**
Injetar secrets como env vars é conveniente mas tem riscos: env vars aparecem em dumps de processo, logs de debug (`printenv`), e são herdadas por processos filhos. Prefira filesystem (`/run/secrets`) ou SDK com cache.

### Auditoria: CloudTrail, Key Vault Diagnostic Logs, GCP Audit Logs

**AWS CloudTrail + Secrets Manager**
Toda chamada `GetSecretValue`, `PutSecretValue`, `DeleteSecret`, `RotateSecret` registrada no CloudTrail. Event inclui: `userIdentity` (quem), `sourceIPAddress`, `eventTime`, `requestParameters` (nome do segredo, VersionId). Não inclui o valor do segredo. CloudTrail Lake para queries SQL sobre eventos históricos.

Alerta útil: EventBridge rule em `GetSecretValue` fora de horário comercial ou de IPs não esperados → SNS → PagerDuty.

**Azure Key Vault Diagnostic Logs**
Habilite `AuditEvent` no Diagnostic Settings do vault. Envia para Log Analytics, Storage Account ou Event Hub. Campos relevantes: `operationName` (SecretGet, KeySign, etc.), `identity` (quem), `resultType` (Success/Failure), `properties.id` (qual objeto).

Query Log Analytics para acesso a secrets específicos:
```kusto
AzureDiagnostics
| where ResourceType == "VAULTS" and OperationName == "SecretGet"
| where id_s contains "db-password"
| summarize count() by identity_claim_upn_s, bin(TimeGenerated, 1h)
```

**GCP Audit Logs — Secret Manager**
Cloud Audit Logs em Data Access para Secret Manager. Habilite `DATA_READ` para capturar `AccessSecretVersion`. Campos: `principalEmail`, `methodName` (`google.cloud.secretmanager.v1.SecretManagerService.AccessSecretVersion`), `resourceName` (projeto/secret/versão). Exporte para BigQuery via Log Sink para análise histórica.

Todos os três providers: a auditoria captura *quem* acessou *qual* segredo *quando*, mas nunca o valor do segredo em si. Retenção recomendada: 1 ano mínimo para compliance.

### Rotação sem downtime: versionamento e grace period

**Problema**
Enquanto a rotação está em andamento, conexões ativas usam a credencial antiga. Trocar a credencial no backend antes de atualizar o segredo causa falhas nas conexões existentes.

**Sequência correta (dual-version pattern)**

1. Criar nova credencial no serviço de destino (nova senha RDS, novo API key) — credencial antiga ainda ativa
2. Criar nova versão do segredo com `AWSPENDING` (Secrets Manager) ou nova versão desabilitada (GCP) ou nova versão inativa (Key Vault)
3. Testar que a nova credencial funciona
4. Promover nova versão para `AWSCURRENT` / habilitar versão / ativar versão
5. Versão anterior passa a `AWSPREVIOUS` — grace period de 5-15 minutos onde ambas as versões são válidas no serviço de destino
6. Após grace period, desabilitar/revogar credencial antiga no serviço de destino
7. Versão anterior pode ser destruída ou mantida para auditoria

**Grace period na prática**
Aplicações que cachéiam a credencial antiga continuarão funcionando durante o grace period. Quando o cache expirar e a aplicação buscar a credencial atualizada, já encontrará `AWSCURRENT` com a nova versão. Sem grace period, a janela entre passo 4 e o refresh do cache causa erro de autenticação.

Duração do grace period deve ser >= TTL de cache da aplicação + tempo de deploy mais lento.

**Referência a AWSCURRENT vs VersionId**
No código, sempre referencie `AWSCURRENT` (ou `latest`). Nunca hardcode a `VersionId`. Para RDS Proxy com Secrets Manager: o Proxy automaticamente tenta `AWSCURRENT` e, em caso de falha, `AWSPREVIOUS` durante a rotação — implementa grace period transparentemente.

**Rotação de chaves KMS (key rotation)**
Diferente de rotação de secrets. KMS key rotation cria novo material criptográfico mantendo o mesmo KeyId. Dados criptografados com material antigo ainda são descriptografados (KMS mantém material antigo). Habilitado com `EnableKeyRotation: true`. Annual rotation (automática) ou on-demand rotation (manual, disponível desde 2023). Azure Key Vault: `key-rotation-policy` com `lifetimeActions` configura rotação automática de keys. GCP KMS: `cryptoKeyVersionTemplate` com `rotationPeriod` e `nextRotationTime`.
