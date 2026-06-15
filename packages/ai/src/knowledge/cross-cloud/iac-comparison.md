# IaC — Comparação entre CloudFormation, Terraform, ARM e Deployment Manager

## CloudFormation (AWS)

### Características
- Nativo AWS, integrado com todos os serviços no dia do lançamento
- Estado gerenciado pela AWS (não precisa de backend remoto)
- Detecta drift automaticamente (CloudFormation Drift Detection)
- Rollback automático em falha de deploy (configurable)
- Change Sets: preview das mudanças antes de aplicar

### Pontos Fortes
- Suporte ao recurso AWS no dia 0 (antes do Terraform)
- Sem custo adicional (paga só pelos recursos criados)
- Integração nativa com Service Catalog, StackSets (multi-conta/região)
- CDK: escreve em TypeScript/Python/Java e compila para CloudFormation

### Pontos Fracos
- Só AWS — sem portabilidade
- Sintaxe YAML/JSON verbosa para stacks grandes
- Loop / iteração limitada (Fn::ForEach introduzido recentemente)
- Debugging de erros pode ser difícil (mensagens de erro genéricas)

### Limites
- 500 recursos por stack
- Template: 51.200 bytes direto, 460.800 bytes via S3
- Outputs: 200 por stack
- Parâmetros: 200 por stack
- Use nested stacks para projetos grandes

### Quando Usar CloudFormation / CDK
- Time só usa AWS
- Quer integração mais profunda (StackSets, Service Catalog)
- Prefere CDK (TypeScript) para gerar CloudFormation

---

## Terraform (HashiCorp / OpenTofu)

### Características
- Multi-cloud: AWS, Azure, GCP e 3.000+ providers
- Estado em arquivo `.tfstate` — precisa de backend remoto (S3+DynamoDB, Terraform Cloud)
- Plan/Apply: preview explícito antes de aplicar
- Módulos: reutilização de código, Terraform Registry com módulos da comunidade
- HCL: linguagem declarativa própria

### Pontos Fortes
- Multi-cloud e multi-provider (DNS, Kubernetes, GitHub, Datadog, etc.)
- Ecossistema enorme de módulos prontos
- Plan é uma das melhores experiências de DX para IaC
- OpenTofu: fork open-source (sem licença BSL), compatível com Terraform

### Pontos Fracos
- Suporte a novos recursos AWS geralmente dias/semanas após CloudFormation
- Gerenciamento de estado é responsabilidade sua (locking, backup)
- HCL tem limitações para lógica complexa (use locals + expressions, mas tem limites)
- Drift detection não é nativo (precisa de `terraform refresh`)

### Boas Práticas de Estado
```hcl
terraform {
  backend "s3" {
    bucket         = "meu-terraform-state"
    key            = "projeto/ambiente/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-lock"  # locking obrigatório em times
  }
}
```

### Estrutura de Projeto Recomendada
```
projeto/
  modules/
    vpc/           # módulo reutilizável
    rds/
    lambda/
  environments/
    dev/           # usa os módulos com variáveis de dev
      main.tf
      variables.tf
      terraform.tfvars
    prod/          # usa os módulos com variáveis de prod
      main.tf
      terraform.tfvars
```

### Quando Usar Terraform
- Multi-cloud ou precisa de providers não-AWS (DNS externo, monitoring SaaS)
- Time já tem expertise em Terraform
- Quer módulos da comunidade prontos

---

## ARM Templates (Azure)

### Características
- Nativo Azure, JSON/Bicep
- Estado gerenciado pelo Azure Resource Manager
- Deployment modes: Complete (remove recursos não no template) e Incremental (padrão)
- Integração com Azure DevOps, GitHub Actions nativamente

### Bicep — A Evolução do ARM
- DSL da Microsoft que compila para ARM JSON
- Muito mais legível que ARM JSON puro
- Type checking em tempo de compilação
- Módulos, loops, condicionais

Exemplo Bicep vs ARM:
```bicep
// Bicep
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'minhaconta${uniqueString(resourceGroup().id)}'
  location: resourceGroup().location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
}
```

vs ARM JSON equivalente (~30 linhas).

### Quando Usar ARM/Bicep
- Time só usa Azure
- Quer integração mais profunda com Azure Policy, Blueprints
- Prefere Bicep para legibilidade

---

## Deployment Manager (GCP)

### Características
- Nativo GCP, YAML/Jinja2/Python
- Estado gerenciado pelo GCP
- Menos features que Terraform/CloudFormation
- Integração com Cloud Build para CI/CD

### Limitações
- Menos popular que Terraform para GCP
- Comunidade menor, menos exemplos
- Google recomenda Terraform para projetos novos

### Quando Usar Deployment Manager
- Projetos legados GCP já usando DM
- Para novos projetos GCP: prefira Terraform

---

## Comparação Resumida

| Característica | CloudFormation | Terraform | ARM/Bicep | Deployment Manager |
|---|---|---|---|---|
| Multi-cloud | Não | Sim | Não | Não |
| Suporte a novos recursos | Dia 0 (AWS) | Dias/semanas | Dia 0 (Azure) | Dia 0 (GCP) |
| Gerenciamento de estado | AWS gerencia | Você gerencia | Azure gerencia | GCP gerencia |
| Linguagem | YAML/JSON (CDK=TS) | HCL | JSON/Bicep | YAML/Jinja/Python |
| Rollback | Automático | Manual (terraform apply) | Automático | Manual |
| Modularidade | Nested Stacks, CDK | Módulos (muito bons) | Módulos Bicep | Templates aninhados |
| Custo | Gratuito | Gratuito (OSS) / pago (Cloud) | Gratuito | Gratuito |
| Drift Detection | Nativo | Terraform refresh | Parcial | Não |
| Ecossistema | CDK, SAM | 3.000+ providers | AZD, Blueprints | Limitado |

---

## Recomendações por Cenário

### Time só usa AWS
→ CloudFormation com CDK (TypeScript). CDK abstrai o YAML, facilita reuso.

### Multi-cloud ou integração com SaaS
→ Terraform. Provider ecosystem é imbatível.

### Time só usa Azure
→ Bicep. Muito mais legível que ARM JSON, suporte oficial da Microsoft.

### GCP novo projeto
→ Terraform com provider google. Mais comunidade e módulos que Deployment Manager.

### Startup em crescimento rápido (qualquer cloud)
→ Terraform + Terraform Cloud (state management gerenciado) ou OpenTofu + S3 backend.

### Enterprise multi-conta AWS
→ CDK + CDK Pipelines + AWS Organizations + StackSets.
