# Azure Identity e Acesso

Visão técnica completa de identidade, autenticação e autorização no Azure.

---

## Microsoft Entra ID (antigo Azure AD)

O Microsoft Entra ID (rebrandeado em 2023) é o serviço de identidade cloud do Azure — equivale ao IAM da AWS mas é muito mais abrangente: é um Identity Provider (IdP) completo.

### Conceitos fundamentais
- **Tenant**: instância do Entra ID — mapeado 1:1 com uma organização
- **Directory**: catálogo de users, groups, apps e service principals
- **Subscription**: vínculo com um tenant para cobrança e recursos Azure
- Um tenant pode ter múltiplas subscriptions; uma subscription tem exatamente um tenant

### Objetos principais
- **User**: conta de pessoa física (membro) ou convidado (guest)
- **Group**: agrupamento de users/service principals para atribuição de permissões em massa
- **Service Principal**: identidade de uma aplicação registrada no Entra ID
- **Managed Identity**: service principal gerenciado automaticamente pelo Azure (sem credencial manual)
- **Application Registration**: registro de uma app — tem AppId (client_id) e pode ter secrets/certificates

### Planos
- **Free**: incluído em todas as subscriptions Azure — funcionalidades básicas
- **P1**: Conditional Access, MFA por usuário, hybrid identity (no P1)
- **P2**: Identity Protection (risk-based policies), Privileged Identity Management (PIM), Access Reviews

---

## Managed Identity

A forma recomendada para recursos Azure autenticarem em outros serviços Azure — sem gerenciamento de credenciais.

### Tipos

**System-assigned**
- Vinculada ao ciclo de vida do recurso — deletou o recurso, deletou a identity
- 1:1 com o recurso
- Habilitada diretamente no recurso

```bicep
resource vm 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  identity: {
    type: 'SystemAssigned'
  }
}
```

**User-assigned**
- Recurso independente — pode ser atribuída a múltiplos recursos
- Lifecycle independente do recurso que a usa
- Útil quando múltiplos recursos precisam das mesmas permissões

```bicep
resource uami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'minha-identidade'
  location: resourceGroup().location
}

resource vm 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uami.id}': {}
    }
  }
}
```

### Como funciona internamente
O recurso obtém token via IMDS (Instance Metadata Service) em `http://169.254.169.254/metadata/identity/oauth2/token`. O Azure injeta o token automaticamente — sem client_secret.

### Serviços que suportam Managed Identity como identidade
App Service, Functions, VMs, AKS, Container Instances, Logic Apps, API Management, Data Factory, e muitos outros.

---

## Service Principal

Identidade de uma aplicação ou serviço no Entra ID. Criado automaticamente quando você registra uma Application.

### Criação via Azure CLI
```bash
# Cria app registration + service principal
az ad sp create-for-rbac --name "minha-app" --role contributor --scopes /subscriptions/{id}
```

### Autenticação
- **Client Secret**: string de senha (expira — máximo 2 anos)
- **Certificate**: mais seguro — X.509 certificate; sem expiração de credencial em si
- **Federated Credential**: Workload Identity Federation — sem secret, baseado em OIDC token (ex: GitHub Actions)

### Workload Identity Federation
Permite que identidades externas (GitHub Actions, Kubernetes SA, AWS roles) obtenham tokens Azure sem credentials armazenadas:

```json
{
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:org/repo:environment:prod",
  "audiences": ["api://AzureADTokenExchange"]
}
```

Equivalente ao AWS AssumeRoleWithWebIdentity / OIDC federation.

---

## RBAC (Role-Based Access Control)

Modelo de autorização do Azure — quem pode fazer o quê em qual escopo.

### Componentes de uma Role Assignment
- **Security Principal**: User, Group, Service Principal, ou Managed Identity
- **Role Definition**: conjunto de permissões (actions, notActions, dataActions, notDataActions)
- **Scope**: Management Group → Subscription → Resource Group → Resource (hierárquico)

### Built-in Roles mais importantes
| Role | Escopo típico | Permissões |
|---|---|---|
| Owner | Subscription/RG | Tudo + atribuir roles |
| Contributor | Subscription/RG | Tudo exceto atribuir roles e gerenciar Azure AD |
| Reader | Subscription/RG | Leitura apenas |
| User Access Administrator | Qualquer | Somente gerenciar role assignments |
| Storage Blob Data Contributor | Storage Account | CRUD em blobs |
| Storage Blob Data Reader | Storage Account | Leitura de blobs |
| Key Vault Secrets User | Key Vault | get/list secrets |
| Key Vault Administrator | Key Vault | Tudo no Key Vault |
| AcrPull | Container Registry | Pull de imagens |
| AcrPush | Container Registry | Pull + Push |
| Monitoring Reader | Qualquer | Leitura de métricas e logs |

### Custom Roles
Quando built-in roles não atendem. Definidas com Actions/NotActions/DataActions/NotDataActions + assignable scopes.

```json
{
  "Name": "Custom VM Restart",
  "Actions": [
    "Microsoft.Compute/virtualMachines/read",
    "Microsoft.Compute/virtualMachines/restart/action",
    "Microsoft.Compute/virtualMachines/deallocate/action"
  ],
  "AssignableScopes": ["/subscriptions/{id}"]
}
```

### Limite de role assignments
- 2000 por subscription (limite hard)
- Use groups para reduzir número de assignments

---

## Conditional Access

Políticas de controle de acesso baseadas em condições — "se X, então Y".

### Condições disponíveis
- Usuário/grupo
- Aplicação de destino (qual app o usuário está acessando)
- Rede (IP ranges, Named Locations, Trusted Locations, Compliant Networks)
- Plataforma do dispositivo (iOS, Android, Windows, macOS, Linux)
- Risco de login (Entra ID Identity Protection risk score: low/medium/high)
- Risco de usuário (risco acumulado da identidade)

### Controles de acesso (Grant)
- Bloquear acesso (Block)
- Requer MFA
- Requer dispositivo Hybrid Azure AD Joined
- Requer dispositivo Compliant (Intune)
- Requer app aprovada (MAM)
- Requer Termos de Uso aceitos

### Session controls
- Sign-in frequency (forçar re-auth após N horas/dias)
- Persistent browser session (não manter sessão)
- App enforced restrictions (SharePoint/Exchange)
- Cloud App Security (Defender for Cloud Apps)

### Requer
Plano Entra ID P1 ou superior.

---

## PIM (Privileged Identity Management)

Ativa roles privilegiadas just-in-time (JIT) em vez de permanentemente — reduz janela de exposição.

### Tipos de assignment
- **Eligible**: usuário pode ativar a role quando precisar (JIT)
- **Active**: role sempre ativa (permanente)

### Fluxo de ativação
1. Usuário solicita ativação da role eligible
2. Justificativa obrigatória + ticket ITSM opcional
3. Aprovação automática ou manual por um approver designado
4. Role ativa por período configurado (ex: 8h)
5. Notificação por email/Teams para auditores

### Recursos adicionais
- Access Reviews: revisão periódica de quem tem acesso — aprovadores confirmam ou revogam
- Alerts: detecção de contas com muitas roles permanentes, roles nunca usadas
- Audit history: log completo de todas as ativações

### Requer
Entra ID P2.

---

## Azure AD B2C (Business to Consumer)

Serviço de identity para aplicações voltadas a usuários externos (clientes) — não funcionários.

### Características
- Tenant separado do tenant corporativo
- Suporte a login social: Google, Facebook, Apple, Microsoft Account, GitHub
- Login com email/senha local
- Customização completa da UX (HTML/CSS/JavaScript)
- Fluxos de usuário ou Políticas customizadas (Identity Experience Framework)
- MFA integrado
- Escala: milhões de usuários, bilhões de autenticações

### User Flows
Fluxos pré-configurados: Sign up/Sign in, Password reset, Profile editing.

### Custom Policies (IEF)
Para cenários avançados: migração de usuários, integração com sistemas legados, lógica de negócio customizada, multi-step MFA.

### Preço
- Gratuito: 50.000 MAU/mês
- Pago: ~$0.00016/autenticação acima de 50k

---

## Azure AD B2B (Business to Business)

Colaboração com usuários externos (parceiros, fornecedores) no seu tenant corporativo.

### Tipos de convidados
- **Member**: acesso similar a usuários internos
- **Guest**: acesso restrito por padrão — não vê diretório completo

### Fluxo de convite
1. Admin ou usuário autorizado envia convite via email ou API
2. Usuário externo aceita — criado como Guest no tenant host
3. Acesso gerenciado via RBAC, Groups, Conditional Access igual a usuários internos

### Cross-tenant access settings
Permite configurar trust de MFA, device compliance e autenticação de outros tenants (Entra ID External Identities cross-tenant).

---

## Entra ID Identity Protection

Detecção e remediação de riscos de identidade usando ML/IA da Microsoft.

### Risk detections
- Anonymous IP address (Tor, VPN)
- Atypical travel (login em dois países em intervalo impossível)
- Malware linked IP address
- Unfamiliar sign-in properties
- Leaked credentials (dark web monitoring)
- Password spray attack
- Azure AD threat intelligence

### Políticas de risco
- **User risk policy**: bloquear acesso ou forçar reset de senha se risco alto
- **Sign-in risk policy**: bloquear ou exigir MFA se risco médio/alto
- Integra com Conditional Access para application-specific policies

### Requer
Entra ID P2.

---

## Hierarquia de gerenciamento de identidade

```
Management Group (raiz)
  └── Management Groups filhos
        └── Subscriptions
              └── Resource Groups
                    └── Resources
```

Role assignments são herdados hierarquicamente (pai → filho). Deny assignments bloqueiam permissões herdadas para recursos específicos.
