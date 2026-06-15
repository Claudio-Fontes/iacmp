# Observabilidade Multi-Cloud

Comparação de ferramentas de observabilidade entre AWS, Azure e GCP com padrões e melhores práticas.

---

## Os três pilares da observabilidade

### Métricas
Valores numéricos ao longo do tempo — o que está acontecendo.
- Agregadas, baixo custo de armazenamento
- Bons para alertas e dashboards
- Não explicam o "porquê"

### Logs
Registros de eventos discretos — o que aconteceu.
- Alto volume, custo de ingestão e armazenamento considerável
- Bons para debugging, auditoria
- Difíceis de correlacionar sem estrutura

### Traces
Registro do caminho de uma request através de múltiplos serviços.
- Mostram latência por componente, dependências
- Essenciais para diagnosticar problemas em sistemas distribuídos
- Overhead de instrumentação

---

## Ferramentas por Cloud

### AWS

**CloudWatch** — serviço central de observabilidade

Métricas:
- Métricas AWS nativas: EC2, Lambda, RDS, SQS, etc. (free tier limitado, depois $0.30/metric-month)
- Custom Metrics: via PutMetricData API ($0.30/metric-month)
- High Resolution Metrics: até 1s de granularidade ($0.30/metric-month)
- Container Insights: métricas de ECS/EKS ($0.50/GB ingerido + $0.03/metric-hour)

Logs:
- CloudWatch Logs: $0.50/GB ingerido, $0.03/GB armazenado/mês
- Log Insights: query SQL-like em logs ($0.005/GB consultado)
- Live Tail: streaming de logs em tempo real para debugging
- Subscription Filters: exporta logs para Lambda, Kinesis, OpenSearch

Dashboards e Alarmes:
- Dashboards: $3/dashboard/mês (primeiros 3 gratuitos)
- Alarms: $0.10/alarm-mês (High Resolution: $0.30)
- Composite Alarms: combina múltiplos alarmes com lógica AND/OR

**X-Ray** — Distributed Tracing
- Instrumentação: SDK (Java, Python, Node.js, Go, Ruby, .NET) ou AWS Distro for OpenTelemetry
- Sampling rules: controla % de traces capturados
- Service Map: mapa visual de dependências
- Trace Analytics: queries em traces para padrões
- Preço: $5/million traces gravados, $0.50/million traces varridos

**AWS Distro for OpenTelemetry (ADOT)**
- Collector gerenciado: recebe telemetry em OTLP e envia para X-Ray, CloudWatch, backends terceiros
- Recomendado para new greenfield — independente de vendor

---

### Azure

**Azure Monitor** — plataforma central

Métricas:
- Platform metrics: coletadas automaticamente de todos os recursos Azure (gratuitas por 93 dias)
- Custom metrics: $0.258/10K series/mês
- Prometheus metrics: Azure Monitor scraping de targets Prometheus (gratuito nos primeiros 6 meses)

**Log Analytics Workspace** — repositório central de logs
- Preço: $2.30/GB ingerido + $0.10/GB armazenado além de 31 dias
- Commitment tiers: $168/day para 100GB/dia (~$1.68/GB — desconto para alto volume)
- KQL (Kusto Query Language): linguagem de consulta — muito mais poderosa que CloudWatch Logs Insights
- Workspace-based model: múltiplos recursos enviam logs para um workspace centralizado

**Application Insights** — APM para aplicações
- Distribuído dentro do Azure Monitor
- Automatic instrumentation: SDKs para .NET, Java, JavaScript, Python, Node.js
- Features: request tracking, dependency tracking, exception tracking, custom events/metrics
- Live Metrics Stream: streaming de métricas em tempo real para debugging
- Smart Detection: ML-based anomaly detection (latência, falhas, anomalias de uso)
- Preço: $2.30/GB + retenção além de 90 dias

**Distributed Tracing**
- Application Insights inclui trace correlation (operationId propaga via W3C TraceContext ou custom headers)
- Azure Monitor OpenTelemetry Distro: recomendado para novos projetos (coleta metrics + logs + traces)

**Alerts**
- Metric alerts: $0.10/alert rule/mês
- Log alerts (Log Analytics): $1.50/alert rule/mês
- Smart alert groups: agrupa alertas relacionados automaticamente

---

### GCP

**Cloud Monitoring** — equivalente ao CloudWatch

Métricas:
- Métricas de plataforma: gratuitas para serviços GCP
- Custom metrics: $0.258/metric/mês (após 150M gratuitos/mês)
- Prometheus integrado: Cloud Managed Service for Prometheus — armazena métricas Prometheus no Cloud Monitoring
  - Preço: $0.15/million samples ingeridos

Dashboards e Alertas:
- Dashboards: gratuitos
- Alerting policies: gratuitas (limite de alertas por org)

**Cloud Logging** — equivalente ao CloudWatch Logs

- Ingestão: gratuita para _Required e _Default logs; $0.50/GB para logs opcionais
- Armazenamento: $0.01/GB-mês além do período default (30 dias _Default, 400 anos _Required)
- Log Explorer: interface para busca e análise de logs
- Log Analytics: BigQuery-powered queries em logs ($0.005/GB consultado — muito mais barato que CW Insights)
- Exportação: Log Sinks para BigQuery, GCS, Pub/Sub, Cloud Logging em outro projeto

**Cloud Trace** — Distributed Tracing
- Instrumentação: Cloud Trace SDK, OpenTelemetry, ou automática via Cloud Run/GKE Autopilot
- Gratuito: 2.5 million spans ingeridos/mês, depois $0.20/million
- Trace Explorer: visualização de traces, percentis de latência, análise de gargalos

**Cloud Profiler**
- Profiling contínuo de CPU, memória, heap em produção com overhead mínimo (<1%)
- Suporta: Go, Java, Node.js, Python
- Gratuito

---

## OpenTelemetry — Padrão Aberto

OpenTelemetry (OTel) é o padrão emergente para instrumentação de observabilidade — agnóstico de vendor.

### Por que usar OTel
- Instrumentar uma vez, enviar para qualquer backend (CloudWatch, Azure Monitor, Cloud Monitoring, Datadog, Grafana, Jaeger)
- Evita lock-in de instrumentação
- SDKs para todas as linguagens principais
- Semantic conventions: nomenclatura padronizada de atributos

### Componentes
- **API**: contratos de instrumentação (Tracer, Meter, Logger)
- **SDK**: implementação das APIs
- **Collector**: recebe, processa e exporta telemetry
  - Receivers: OTLP, Prometheus, Jaeger, Zipkin, StatsD
  - Processors: batch, memory_limiter, attributes, sampling
  - Exporters: OTLP, Prometheus, CloudWatch, Azure Monitor, GCP
- **Auto-instrumentation**: agentes que instrumentam automaticamente frameworks comuns

---

## RED Method

Framework para monitorar serviços (especialmente microservices).

- **R**ate: quantas requests por segundo o serviço está processando?
- **E**rrors: qual a taxa de erros (requests com falha)?
- **D**uration: quanto tempo as requests estão demorando? (distribuição de latência — p50, p95, p99)

### Alertas baseados em RED
```
Rate → alerta se cair X% em relação à média histórica (indica problema upstream)
Errors → alerta se error rate > 1% por 5 minutos
Duration → alerta se p99 > SLA threshold por 10 minutos
```

---

## USE Method

Framework para monitorar recursos de infraestrutura (servidores, discos, redes).

- **U**tilization: qual % do recurso está em uso? (CPU %, disco %)
- **S**aturation: o quanto o recurso está sendo sobrecarregado? (queue depth, wait times)
- **E**rrors: quantos erros o recurso está produzindo? (disk errors, network drops)

### Quando usar USE vs RED
- USE: para diagnosticar gargalos de infraestrutura (CPU bound? Memory bound? I/O bound?)
- RED: para monitorar a experiência do usuário nos serviços

---

## SLO / SLI / SLA

### Definições

**SLI (Service Level Indicator)**
Métrica que mede o comportamento do serviço do ponto de vista do usuário:
- Taxa de sucesso de requests
- Latência (proporção de requests abaixo de um threshold)
- Disponibilidade (uptime)
- Throughput

**SLO (Service Level Objective)**
Meta interna para um SLI — ex: "99.9% dos requests devem completar em <200ms"
- SLO é o alvo que você se esforça para atingir
- Error Budget = 100% - SLO = margem de erros/indisponibilidade permitida
- Error Budget Policy: o que acontece quando o error budget se esgota

**SLA (Service Level Agreement)**
Contrato com o cliente — consequências contratuais/financeiras se violado.
- SLA geralmente < SLO (SLO é mais estrito para ter margem)
- Exemplo: SLO = 99.95%, SLA = 99.9%

### Error Budget
- Error Budget mensal de um SLO de 99.9% = 0.1% = ~43.8 minutos/mês de downtime permitido
- Quando o error budget está sendo consumido rapidamente, pausar deployments
- Quando o error budget está confortável, pode aceitar mais risco (deploy mais frequente)

### Implementação por cloud
- **AWS**: CloudWatch SLOs via Composite Alarms (manual) ou AWS X-Ray insights
- **Azure**: Azure Monitor SLO features (preview); mais comum usar Azure DevOps + Application Insights
- **GCP**: Cloud Monitoring tem SLO monitoring nativo — define SLI, SLO, e monitora error budget automaticamente; gera alertas quando error budget burn rate é muito alta

---

## Alerting Best Practices

### Sintomas vs Causas
- Alerte em **sintomas** (usuário está sendo afetado), não em causas (CPU alta)
- Exemplo ruim: CPU > 80% por 5 minutos
- Exemplo bom: p99 latência > 500ms por 5 minutos

### Multi-window, multi-burn-rate alerting
Técnica do SRE Book para balancear sensibilidade (detectar problemas rápido) e especificidade (evitar falsos positivos):

```
Burn rate 14.4x por 1h → Critical (page)     [1% de error budget em 1h]
Burn rate 6x por 6h → Warning (ticket)        [5% de error budget em 6h]
Burn rate 1x por 3 dias → Info (monitoring)   [error budget sendo consumido normalmente]
```

### Onde alertar
1. **PagerDuty/OpsGenie**: para incidentes que requerem resposta imediata
2. **Slack/Teams**: para warnings e informativos
3. **Email**: resumos diários, não para alertas críticos

### Runbook linkado em cada alerta
Todo alerta deve ter link para runbook com:
- O que o alerta significa
- Como diagnosticar
- Ações de remediação
- Quando escalar
