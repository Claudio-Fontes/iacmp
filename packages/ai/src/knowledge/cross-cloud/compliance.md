# Compliance Multi-Cloud

GDPR, SOC 2, HIPAA, PCI-DSS e o modelo de responsabilidade compartilhada nas três clouds.

---

## Shared Responsibility Model

O princípio fundamental de compliance em nuvem: a responsabilidade é dividida entre o provedor de cloud e o cliente.

### AWS Shared Responsibility
- **AWS é responsável por**: segurança "da" cloud — hardware, software de virtualização, rede física, datacenter físico, regiões, AZs, Edge Locations
- **Cliente é responsável por**: segurança "na" cloud — dados, criptografia de dados, identity & access management, configuração de SO (para IaaS), configuração de rede, código da aplicação

**Exemplo prático EC2**:
- AWS: hipervisor, hardware físico, segurança do datacenter
- Cliente: SO guest (patching), firewall (security groups/NACLs), dados em disco, IAM roles

**Exemplo prático RDS**:
- AWS: SO do banco, patching do engine (MySQL, PostgreSQL), backups automatizados, HA
- Cliente: configuração de acesso (SG, subnets privadas), criptografia em repouso (KMS), dados armazenados, IAM para acesso ao RDS

**Exemplo prático Lambda**:
- AWS: execução do container, SO, runtime, patching
- Cliente: código da função, dependências (vulnerabilidades em libs), variáveis de ambiente (secrets management), IAM role da função

### Azure Shared Responsibility
Mais granular — depende do modelo de serviço (IaaS vs PaaS vs SaaS):

| Responsabilidade | On-prem | IaaS | PaaS | SaaS |
|---|---|---|---|---|
| Dados e identidades | Cliente | Cliente | Cliente | Cliente |
| Endpoints | Cliente | Cliente | Cliente | Shared |
| Aplicação | Cliente | Cliente | Shared | Microsoft |
| Network controls | Cliente | Cliente | Shared | Microsoft |
| SO | Cliente | Cliente | Microsoft | Microsoft |
| Physical infra | Cliente | Microsoft | Microsoft | Microsoft |

### GCP Shared Responsibility
Similar ao Azure. Google adiciona conceito de "Shared Fate" — Google está igualmente comprometida em ajudar clientes a terem postura segura (não apenas declarar responsabilidade).

---

## GDPR (General Data Protection Regulation)

Regulamento europeu de proteção de dados — aplica a qualquer organização que processa dados de residentes da UE, independente de onde a organização está sediada.

### Princípios fundamentais
- **Lawfulness**: processamento deve ter base legal (consentimento, contrato, obrigação legal, interesse legítimo)
- **Purpose Limitation**: coletar dados apenas para propósitos específicos e declarados
- **Data Minimization**: coletar apenas o mínimo necessário
- **Accuracy**: manter dados precisos e atualizados
- **Storage Limitation**: não reter dados além do necessário
- **Integrity & Confidentiality**: proteção técnica adequada

### Direitos dos titulares
- Acesso: ver quais dados você tem sobre eles
- Retificação: corrigir dados incorretos
- Apagamento ("direito ao esquecimento"): deletar dados quando não há mais base legal
- Portabilidade: receber dados em formato machine-readable
- Oposição: opor-se ao processamento em certas circunstâncias

### Implementação nas clouds

**AWS para GDPR**
- **Regiões EU**: eu-west-1 (Ireland), eu-west-2 (London), eu-west-3 (Paris), eu-central-1 (Frankfurt), eu-north-1 (Stockholm), eu-south-1 (Milan)
- **Data Residency**: não há garantia automática — configurar Guardrails no AWS Organizations com SCP que proíbe criação de recursos fora de regiões EU
- **DPA (Data Processing Agreement)**: disponível no AWS Artifact — obrigatório assinar para processar dados pessoais EU
- **Ferramentas de compliance**: AWS Macie (descobre PII automaticamente em S3), Amazon Comprehend (detecta PII em texto), AWS Config Rules para detectar buckets S3 públicos
- **Encryption**: KMS com CMKs para dados pessoais; Envelope Encryption para granularidade por usuário

**Azure para GDPR**
- **Regiões EU**: West Europe (Amsterdam), North Europe (Dublin), France Central, Germany West Central, Sweden Central, Switzerland North, Norway East, etc.
- **Azure Policy**: política built-in "Allowed locations" para restringir recursos a regiões EU
- **Microsoft Customer Agreement** já inclui cláusulas GDPR (DPA incorporado)
- **Azure Purview**: catalogação e classificação de dados pessoais em múltiplas fontes
- **Azure Information Protection**: classificação e proteção de documentos

**GCP para GDPR**
- **Regiões EU**: europe-west1 (Belgium), europe-west2 (London), europe-west3 (Frankfurt), europe-west4 (Netherlands), europe-north1 (Finland), etc.
- **Data Residency Constraints**: Organization Policy `constraints/gcp.resourceLocations` com lista de regiões EU
- **Cloud DLP (Data Loss Prevention)**: descobre, classifica e redige PII em GCS, BigQuery, Datastore
- **DPA**: disponível para download; Data Processing Addendum incorporado nos termos de serviço

---

## SOC 2 (Service Organization Control 2)

Auditoria de controles internos para segurança, disponibilidade, integridade de processamento, confidencialidade e privacidade.

### Trust Service Criteria (TSC)
- **Security** (obrigatório): proteção contra acesso não autorizado
- **Availability**: sistema disponível conforme comprometido
- **Processing Integrity**: processamento completo e preciso
- **Confidentiality**: informações designadas como confidenciais protegidas
- **Privacy**: informações pessoais coletadas, usadas, retidas conforme política

### Tipos
- **SOC 2 Type I**: "nossos controles existem e estão desenhados corretamente" (ponto no tempo)
- **SOC 2 Type II**: "nossos controles funcionaram efetivamente por um período" (6-12 meses) — muito mais valioso

### Certificações dos provedores

| Serviço | AWS | Azure | GCP |
|---|---|---|---|
| Plataforma base | SOC 2 Type II | SOC 2 Type II | SOC 2 Type II |
| Relatórios disponíveis em | AWS Artifact | Microsoft Service Trust Portal | GCP Compliance Reports Manager |

**Importante**: certificação do provedor ≠ certificação do cliente. O cliente precisa auditar seus próprios controles adicionais (acesso, código, processos).

### O que o cliente precisa implementar para SOC 2
- Access Control: princípio de least privilege, MFA, revisão periódica de acessos
- Encryption: dados em repouso e trânsito
- Monitoring: logs de auditoria, alertas de segurança
- Incident Response: processo documentado de resposta a incidentes
- Change Management: processo de revisão e aprovação de mudanças
- Vulnerability Management: scanning regular, patching

---

## HIPAA (Health Insurance Portability and Accountability Act)

Regulamento americano para proteção de informações de saúde (PHI — Protected Health Information).

### O que é PHI
Qualquer informação de saúde que identifica um indivíduo: nome, endereço, data de nascimento, SSN, histórico médico, prontuários, resultados de exames, etc.

### BAA (Business Associate Agreement)
Para processar PHI em um provedor de cloud, OBRIGATÓRIO ter um BAA assinado com o provedor.

- **AWS**: BAA disponível — cobrir a lista de serviços HIPAA Eligible no AWS Artifact
- **Azure**: Microsoft incluiu HIPAA BAA no contrato enterprise para todos os clientes qualificados
- **GCP**: BAA disponível via Google Workspace for Healthcare e Google Cloud Healthcare API

### Serviços HIPAA Eligible

**AWS**: EC2, RDS, S3, Lambda, DynamoDB, CloudWatch, CloudTrail, KMS, SQS, SNS, ECS, EKS, Fargate, API Gateway, Cognito, e muitos outros. Lista completa em aws.amazon.com/compliance/hipaa-eligible-services-reference/

**Azure**: Azure oferece lista de serviços cobertos pelo BAA — inclui praticamente toda a plataforma core (VMs, SQL, Storage, App Service, Functions, AKS, etc.)

**GCP**: Cloud Healthcare API é o serviço específico para dados PHI; além dele, muitos serviços core cobertos pelo BAA

### Controles técnicos HIPAA
- **Encryption**: PHI deve ser criptografado em repouso (AES-256) e em trânsito (TLS 1.2+)
- **Access Control**: MFA, role-based access, audit logs de acesso a PHI
- **Audit Trails**: CloudTrail (AWS), Azure Monitor (Azure), Cloud Audit Logs (GCP) — 6 anos de retenção
- **Backup**: backups de PHI com testes de restore
- **Incident Response**: notificação de breach em 60 dias (para autoridades) e 60 dias (para afetados)

---

## PCI-DSS (Payment Card Industry Data Security Standard)

Padrão de segurança para organizações que processam, armazenam ou transmitem dados de cartão de crédito.

### Dados de cartão (CHD — Cardholder Data)
- **PAN** (Primary Account Number): número do cartão — mais sensível
- Nome do titular
- Data de validade
- Código de serviço

**SAD (Sensitive Authentication Data)** — nunca armazenar após autorização:
- Dados magnéticos completos
- CVV2/CVC2 (código de 3-4 dígitos)
- PINs

### 12 Requisitos do PCI-DSS v4.0

1. Instalar e manter controles de segurança de rede (firewalls)
2. Aplicar configurações seguras em todos os componentes
3. Proteger dados de conta armazenados
4. Proteger dados de conta com criptografia forte em transmissão em redes abertas/públicas
5. Proteger todos os sistemas e redes de software malicioso
6. Desenvolver e manter sistemas e software seguros
7. Restringir acesso a componentes do sistema e dados de conta por "need to know"
8. Identificar usuários e autenticar acesso a componentes do sistema
9. Restringir acesso físico a dados de conta
10. Registrar e monitorar todo o acesso a componentes do sistema e dados de conta
11. Testar segurança de sistemas e redes regularmente
12. Suportar segurança da informação com políticas e programas organizacionais

### CDE (Cardholder Data Environment)
Minimizar o scope de PCI-DSS: sistemas que **armazenam, processam ou transmitem** CHD. Quanto menor o CDE, menos custosa é a auditoria.

Estratégia: usar processadores de pagamento certificados (Stripe, Braintree, Adyen) para nunca tocar nos dados de cartão — reduz CDE drasticamente (apenas a integração via API, sem processar/armazenar CHD).

### PCI em cloud

**AWS**: lista de serviços certificados PCI-DSS em AWS Compliance. Requer Attestation of Compliance (AoC) do cliente separadamente.

**Azure**: PCI-DSS Blueprint disponível — templates ARM que implementam os controles. Relatório de compliance disponível no Service Trust Portal.

**GCP**: serviços core certificados PCI-DSS. GCP oferece o documento Responsibility Matrix para PCI-DSS que detalha quais requisitos são responsabilidade do Google e quais do cliente.

---

## Responsabilidade compartilhada por tipo de compliance

| Requisito | AWS resp. | Azure resp. | GCP resp. | Cliente resp. |
|---|---|---|---|---|
| Segurança física | ✓ | ✓ | ✓ | |
| Hypervisor | ✓ | ✓ | ✓ | |
| Patches do SO (IaaS) | | | | ✓ |
| Patches do SO (PaaS/SaaS) | ✓ | ✓ | ✓ | |
| Criptografia em repouso | Chaves CMK | Chaves CMK | Chaves CMEK | Responsável pela configuração |
| Criptografia em trânsito | Infraestrutura | Infraestrutura | Infraestrutura | Aplicação e config |
| IAM e controle de acesso | Serviço IAM | Serviço AAD/RBAC | Serviço IAM | Configurar e gerenciar |
| Logs de auditoria | CloudTrail | Azure Monitor | Cloud Audit Logs | Habilitar e reter |
| Conformidade da aplicação | | | | ✓ |
| Backup dos dados | Serviço | Serviço | Serviço | Configurar políticas |
| Incident response | Para infra | Para infra | Para infra | Para dados e apps |
