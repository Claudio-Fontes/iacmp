# Azure Networking

Visão técnica completa dos componentes de rede do Azure, suas interações e padrões de uso.

---

## VNet (Virtual Network)

A VNet é o bloco fundamental de rede no Azure — equivalente à VPC na AWS.

### Características
- Escopo: regional (não global) — uma VNet pertence a uma região
- Address space: CIDR IPv4 + opcionalmente IPv6
- Subnets dividem o address space da VNet
- Não há custo de criação da VNet em si — custos são por tráfego egress e recursos específicos
- Limite padrão: 1000 VNets por subscription (aumentável)

### Criação via ARM/Bicep
```bicep
resource vnet 'Microsoft.Network/virtualNetworks@2023-05-01' = {
  name: 'minha-vnet'
  location: resourceGroup().location
  properties: {
    addressSpace: {
      addressPrefixes: ['10.0.0.0/16']
    }
  }
}
```

---

## Subnet

Subnets dividem a VNet em segmentos menores. Diferente da AWS, subnets no Azure são regionais (não por AZ — zonas são tratadas separadamente via Availability Zones nos recursos).

### Características
- Cada subnet tem um NSG associável
- Subnet delegada: reservada para um serviço específico (ex: `Microsoft.Web/serverFarms` para App Service)
- Service Endpoints habilitados por subnet
- Private Endpoints vivem em subnets
- Primeiros 4 IPs e último são reservados pelo Azure (ex: em /24, temos 251 endereços utilizáveis)
- `AzureBastionSubnet` deve ser ao menos /26

### Subnets especiais
- `GatewaySubnet`: obrigatória para VPN Gateway e ExpressRoute Gateway
- `AzureFirewallSubnet`: ao menos /26, sem NSG
- `AzureBastionSubnet`: ao menos /26

---

## NSG (Network Security Group)

Firewall stateful de L4 (TCP/UDP/ICMP) associável a subnets ou NICs individuais.

### Regras
- Prioridade: 100 a 4096 (menor = maior prioridade)
- Regras default (não deletáveis): AllowVNetInBound (65000), AllowAzureLoadBalancerInBound (65001), DenyAllInBound (65500)
- Source/Destination: IP, CIDR, Service Tag, ou ASG (Application Security Group)

### Service Tags relevantes
- `Internet`: tráfego de/para internet
- `VirtualNetwork`: todo o address space da VNet + peerings + VPN
- `AzureLoadBalancer`: health probes do Azure Load Balancer
- `AzureCloud`: IPs públicos de serviços Azure (útil para whitelist seletiva)
- `Sql`, `Storage`, `AzureMonitor`, `AppService`: service-specific ranges

### ASG (Application Security Group)
Agrupa NICs por papel lógico (ex: "web-servers", "db-servers") e usa como source/destination em NSG rules — sem hardcoding de IPs.

---

## Private Endpoint

Traz um serviço PaaS para dentro da sua VNet via IP privado. Resolve o problema de tráfego saindo pela internet pública para serviços Azure.

### Como funciona
1. Cria um Private Endpoint na subnet
2. Azure atribui IP privado da subnet ao serviço
3. DNS privado resolve o nome público do serviço para o IP privado
4. Tráfego nunca sai da rede Microsoft

### Serviços suportados
Storage Account, SQL Database, Cosmos DB, Key Vault, App Service, Azure Container Registry, Event Hubs, Service Bus, Redis Cache, PostgreSQL, MySQL, MariaDB, Cognitive Services, etc.

### Private DNS Zone
Obrigatório para que o DNS resolva o nome privado:
- Storage Blob: `privatelink.blob.core.windows.net`
- SQL Database: `privatelink.database.windows.net`
- Key Vault: `privatelink.vaultcore.azure.net`

### Custo
~$0.01/h por Private Endpoint + $0.01/GB de dados processados (aprox).

---

## Service Endpoint

Alternativa mais simples ao Private Endpoint — não cria IP privado, mas garante que o tráfego da subnet para o serviço use a rede backbone da Microsoft (não a internet).

### Diferenças vs Private Endpoint
| | Service Endpoint | Private Endpoint |
|---|---|---|
| IP no recurso | IP público do serviço | IP privado da VNet |
| DNS | Resolve para IP público | Resolve para IP privado |
| Custo | Gratuito | Pago |
| Granularidade | Por subnet/serviço | Por recurso individual |
| On-premises access | Não | Sim (via VPN/ER) |

### Quando usar Service Endpoint
- Cenários onde on-premises não precisa acessar o serviço
- Custo é restrição e o isolamento não precisa ser total
- Migração rápida de workloads existentes

---

## Azure Firewall

Firewall gerenciado, stateful, de alta disponibilidade — Layer 4 e Layer 7 (FQDN filtering).

### Tiers
- **Standard**: FQDN tags, regras de rede e aplicação, DNAT, ThreatIntel
- **Premium**: TLS inspection, IDPS (Intrusion Detection & Prevention), URL filtering, Web categories

### Tipos de regras (em ordem de avaliação)
1. DNAT Rules: tradução de IP público → IP privado
2. Network Rules: L4 — IP/Port/Protocol
3. Application Rules: L7 — FQDN, HTTP/HTTPS, FQDN tags

### Deployment
- Deve estar na `AzureFirewallSubnet` (/26 mínimo)
- Requer Azure Firewall Policy (recurso separado) na tier Premium
- IP público dedicado (Standard SKU) ou Prefix
- Custa ~$1.25/h + $0.016/GB processado

### Azure Firewall Policy
Gerencia regras de múltiplos firewalls. Suporta hierarquia: Base Policy → Child Policies (herança de regras).

---

## VPN Gateway

Gateway para conectividade site-to-site (VPN IPSec) e point-to-site com redes on-premises.

### SKUs
| SKU | Throughput agregado | Tunnels S2S |
|---|---|---|
| Basic | 100 Mbps | 10 |
| VpnGw1 | 650 Mbps | 30 |
| VpnGw2 | 1 Gbps | 30 |
| VpnGw3 | 1.25 Gbps | 30 |
| VpnGw4 | 5 Gbps | 100 |
| VpnGw5 | 10 Gbps | 100 |

### Tipos
- **Route-based (RouteBased)**: BGP dinâmico, multiple tunnels, point-to-site — recomendado
- **Policy-based (PolicyBased)**: legacy, somente Basic SKU, single tunnel

### Active-Active
Dois IPs públicos, dois túneis para o mesmo peer — sem downtime durante manutenção do gateway.

### Point-to-Site (P2S)
Protocolos suportados: OpenVPN (SSL/TLS), IKEv2, SSTP (Windows only). Autenticação: certificado, RADIUS, Azure AD.

---

## ExpressRoute

Conectividade privada dedicada entre on-premises e Azure — não passa pela internet.

### Modelos de conectividade
- **CloudExchange co-location**: co-locação em datacenter com ponto de troca
- **Point-to-point Ethernet**: link dedicado ao Azure
- **Any-to-any (IPVPN)**: via provedor MPLS existente

### Circuits
- Bandwidth: 50 Mbps a 100 Gbps
- SKUs: Local, Standard, Premium (Premium adiciona acesso a todas as regiões globais e mais route prefixes)
- Peering types: Azure private (VNets), Microsoft peering (M365, Dynamics, Azure PaaS)

### ExpressRoute Global Reach
Conecta dois circuits ER para comunicação entre dois sites on-premises via backbone Microsoft.

### ExpressRoute FastPath
Bypass do gateway para tráfego de alta performance — dados vão direto para VMs sem passar pelo gateway.

---

## VNet Peering

Conecta duas VNets para comunicação privada via backbone Microsoft — sem gateway, sem VPN, latência mínima.

### Tipos
- **Regional Peering**: mesma região — sem custo de tráfego dentro da mesma região (algumas exceções)
- **Global Peering**: regiões diferentes — custo de tráfego cross-region

### Propriedades importantes
- `AllowVirtualNetworkAccess`: permite que VMs de um lado acessem o outro
- `AllowForwardedTraffic`: permite tráfego que entrou por outra rede ser encaminhado
- `AllowGatewayTransit`: permite que a VNet peered use o gateway desta VNet
- `UseRemoteGateways`: esta VNet usa o gateway da VNet peered (apenas uma pode ter isto)

### Limitações
- Não é transitivo: A→B e B→C não implica A→C
- CIDR address spaces não podem se sobrepor
- Máximo de 500 peerings por VNet (padrão)

---

## Hub-Spoke Topology

Padrão arquitetural de referência para redes corporativas no Azure.

### Componentes
- **Hub VNet**: serviços compartilhados — Azure Firewall, VPN/ER Gateway, Bastion, DNS
- **Spoke VNets**: workloads individuais por time/ambiente/aplicação
- Peering entre Hub e cada Spoke
- Tráfego entre Spokes passa pelo Hub (via UDR apontando para Firewall)

### User-Defined Routes (UDR)
Route tables customizadas associadas a subnets para forçar tráfego por specific next-hops:
```
0.0.0.0/0 → Azure Firewall (hub)  # força todo tráfego pelo firewall
10.0.0.0/8 → Azure Firewall (hub) # tráfego entre spokes também via firewall
```

### Azure Virtual WAN
Versão gerenciada do Hub-Spoke — Microsoft gerencia o Hub (Virtual Hub), simplifica conectividade global.

---

## Azure Load Balancer

### Tipos
- **Basic**: gratuito, sem SLA, até 300 instâncias, sem zone redundancy
- **Standard**: pago (~$0.005/h + dados), SLA 99.99%, até 1000 instâncias, zone-redundant, suporta HTTPS health probes

### Variantes
- **Public Load Balancer**: IP público → VMs privadas (ingress da internet)
- **Internal Load Balancer**: IP privado → distribui tráfego interno (ex: entre tiers de aplicação)

---

## Application Gateway

Layer 7 load balancer com WAF integrado.

### Recursos
- URL path-based routing (ex: /api → pool 1, /web → pool 2)
- Host-based routing (múltiplos domínios)
- SSL termination (offload)
- Cookie-based session affinity
- Rewrite HTTP headers

### WAF Policy
Baseado em OWASP CRS 3.2. Modo Detection ou Prevention. Exclusions por campo/operador.

---

## Azure DNS

- DNS público: zonas públicas resolvidas pela internet
- DNS privado: zonas privadas vinculadas a VNets
- Sem servidores para gerenciar — SaaS
- Suporte a registros: A, AAAA, CNAME, MX, TXT, SRV, NS, SOA, CAA, PTR

### Private DNS Resolver
Para resolução DNS de on-premises para zonas privadas do Azure sem precisar de DNS server customizado em VMs.
