# Modelo de Licenciamento — iacmp

> Rascunho de design. Decide o **modelo de negócio + a arquitetura técnica** para
> monetizar o iacmp: trial de 2 dias → licença anual por máquina → enterprise.
> Documento interno (repositório privado).

---

## 1. Visão geral

| Plano | Preço | Vínculo | Para quem |
|---|---|---|---|
| **Trial** | grátis, 2 dias | 1 máquina (fingerprint) | avaliar antes de comprar |
| **Individual** | **US$ 50 / máquina / ano** | 1 seat = 1 máquina | dev autônomo, freelancer |
| **Enterprise** | US$ 50 × N seats, com desconto por volume + faturamento | N seats geridos por um admin | times/empresas |

Ciclo: **instala via npm → primeiro comando ativa (abre o portal) → cadastro → 2 dias
de trial → paga → licença anual → renova**.

---

## 2. Jornada do usuário (fluxos)

### 2.1 Trial
1. `npm install -g iacmp`.
2. Primeiro comando que exige licença → a CLI detecta que **não há licença local**
   (`~/.iacmp/license.json`) e **abre o navegador** no portal de ativação, passando
   um **device fingerprint** (ver §5) na URL.
3. No portal: e-mail + verificação (evita trial infinito) → emite um **token de trial**
   assinado, válido 2 dias, **vinculado ao fingerprint**.
4. A CLI recebe o token (via redirect local `http://localhost:<porta>` ou copia-e-cola),
   grava em `~/.iacmp/license.json` e libera o uso.
5. Aviso de expiração (contagem regressiva no rodapé dos comandos + e-mail no dia 1).

### 2.2 Compra (individual)
1. No portal, "comprar" → **Stripe Checkout** (assinatura anual recorrente).
2. Pagamento OK → emite **licença anual** vinculada ao mesmo fingerprint (upgrade do trial).
3. Renovação automática anual; e-mail 30/7/1 dias antes.

### 2.3 Uso contínuo
- Cada comando **valida a licença** (ver §6). Válida → roda. Expirada → bloqueia com
  link pra renovar. **Sem internet** → grace period (ver §6).

### 2.4 Enterprise
- Admin compra N seats no portal → recebe um **console de gestão**: vê seats usados,
  **atribui/revoga máquinas**, convida devs (cada dev ativa seu device contra a org).
- Faturamento (nota fiscal / PO), não só cartão.

---

## 3. Arquitetura técnica

Hoje o iacmp é uma **CLI local** (sem backend). O licenciamento exige **3 peças novas**:

```
  CLI (iacmp)  ──ativa/valida──►  License API (backend)  ◄──►  Banco (users, licenses, devices)
       │                               ▲
       │ abre navegador                │ webhooks
       ▼                               │
  Portal web (cadastro/dashboard) ──►  Stripe (pagamento)
```

- **CLI**: gate de licença (um módulo `@iacmp/license`), fingerprint, cache local,
  validação online com fallback offline.
- **License API**: emitir/validar/revogar tokens; endpoints REST; assinatura dos tokens
  (chave privada no servidor, pública embutida na CLI — permite validar offline).
- **Portal web**: cadastro, checkout, dashboard individual/enterprise.
- **Stripe**: assinaturas, seats, cobrança recorrente, webhooks (pagou/cancelou/falhou).
- **Banco**: usuários, licenças, devices (fingerprint), eventos, seats enterprise.

### Como enganchar na CLI ("abre o portal ao rodar")
- Um **hook de pré-comando** no oclif (`this.config.runHook('prerun', …)` ou um wrapper
  em `bin/run.js`) roda o gate **antes** de cada comando.
- **Refinamento importante:** só abrir o navegador **na ATIVAÇÃO** (sem licença local).
  Depois, a validação é **silenciosa**. Abrir o portal a cada comando seria intrusivo.

---

## 4. O que é licenciado (freemium?)

Decisão de produto — recomendo **não travar tudo**:

| Comando | Sugestão |
|---|---|
| `init`, `synth`, `diagram`, `audit-*`, `ls`, `doctor` | **livres** (offline, sem valor de nuvem) — vira o "core aberto" que atrai o usuário |
| `ai`, `deploy`, `destroy`, `dashboard` | **licenciados** (é onde está o valor: IA + provisionamento real) |

Isso reduz atrito (a pessoa experimenta o `synth` grátis) e concentra a cobrança no que
custa (IA/deploy). Alternativa: travar **tudo** após o trial — mais simples, mais atrito.

---

## 5. Device fingerprint (identificar a máquina)

O que você citou (**MAC address, IP**) tem problemas — deixo o alerta e uma proposta melhor:

- **MAC**: muda em VMs/containers, pode ser spoofado, múltiplas interfaces. Frágil sozinho.
- **IP**: muda o tempo todo (DHCP, VPN, redes diferentes). **Não serve** como identidade —
  serve como telemetria/antifraude, não como binding.
- **Proposta:** fingerprint estável = hash de `machine-id` do SO (`node-machine-id`) +
  hostname + plataforma/arch. Tolerar mudança de IP; re-vincular com fricção leve se o
  machine-id mudar (reinstalação de SO).

⚠️ **Privacidade (LGPD/GDPR):** MAC, IP e machine-id são **dados pessoais/identificáveis**.
Coletar exige **consentimento explícito**, **política de privacidade**, e base legal.
Colete o **mínimo** (um hash, não o MAC cru), diga ao usuário o que coleta, e permita
opt-out de telemetria não-essencial. **Não** exfiltre dados sensíveis do projeto do cliente.

---

## 6. Validação da licença (o ponto mais delicado)

Trade-off central — **online vs offline**:

- **Token assinado (offline-first):** a licença é um **JWT assinado** pela chave privada
  do servidor; a CLI valida com a **chave pública embutida** (sem rede). Prós: funciona
  offline, rápido. Contras: revogar exige expiração curta + re-check periódico.
- **Check online:** cada comando bate no servidor. Prós: revogável na hora. Contras:
  exige internet **sempre** (mata CI, air-gapped, avião) e nossa infra vira ponto único
  de falha do trabalho do cliente.
- **Recomendado — híbrido:** JWT offline com validade curta (ex: 7 dias) + **re-check
  online silencioso** quando houver rede, que renova o JWT. Assim:
  - Funciona offline por até 7 dias (grace).
  - Revogação/renovação propaga no próximo re-check.
  - **Se o NOSSO servidor cair, o cliente não para** (usa o JWT em cache até expirar).

**Degradação graciosa é inegociável:** nunca bloquear o trabalho do cliente por causa de
downtime da nossa API. Downtime → fail-open dentro do grace; só fail-closed quando o JWT
realmente expira e não há como renovar.

---

## 7. Enterprise (seats)

- **Seat = 1 device ativo.** Comprou 10 seats → 10 máquinas simultâneas. Realocar libera
  o seat da máquina antiga.
- **Console admin:** lista devices, quem ativou, último uso; revogar/reatribuir; SSO
  opcional; convite por e-mail de domínio corporativo.
- **Billing:** volume tiers (ex: 10+ = US$ 45, 50+ = US$ 40), fatura/boleto, PO, renovação
  anual, contrato.
- **Service accounts / CI:** ver §8.

---

## 8. Coisas que costumam ser esquecidas (e você não citou)

1. **CI/CD & containers:** pipelines usam máquinas **efêmeras** — device binding não
   funciona. Precisa de **licença de CI** (token de organização, sem fingerprint, com
   limite de execuções concorrentes ou por repositório). Sem isso, o produto é inutilizável
   em automação — que é justamente onde IaC roda.
2. **Múltiplos devices por dev:** laptop + desktop + WSL. Cobrar 3× irrita. Considere
   "1 licença = 1 usuário com até N devices" **ou** deixe explícito que é por máquina.
3. **Transferência/reinstalação:** trocar de notebook não pode exigir suporte. **Self-service
   de re-bind** (libera o device antigo).
4. **Trial abuse:** e-mails descartáveis para trials infinitos. Mitigar: verificação de
   e-mail, fingerprint, rate-limit por fingerprint/IP, e-mails corporativos p/ enterprise.
5. **Pirataria/compartilhamento de token:** binding + expiração curta + re-check reduzem,
   mas não eliminam. Aceite um nível de vazamento (como toda ferramenta paga) — o custo de
   DRM agressivo é atrito nos clientes legítimos.
6. **Reembolso/cancelamento:** política clara (ex: 14 dias). Cancelou → licença vale até o
   fim do período pago, sem renovar.
7. **Updates:** a anual cobre updates do ano? (recomendo sim — alinha incentivo). Versão
   nova exige a licença ativa.
8. **Preço em BRL vs USD:** cobrar US$ 50 no Brasil = câmbio + IOF + impostos. Decida
   moeda de cobrança e se haverá preço regional.
9. **Impostos/nota fiscal:** vender software no BR exige emissão de NF; Stripe não emite —
   precisa de integração fiscal ou intermediário (ex: revenda por uma PJ).
10. **Suporte & SLA:** individual (comunidade/e-mail) vs enterprise (SLA, canal dedicado).
11. **Telemetria de uso:** quanto o cliente usa (deploys, projetos) — útil pra billing
    enterprise por consumo e pra produto. Com consentimento.
12. **Offline/air-gapped enterprise:** alguns clientes não deixam a CLI chamar a internet.
    Ofereça **licença offline de longa validade** (assinada, sem phone-home) para esses.
13. **Kill switch responsável:** revogar por chargeback/fraude, mas com aviso — nunca
    apagar o trabalho local do cliente.
14. **Versão da API de licença:** versione (v1) — mudar o esquema do token depois sem
    quebrar clientes instalados.
15. **Segredo no cliente:** a chave **pública** vai na CLI (ok). A **privada** nunca sai do
    servidor. O token do cliente é dele — não é segredo global.
16. **Bootstrap do npm:** o `postinstall` do npm **não deve** falhar o install se a rede
    cair (senão nem instala). A ativação acontece no **primeiro comando**, não no install.
17. **Marca/legal:** EULA, Termos de Serviço, Política de Privacidade, política de
    licença (o que a licença permite: uso comercial? nº de projetos?).

---

## 9. Riscos principais

| Risco | Mitigação |
|---|---|
| Nossa API cai e trava clientes | JWT offline + grace + fail-open (§6) |
| Atrito mata adoção | core aberto (§4), trial fácil, re-bind self-service |
| CI inutilizável | licença de CI dedicada (§8.1) |
| Vazamento de token | binding + expiração curta; aceitar resíduo |
| LGPD/multas | consentimento, mínimo de dado, política clara (§5) |
| Cobrança no BR (NF/impostos) | definir intermediário fiscal antes de vender (§8.9) |

---

## 10. Roadmap sugerido (fases)

1. **MVP de licença (offline):** módulo `@iacmp/license` na CLI (fingerprint + JWT +
   cache + grace) e um portal mínimo (cadastro + emissão de token de trial). Sem pagamento
   ainda — valida a mecânica de ativação/expiração.
2. **Pagamento:** Stripe Checkout + webhooks + upgrade trial→anual. Emissão de NF.
3. **Enterprise:** seats, console admin, faturamento, licença de CI.
4. **Refino:** telemetria (consentida), tiers de volume, SSO, licença offline enterprise.

---

## 11. Decisões em aberto (precisam da sua definição)

- Travar **tudo** após o trial, ou **freemium** (core aberto + `ai`/`deploy` pagos)? [§4]
- Licença **por máquina** ou **por usuário (N devices)**? [§8.2]
- Moeda de cobrança (USD/BRL) e preço regional? [§8.8]
- Como emitir **nota fiscal** no Brasil? [§8.9]
- Onde hospedar a **License API + portal** (e quem mantém)?
- Este documento fica no **repo público** ou vai pra um privado?
