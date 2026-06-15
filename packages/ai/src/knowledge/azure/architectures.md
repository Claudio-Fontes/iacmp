# Azure Reference Architectures

Padrões arquiteturais de referência no Azure com componentes, trade-offs e decisões de design.

---

## Web Application Architecture

Arquitetura padrão para aplicações web com alta disponibilidade e escalabilidade no Azure.

### Componentes típicos
```
Internet
  → Azure Front Door (CDN global + WAF + load balancing global)
    → Application Gateway (WAF regional + Layer 7 LB)
      → App Service (web tier) — escala horizontal automática
        → Azure Cache for Redis (session store, cache de dados)
        → Azure SQL Database (dados relacionais) — zone-redundant
        → Azure Blob Storage (arquivos estáticos, uploads)
          → Azure CDN (conteúdo estático cacheado na edge)
```

### App Service — detalhes
- **Plans**: Free/Shared (dev), Basic/Standard (produção), Premium (isolamento VNet, autoscale avançado), Isolated (ASE — App Service Environment)
- **Deployment Slots**: staging → swap com produção sem downtime
- **VNet Integration**: App Service conectado à VNet para acesso a recursos privados (outbound)
- **Private Endpoint**: receber tráfego de forma privada (inbound)
- **Autoscale**: baseado em CPU, memória, HTTP queue length, custom metrics

### Alta disponibilidade
- App Service: múltiplas instâncias com `minimum: 3` para suportar falha de AZ
- SQL Database: zone-redundant (Business Critical ou General Purpose com zona habilitada)
- Redis: Premium com geo-replication para DR
- Front Door: failover automático entre regiões — RTOs de segundos

### Considerações de custo
- App Service Premium v3 com Reserved Instances = ~55% de desconto
- SQL Database: serverless para dev/test, DTU/vCore provisioned para produção
- Front Door Standard/Premium: preço por regra, origem, data transfer

---

## Microservices Architecture

Padrão para sistemas decompostos em serviços independentes com deploy e escala isolados.

### Opções de orquestração de containers

**AKS (Azure Kubernetes Service)**
- Melhor para: workloads complexas, controle total, equipe com expertise k8s
- Integração nativa: Azure CNI, AAD integration, ACR pull (managed identity), Azure Disk/File (PV)
- Add-ons: Application Gateway Ingress Controller (AGIC), Azure Monitor container insights, Defender for Containers
- Node pools: sistema (system pool para k8s components) + usuário (user pool para workloads)
- Virtual Nodes: Pods em Azure Container Instances para burst scaling sem provisionamento de nós

**Azure Container Apps**
- Melhor para: times sem expertise k8s que precisam de orquestração de containers
- Baseado em Kubernetes + KEDA + Dapr internamente
- Escala a zero, baseado em KEDA (HTTP, Service Bus, custom metrics)
- Dapr integrado: service discovery, state management, pub/sub, secrets
- Revision: versões imutáveis de container apps com traffic splitting

**Service Fabric**
- Microsoft-native, mais antigo, usado internamente pela Microsoft
- Suporta stateful services nativamente (sem k8s PV)
- Tendência de adoção diminuindo em favor de AKS/Container Apps

### Service Mesh
- **Istio**: Add-on de AKS (managed) ou instalação manual — mTLS, traffic management, observability
- **Open Service Mesh**: mais leve, também add-on AKS
- **Linkerd**: alternativa leve, alta performance

### API Gateway para microservices
- **Azure API Management**: API gateway completo — autenticação, rate limiting, transformação, developer portal
- Tiers: Consumption (serverless, pay-per-call), Developer (dev only, sem SLA), Basic/Standard/Premium
- Premium: multi-region deployment, VNet integration, multiple gateways

### Service Discovery
No AKS: CoreDNS resolve `service.namespace.svc.cluster.local`
Com Container Apps: ingress automático por FQDN ou via Dapr service invocation

### Comunicação entre serviços
- **Síncrona**: HTTP/REST via API Management ou direto; gRPC para performance
- **Assíncrona**: Azure Service Bus (queues e topics com sessions), Event Grid (eventos de plataforma), Event Hubs (streaming de alta throughput)

---

## Event-Driven Architecture

Sistemas baseados em eventos para desacoplamento e processamento assíncrono.

### Componentes Azure para eventos

**Azure Service Bus**
- Mensageria enterprise — garantia de entrega, ordering, sessions
- **Queues**: 1:1 (ponto a ponto)
- **Topics + Subscriptions**: 1:N (pub/sub)
- **Sessions**: processamento ordenado e stateful por session ID
- Tamanho máximo de mensagem: 256KB (Standard), 100MB (Premium)
- Dead Letter Queue (DLQ) integrado
- Tiers: Standard (shared, pay-per-million), Premium (dedicated, vCores, Private Endpoint)

**Azure Event Grid**
- Roteamento de eventos de serviços Azure e aplicações customizadas
- Push-based: entrega eventos para subscribers (WebHooks, Azure Functions, Service Bus, Event Hubs)
- Filtragem por tipo de evento e propriedades
- Retry automático com exponential backoff
- Event Domains: para multi-tenant event distribution

**Azure Event Hubs**
- Streaming de alta throughput (Kafka-compatible API)
- Throughput Units (TUs) ou Processing Units (Dedicated)
- Retenção configurável: 1 a 90 dias
- Capture: armazena automaticamente em ADLS Gen2 ou Blob Storage no formato Avro
- Consumer Groups: múltiplos consumidores independentes no mesmo stream

### Padrão Event Sourcing + CQRS

**Event Sourcing**
- Estado derivado da sequência de eventos
- Event Store: Cosmos DB (change feed), Event Hubs, ou Service Bus

**CQRS (Command Query Responsibility Segregation)**
- Write model: Commands → Domain Events → Event Store
- Read model: projections materializadas a partir dos eventos (Cosmos DB, Redis, Elasticsearch)

### Saga Pattern
Para transações distribuídas sem 2PC:
- **Choreography**: cada serviço reage a eventos e publica os próprios — simples mas difícil de rastrear
- **Orchestration**: um Saga Orchestrator (ex: Azure Durable Functions) coordena os passos — mais controle, mais acoplamento

---

## Hub-Spoke Network Architecture

Padrão de referência de rede corporativa no Azure. Ver detalhes em networking.md.

### Componentes da Landing Zone Hub
- **Azure Firewall** ou **NVA** (Network Virtual Appliance): tráfego entre spokes e saída internet
- **VPN Gateway** ou **ExpressRoute Gateway**: conectividade on-premises
- **Azure Bastion**: acesso SSH/RDP a VMs sem IP público
- **Azure DNS Private Resolver**: resolução DNS privada
- **Azure Monitor**: logs centralizados de todos os spokes

### Spoke típico por workload
```
Spoke VNet
  ├── snet-app (App Service / AKS nodes)
  ├── snet-data (SQL / Cosmos DB Private Endpoints)
  ├── snet-mgmt (VMs de gerenciamento, agentes CI/CD)
  └── Route Table: 0.0.0.0/0 → Azure Firewall no Hub
```

### Azure Virtual WAN
Alternativa gerenciada: Microsoft cuida do Hub VNet, BGP, routing.
- **Standard**: roteamento automático, Azure Firewall, VPN, ER, P2S
- Recomendado para: empresas com múltiplas regiões e muitos branches
- Trade-off: menos customização do routing vs WAN gerenciada com menos overhead operacional

---

## Landing Zone Architecture

Ambiente Azure pré-configurado com governança, segurança e rede prontos para hospedar workloads.

### Azure Landing Zones (Cloud Adoption Framework)
Microsoft definiu um conjunto de padrões de referência implementáveis via Terraform, Bicep ou Accelerators.

### Hierarquia de Management Groups

```
Tenant Root Group
├── Platform
│   ├── Identity (Active Directory DCs)
│   ├── Management (Log Analytics, Automation, Defender)
│   └── Connectivity (Hub VNet, VPN/ER, Firewall, DNS)
├── Landing Zones
│   ├── Corp (workloads conectadas à rede corporativa)
│   └── Online (workloads com acesso à internet)
├── Sandboxes (dev/test sem conectividade)
└── Decommissioned
```

### Azure Policy em Landing Zones
- Habilitar Defender for Cloud em todas as subs (DeployIfNotExists)
- Exigir tags obrigatórias em resource groups
- Proibir criação de Public IPs fora do RG de conectividade
- Auditar VNets sem NSG
- Require TLS 1.2+ em App Services e Storage Accounts
- Deny public access em Storage Accounts por padrão

### Automação de Landing Zones
- **ALZ (Azure Landing Zones) Terraform module**: módulo oficial Microsoft para IaC de landing zones
- **Bicep ALZ**: templates Bicep de referência
- **ALZ-Deploy GitHub Action**: pipeline CI/CD para landing zones
