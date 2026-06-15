# Segurança AWS

## IAM — Identity and Access Management

### Modelo de permissões
- Tudo negado por padrão — permissão deve ser explicitamente concedida
- Avaliação: Deny explícito > Allow > Deny implícito
- Políticas: gerenciadas pela AWS, gerenciadas pelo cliente, inline

### Roles vs Users
- **Users IAM**: para humanos (console/CLI), sempre com MFA
- **Roles**: para serviços (Lambda, EC2, ECS tasks) — nunca use access keys em código
- **Assume Role**: cross-account access, federação com IdP (SSO/SAML)

### Least Privilege
Padrão para Lambda que lê de DynamoDB e escreve em S3:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:Query"],
      "Resource": "arn:aws:dynamodb:us-east-1:123456789:table/MinhaTabela"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::meu-bucket/outputs/*"
    }
  ]
}
```

Nunca use `"Resource": "*"` sem necessidade real.

### Permission Boundaries
- Limite máximo de permissões que uma role pode ter
- Útil para delegar criação de roles para times sem escalar privilégios
- Organizações: use SCPs no AWS Organizations para guardrails de conta

---

## Encriptação

### Em Repouso
- **S3**: SSE-S3 (padrão, gerenciado pela AWS), SSE-KMS (suas chaves), SSE-C (cliente gerencia)
- **RDS**: habilite encryption na criação (não pode mudar depois sem snapshot+restore)
- **EBS**: encrypt by default na conta — recomendado habilitar
- **DynamoDB**: encriptado por padrão com chave AWS, use CMK para controle extra
- **ElastiCache Redis**: at-rest encryption disponível para clusters novos

### Em Trânsito
- **ALB → serviços internos**: use HTTPS mesmo internamente (TLS offload no ALB)
- **RDS**: force_ssl=1 (MySQL) ou ssl=require (PostgreSQL) na string de conexão
- **ElastiCache Redis**: in-transit encryption com TLS
- **API Gateway**: HTTPS obrigatório, TLS 1.2 mínimo
- **S3**: bloqueie HTTP via bucket policy com `aws:SecureTransport`

### KMS (Key Management Service)
- CMK (Customer Managed Key): você controla rotação e acesso
- Rotação automática: habilite (gera nova key material anualmente, mantém versões antigas)
- Custo: $1/mês por CMK + $0.03 por 10.000 chamadas de API
- Use alias para facilitar referência sem hardcodar ARN

---

## Rede Segura

### Security Groups
- Stateful: resposta de tráfego permitido entra automaticamente
- Regras de inbound: permita apenas o necessário
- Padrão recomendado:
  - ALB SG: 80/443 de 0.0.0.0/0
  - App SG: 8080 apenas do ALB SG (referência por SG ID, não CIDR)
  - DB SG: 5432/3306 apenas do App SG
- Nunca abra 0.0.0.0/0 para SSH (22) — use SSM Session Manager

### VPC Endpoints
- Gateway Endpoint: S3 e DynamoDB — gratuito, tráfego não sai da AWS
- Interface Endpoint (PrivateLink): outros serviços AWS, ~$0.01/hora por AZ
- Use para: Secrets Manager, SSM, ECR em VPCs privadas sem NAT Gateway

### WAF (Web Application Firewall)
- Managed Rules: AWSManagedRulesCommonRuleSet (OWASP top 10), SQLi, XSS, BadBot
- Rate-based rules: bloqueio automático de IPs com alto volume de requests
- Associe sempre com: ALB, API Gateway, CloudFront
- Modo: Prevention (block) para produção, Detection (count) para testes iniciais

---

## Secrets Manager vs Parameter Store

| Característica | Secrets Manager | Parameter Store |
|---|---|---|
| Rotação automática | Sim (integrado com RDS, Redshift, DocumentDB) | Não nativo |
| Custo | $0.40/secret/mês + $0.05/10k API calls | Gratuito (Standard) |
| Tamanho máximo | 64 KB | 4 KB (Standard), 8 KB (Advanced) |
| Replicação cross-region | Sim | Via SSM custom |
| Melhor para | Credenciais de banco, API keys com rotação | Configs, feature flags, parâmetros não-sensíveis |

Use Secrets Manager para: credenciais RDS, API keys de terceiros que precisam rotacionar
Use Parameter Store para: endpoints de serviços, feature flags, configurações de ambiente

---

## CloudTrail e Auditoria

- Habilite em todas as regiões e salve em S3 com integridade de logs (log file validation)
- Retenção recomendada: 90 dias no CloudWatch Logs + 7 anos no S3 Glacier
- Alertas críticos via EventBridge + SNS:
  - Root account login
  - Console login sem MFA
  - Criação/deleção de security groups
  - Mudanças em políticas IAM
  - Criação de usuários IAM
- Config Rules: detecta drift de configuração (ex: bucket S3 público, SG com 0.0.0.0/0 na porta 22)

---

## Compliance

### SOC 2
- Serviços AWS em escopo: maioria dos serviços principais (ver lista atual na AWS)
- Sua responsabilidade: configuração segura, controles de acesso, logs de auditoria
- CloudTrail + Config + Security Hub facilitam a coleta de evidências

### LGPD / GDPR
- Dados pessoais: identifique onde armazena, documente o propósito
- DynamoDB TTL: use para expirar dados de usuários que solicitam exclusão
- S3 Object Expiration: dados que têm prazo de retenção
- Encryption: obrigatória para dados pessoais sensíveis
- Regiões: dados de usuários brasileiros podem precisar ficar em sa-east-1

### PCI DSS
- Segmente o ambiente de pagamento em VPC separada
- Use AWS Shield Advanced para DDoS protection
- WAF com regras específicas para proteção de dados de cartão
- Log tudo com CloudTrail, guarde por 1 ano
