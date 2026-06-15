# GCP IAM (Identity and Access Management)

O modelo IAM do GCP é fundamentalmente diferente do AWS e Azure — entender essas diferenças é crítico para evitar erros de segurança.

---

## Modelo fundamental: Recurso-cêntrico vs Role-cêntrico

### AWS
Permissões são attached a identidades (IAM roles/users/groups) via políticas. A identidade "carrega" as permissões para onde vai.

### Azure
RBAC: role assignment = (identidade, role, scope). Hierárquico: sub → RG → resource.

### GCP (diferente dos dois)
IAM policy é uma propriedade de **cada recurso individualmente**. Você define "quem tem qual role NESTE recurso" no próprio recurso. Não existe uma política central attached à identidade.

A equação: `member + role + resource = permissão`

Cada recurso tem seu próprio IAM policy (getIamPolicy/setIamPolicy). Permissões são herdadas da hierarquia de recursos para baixo (Organization → Folder → Project → Resource), mas cada nível pode ter sua própria policy adicional.

---

## Hierarquia de recursos

```
Organization
  └── Folders (opcional, para agrupamento)
        └── Projects ← unidade fundamental de isolamento
              └── Resources (GCS, GCE, GKE, Cloud SQL, etc.)
```

**Project** é o equivalente funcional de uma AWS Account ou Azure Subscription para fins de billing e controle de acesso.

IAM policies são avaliadas com union (OR) das policies em cada nível da hierarquia — permissões não são bloqueadas por um nível filho mesmo que o pai tenha concedido.

**Nota crítica**: diferente do AWS, no GCP **não existe Deny explícito** em IAM policies — qualquer Allow em qualquer nível da hierarquia concede acesso. Para negar, use **Organization Policies** (constraint-based).

---

## Types of Members (Principals)

| Tipo | Sintaxe | Descrição |
|---|---|---|
| Google Account | `user:email@gmail.com` | Conta pessoal Google |
| Service Account | `serviceAccount:sa@project.iam.gserviceaccount.com` | Identidade de aplicação/workload |
| Google Group | `group:grupo@example.com` | Grupo de usuários no Google Workspace |
| Google Workspace domain | `domain:example.com` | Todos os usuários do domínio |
| Cloud Identity domain | `domain:example.com` | Idem, para Cloud Identity |
| allAuthenticatedUsers | `allAuthenticatedUsers` | Qualquer conta Google autenticada (cuidado!) |
| allUsers | `allUsers` | Qualquer pessoa, autenticada ou não (público) |

---

## Roles

### Tipos de roles

**Basic Roles** (legado — evitar em produção)
- `roles/viewer`: leitura de todos os recursos
- `roles/editor`: viewer + criar/deletar recursos
- `roles/owner`: editor + IAM + billing
Problema: muito amplas, não respeitam least privilege.

**Predefined Roles**
Roles gerenciadas pela Google por serviço, com granularidade adequada:
- `roles/storage.objectViewer`: leitura de objetos GCS
- `roles/storage.objectCreator`: criar objetos (sem listar)
- `roles/storage.objectAdmin`: CRUD completo em objetos
- `roles/bigquery.dataViewer`: leitura de dados do BigQuery
- `roles/bigquery.jobUser`: executar jobs (queries)
- `roles/bigquery.dataEditor`: editar dados
- `roles/run.invoker`: invocar Cloud Run services
- `roles/cloudsql.client`: conectar ao Cloud SQL
- `roles/pubsub.subscriber`: consumir mensagens
- `roles/pubsub.publisher`: publicar mensagens
- `roles/container.developer`: acesso ao GKE cluster
- `roles/logging.logWriter`: escrever logs (para service accounts de workloads)
- `roles/monitoring.metricWriter`: escrever métricas

**Custom Roles**
Roles definidas pelo usuário com permissões granulares específicas.

---

## Service Accounts

A identidade mais importante para workloads no GCP.

### Tipos
- **Default Service Account**: criada automaticamente por alguns serviços (Compute, App Engine) — projeto@appspot.gserviceaccount.com. **Evitar usar** — tem permissões excessivas por padrão (Editor!)
- **User-managed Service Account**: criada pelo usuário com permissões mínimas necessárias

### Criação e uso
```bash
# Cria service account
gcloud iam service-accounts create my-sa \
  --display-name="Minha Service Account"

# Concede role no nível de projeto
gcloud projects add-iam-policy-binding my-project \
  --member="serviceAccount:my-sa@my-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"

# Concede role no nível de recurso específico (bucket)
gsutil iam ch serviceAccount:my-sa@my-project.iam.gserviceaccount.com:objectViewer gs://meu-bucket
```

### Service Account Keys (evitar quando possível)
- JSON key file com credenciais privadas — risco de vazamento
- Alternativa preferida: Workload Identity para GKE ou Compute Engine com SA attached

### Impersonation
Uma service account pode assumir temporariamente a identidade de outra SA:
```bash
gcloud iam service-accounts add-iam-policy-binding target-sa@project.iam.gserviceaccount.com \
  --member="serviceAccount:caller-sa@project.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

---

## Workload Identity

Substitui Service Account Keys para workloads no GKE e em ambientes externos (GitHub Actions, AWS, Azure).

### GKE Workload Identity

**Problema resolvido**: Pods em GKE precisam acessar serviços GCP (Cloud Storage, Pub/Sub, etc.) sem armazenar SA keys.

**Como funciona**:
1. Ativa Workload Identity no cluster GKE
2. Cria Kubernetes Service Account (KSA) no namespace
3. Cria Google Service Account (GSA)
4. Vincula KSA à GSA via annotation e IAM binding
5. Pod usando KSA obtém token GSA via Workload Identity metadata server

```bash
# 1. Ativar no cluster
gcloud container clusters update CLUSTER \
  --workload-pool=PROJECT_ID.svc.id.goog

# 2. Criar GSA
gcloud iam service-accounts create gsa-nome

# 3. Binding KSA → GSA
gcloud iam service-accounts add-iam-policy-binding gsa-nome@PROJECT.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:PROJECT.svc.id.goog[NAMESPACE/KSA_NAME]"

# 4. Annotation no KSA
kubectl annotate serviceaccount KSA_NAME \
  iam.gke.io/gcp-service-account=gsa-nome@PROJECT.iam.gserviceaccount.com
```

### Workload Identity Federation (externo ao GCP)

Para GitHub Actions, AWS, Azure AD, ou qualquer OIDC/SAML provider acessar GCP sem SA keys:

1. Cria Workload Identity Pool
2. Configura Provider (GitHub OIDC, AWS, etc.)
3. Vincula identidade externa à GSA
4. Workload obtém token GCP usando short-lived credentials

```bash
# Pool
gcloud iam workload-identity-pools create github-pool \
  --location=global

# Provider OIDC (GitHub Actions)
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --workload-identity-pool=github-pool \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --location=global
```

---

## Organization Policies

Mecanismo de **deny** no GCP — constraints que restringem comportamento independente do IAM.

### Diferença IAM vs Org Policy
- IAM: quem PODE fazer o quê
- Org Policy: o que NINGUÉM PODE fazer (exceto com exemption)

### Constraints comuns
- `constraints/compute.requireShieldedVm`: VMs devem usar Shielded VM
- `constraints/compute.vmExternalIpAccess`: proíbe IPs externos em VMs (lista de exceções)
- `constraints/iam.disableServiceAccountKeyCreation`: impede criação de SA keys
- `constraints/iam.allowedPolicyMemberDomains`: permite apenas membros de domínios específicos
- `constraints/storage.uniformBucketLevelAccess`: obriga Uniform Bucket-Level Access no GCS
- `constraints/gcp.resourceLocations`: restringe criação de recursos a regiões específicas
- `constraints/compute.disableSerialPortAccess`: desabilita acesso via serial port
- `constraints/run.allowedIngress`: restringe ingress de Cloud Run (internal, all)

### Níveis de aplicação
Aplicadas em Organization, Folder, ou Project. Herança para baixo — não é possível relaxar um constraint mais restritivo do pai (exceto com tags-based exemption em alguns constraints).

---

## IAM Conditions

Permissões condicionais no IAM — equivalente aos Condition blocks em AWS IAM.

### Exemplos de condições
```yaml
# Acesso apenas durante horário comercial
condition:
  expression: "request.time.getDayOfWeek('America/Sao_Paulo') >= 1 && 
               request.time.getDayOfWeek('America/Sao_Paulo') <= 5"

# Acesso apenas a recursos com tag específica
condition:
  expression: "resource.name.startsWith('projects/my-proj/buckets/dev-')"

# Acesso temporal (expiração)
condition:
  expression: "request.time < timestamp('2024-12-31T23:59:59Z')"
```

---

## Melhores práticas GCP IAM

1. **Nunca use a Default SA com permissão Editor** — crie SAs dedicadas com least privilege
2. **Prefira roles no nível de recurso** quando possível, não no nível de projeto
3. **Use Workload Identity** em vez de SA keys para GKE e CI/CD
4. **Ative Org Policies** restritivas por padrão e afrouxe por exceção
5. **Evite roles/owner** em projetos de produção — use roles granulares
6. **Monitore** com Cloud Audit Logs: Admin Activity (sempre ativo), Data Access (habilitar), System Event
7. **Use Groups** para gerenciar acesso de múltiplos usuários — não atribua IAM bindings individuais para cada pessoa
8. **IAM Recommender**: serviço do Google que analisa logs e recomenda redução de permissões não usadas
