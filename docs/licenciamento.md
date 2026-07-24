# Modelo de negócio — iacmp

> Rascunho de design, **v3**. Substitui a v1 (licença por máquina + fingerprint, commit
> `da2523a`) e a v2 (CLI MIT + serviço). Ambas estão no histórico do git.
>
> Decisão: **plataforma paga. Sem versão gratuita distribuível, sem fork possível.**
> Este documento descreve a única arquitetura que entrega isso de verdade — e o que
> ela custa.

---

## 0. URGENTE — janela de 72 horas

Antes de qualquer discussão de modelo, há uma ação com prazo. Estes pacotes estão
**públicos no npm, sob MIT, agora**:

| Pacote | Versão | Situação |
|---|---|---|
| `iacmp` | 2.3.0 | publicado **24/07/2026 13:49 BRT** |
| `@iacmp/core` | 2.3.0 | público |
| **`@iacmp/knowledge`** | **2.3.0** | **público — 148 KB, o corpus inteiro em texto legível** |
| `@iacmp/mcp` | 0.2.0 | público |
| `@iacmp/runtime` | 0.2.0 | público |

O item crítico é o `@iacmp/knowledge`. Qualquer pessoa, agora, roda
`npm pack @iacmp/knowledge` e recebe **todo o corpus validado** — cada padrão que os
20 ciclos de deploy real produziram, em arquivos separados e comentados. Não é código
compilado difícil de ler: é a sua base de conhecimento, servida em bandeja, com licença
que autoriza uso comercial.

Se existe uma coisa neste documento que não pode esperar, é essa.

### O que dá para fazer, e a janela real

Três fatos apurados hoje:

1. O `iacmp@2.3.0` foi publicado há poucas horas. A política do npm permite despublicar
   livremente **nas primeiras 72 horas** — ou seja, até **segunda-feira, 27/07, 13:49 BRT**.
2. Para as versões mais antigas (1.1.0 a 2.2.2, desde 17/06), a despublicação depois de
   72h exige três critérios **simultâneos**: nenhum pacote no registro público depender
   dele, menos de 300 downloads na última semana, e um único owner. **O iacmp atende aos
   três hoje** — zero dependentes confirmados, downloads irrelevantes, um dono. Esse é o
   tipo de critério que só fica mais difícil com o tempo: se o projeto crescer, a porta
   fecha.
3. Você é o **único titular dos direitos autorais** (423 commits, todos das suas três
   identidades de git). Não há contribuidor externo para consultar. Você pode relicenciar
   o que vier daqui para frente sem pedir autorização a ninguém.

Efeitos colaterais a aceitar: despublicando **todas** as versões, o nome fica bloqueado
por 24 horas antes de aceitar publicação nova, e **números de versão já usados nunca
podem ser reaproveitados** — republica como `3.0.0`.

### O que despublicar não faz

Não apaga cópias que já foram baixadas, nem espelhos e caches de terceiros. Licença MIT
concedida é irrevogável: quem pegou, pegou, e pode usar comercialmente para sempre.

**Mas o dano real é pequeno, e vale dizer isso com clareza para você não decidir com
medo — por dois motivos.**

Primeiro: **o repositório sempre foi privado.** Isso restringe a exposição a um único
vetor. Não há histórico de git público, não há issue, não há botão de fork no GitHub,
não há árvore de commits para alguém entender a evolução do projeto. Existe apenas o
tarball que você mesmo publicou no npm. Fechar o npm fecha a porta inteira — é raro um
problema desses ter uma superfície tão pequena.

Segundo: o que saiu é um retrato congelado de junho/julho de 2026 de um projeto que
praticamente ninguém baixou. Corpus congelado envelhece — provider muda API, padrão
quebra. Ninguém mantém fork de projeto desconhecido.

A urgência, portanto, não é apagar o passado. É **parar de publicar o ativo a cada
release**, que é o que aconteceria seguindo o fluxo atual.

### A ordem importa (e não é a intuitiva)

O npm recusa despublicar um pacote enquanto **outro pacote do registro público depender
dele**. E os seus pacotes dependem uns dos outros:

```
iacmp  →  @iacmp/core, @iacmp/mcp, @iacmp/runtime
              @iacmp/mcp  →  @iacmp/knowledge
```

Ou seja: o `@iacmp/knowledge`, que é o mais valioso e o que dá mais vontade de tirar
primeiro, é **o último que pode sair** — o `@iacmp/mcp` o segura. A ordem correta é
reverse-topológica:

1. `iacmp` — ninguém depende dele, e ainda está dentro da janela de 72h
2. `@iacmp/mcp`
3. `@iacmp/core` e `@iacmp/runtime`
4. `@iacmp/knowledge`

Tentar na ordem errada não causa dano, só falha com erro de dependente — mas custa
tempo de propagação do registro entre tentativas.

O script `scripts/despublicar-npm.sh` faz isso na ordem certa, com simulação por
padrão. Ele roda **na sua máquina**, porque é lá que está o seu token do npm.

### Checklist

- [ ] `./scripts/despublicar-npm.sh` (simula) → `--executar` (vale)
- [ ] Substituir o `LICENSE` MIT por licença proprietária / EULA (§5)
- [ ] Ajustar a seção "Licença" do README, que ainda anuncia MIT
- [ ] Remover o `LICENSE` do `prepack` e do `files` do `packages/cli/package.json`
- [ ] Reservar o nome `iacmp` no npm com um pacote-stub privado ou placeholder, para
      ninguém ocupar
- [ ] Registrar a marca `iacmp` no INPI (§5)

---

## 1. A verdade desconfortável sobre "sem fork"

Preciso ser direto, porque a decisão depende disso:

> **Um CLI instalado na máquina do cliente nunca é à prova de fork.**

Você publica `dist/` em JavaScript. Bundle do tsup não é proteção — é concatenação.
Ofuscação, `bytenode`, executável único: todos aumentam o custo de quem quer copiar,
nenhum impede. Se o valor está no código que você entrega, o valor está no disco dele.
Licença proprietária torna o fork **ilegal**, o que é útil contra empresa (empresa não
usa software pirata), e inútil contra indivíduo no outro lado do mundo.

Daí sai a única conclusão que realmente entrega o que você pediu:

> **Para que forkar não adiante, não entregue a parte valiosa. Entregue um cliente
> magro e rode o miolo no seu servidor.**

Não é "open source versus fechado". É **onde o código executa**. Fechar o código sem
mudar a arquitetura te dá uma proibição jurídica; mudar a arquitetura te dá uma
impossibilidade técnica. Você pediu a segunda.

---

## 2. Onde cortar — o corte já existe no seu código

A boa notícia: a arquitetura atual já tem a costura exata no lugar certo. Hoje o
pipeline é

```
stack.ts do cliente → Stack (árvore de constructs)
                    → buildGraph(stack)      → StackGraph
                    → emitCloudFormation(g)  → template
                    → emitTerraform(t)       → .tf.json
```

`buildGraph` e os `emit*` são **onde moram os 20 ciclos de bateria**. Cada bug de
Lambda em VPC, cada correção de dependência de ECS/ALB, cada ajuste de Step Functions —
está tudo ali. É o ativo, e ele é uma função pura: entra grafo, sai template. **Função
pura é a coisa mais fácil do mundo de mover para um servidor.**

### O corte

| Fica no cliente (magro, descartável) | Vai para o servidor (o produto) |
|---|---|
| `@iacmp/core`: as classes de construct — só um DSL que serializa uma árvore JSON | `buildGraph` + validação semântica |
| Shell do CLI (oclif), parsing de flags, I/O | Todos os `emit*` (CFN, ARM, Terraform, Bicep) |
| **Execução do deploy** com as credenciais locais do cliente | Knowledge base e RAG |
| Cliente HTTP + cache do último synth | Geração via IA |
| — | Auditorias, diagramas, drift, dashboard da org |

O cliente vira: *serializa a árvore, manda para a API, recebe o template, grava em
disco, chama o `aws cloudformation deploy`.* Quem forkar isso ganha um serializador de
JSON e um wrapper de AWS CLI. **Sem o servidor, não sintetiza nada.** É esse o "sem
fork" que você quer — e ele não precisa de fingerprint, JWT, grace period ou kill
switch. O gate é o servidor não responder.

### Uma propriedade que vale ouro

Note que **credencial de nuvem nunca sai da máquina do cliente**. O servidor recebe uma
descrição de infraestrutura e devolve um template; ele nunca vê chave da AWS, nunca
assume role, nunca toca na conta de ninguém. Isso derruba a primeira objeção de
qualquer time de segurança e elimina o seu maior passivo — você não quer ser depositário
de credencial de produção alheia. **Diga isso na página de vendas.**

---

## 3. O preço da decisão (e como pagar barato)

Não existe almoço grátis. Custos reais deste modelo, sem maquiagem:

**1. Acabou o offline.** `synth` precisa de rede. Avião, cliente air-gapped, queda de
internet: não sintetiza.
*Mitigação estrutural:* o resultado do synth é um **arquivo**, e arquivo vai para o
repositório. Ou seja, **o `deploy` não precisa do seu servidor** — só a autoria precisa.
Um pipeline de CI que dá deploy do template já commitado roda com você offline. É uma
diferença enorme de exposição, e cai de graça se você commitar o `synth/`. Além disso:
cache local do último synth por stack, para reexecução idêntica.

**2. Seu uptime virou a ferramenta deles.** Se a API cai, ninguém sintetiza. Isso é ops
de verdade, com alerta e plantão, para um fundador sozinho. É o custo mais alto da
decisão, e é recorrente.
*Mitigação:* a função crítica é pura e sem estado — dá para rodar em múltiplas regiões
atrás de um CDN com custo baixo. Priorize disponibilidade do endpoint de synth acima de
qualquer feature.

**3. Cliente air-gapped fica de fora.** Banco, governo, telecom não deixam CLI chamar
API externa.
*Mitigação:* isso não é perda, é **tier**. Imagem on-premise sob contrato, no Enterprise,
com preço de Enterprise. Cliente que exige air-gap é cliente com orçamento.

**4. Latência em todo synth.** Grafo → template é rápido; o round-trip domina.
Aceitável se ficar abaixo de ~1s. Meça e publique o número.

---

## 4. Planos

Com plataforma, a unidade de cobrança deixa de ser máquina e passa a ser **pessoa** —
porque a credencial vira uma API key, e API key é de gente, não de hardware. Isso
resolve sem esforço tudo que a v1 penava: laptop + desktop + WSL é a mesma chave; CI é
uma *service account*; troca de notebook não existe como problema; revogação é imediata
do lado do servidor.

| Plano | Preço | O que é |
|---|---|---|
| **Trial** | 14 dias, **com cartão na entrada** | Plataforma inteira, limite de synths/dia. |
| **Pro** | US$ 25 / usuário / mês (anual) | Synth completo, IA, MCP hospedado, corpus vivo. |
| **Team** | US$ 40 / usuário / mês, mín. 3 | Memória de time compartilhada, dashboard da org, drift, policy no CI. |
| **Enterprise** | Sob consulta (piso ~US$ 15 mil/ano) | On-premise/air-gapped, SSO, DPA, SLA, NF, suporte nomeado. |

Quatro posições, e mantenho as três primeiras da v2 porque a mudança de licença não
as afeta:

**Trial de 2 dias é curto demais.** Ninguém avalia ferramenta de infraestrutura em dois
dias — não dá tempo de subir um ambiente de verdade, quanto mais de conseguir aprovação
de orçamento. Catorze dias. E **exigir cartão na entrada** elimina praticamente todo o
abuso de trial sem uma linha de antifraude, fingerprint ou verificação de e-mail
descartável — a §8.4 da v1 inteira desaparece.

**US$ 50/máquina/ano não cobre o cliente.** Uma troca de e-mails sobre credencial de AWS
já consome a margem do ano. E a matemática de escala: US$ 50 mil de receita recorrente
são **mil** desenvolvedores pagantes a US$ 50, ou **~40 times** no Team. Quarenta
conversas é meta de trabalho; mil assinaturas de um CLI desconhecido é loteria.

**Não revenda token de IA.** A `ANTHROPIC_API_KEY` continua do cliente, ou vira add-on
medido por consumo. Incluir inferência no preço fixo troca margem de ~95% por margem
imprevisível, onde o cliente mais engajado é o que dá prejuízo.

**O funil precisa de um degrau grátis — e agora ele pode existir sem risco.** Este é o
ganho escondido da decisão: num modelo open source, "grátis" significa entregar o
produto. Numa plataforma, "grátis" é só uma **linha na tabela de quota** — por exemplo,
20 synths por mês, projeto único, sem IA. Não é forkável, não é copiável, e você desliga
quando quiser. Você consegue topo de funil sem abrir mão de nada. Sem algum degrau
assim, uma ferramenta paga e desconhecida competindo com CDK, Pulumi e Terraform
gratuitos tem um problema sério de primeira conversa.

---

## 5. Camada jurídica (barata e subestimada)

Fechar o código sem fechar o contrato é meio caminho:

1. **EULA proprietária** substituindo o MIT: licença de uso, não de cópia; proibição
   expressa de redistribuição, engenharia reversa e uso do serviço para construir
   produto concorrente.
2. **Termos de Serviço + Política de Privacidade** da plataforma (§6) — obrigatório para
   cobrar, e o Paddle/Stripe vai exigir.
3. **Marca `iacmp` no INPI.** Custa pouco e é a única defesa que funciona contra o fork
   da 2.3.0 que sobreviveu: ele pode usar o código, **não pode usar o nome**. Um fork
   sem nome, sem npm e sem servidor não é concorrente.
4. **Sem CLA, sem PR externo** enquanto o repositório for fechado. Contribuição de
   terceiro sem cessão de direitos contamina a titularidade — e hoje ela está limpa
   (§0.3). Preserve isso.

---

## 6. Privacidade — o risco mudou de lugar

A v1 se preocupava com MAC e machine-id. Com plataforma, o dado que trafega é **a
descrição da infraestrutura do cliente**, o que é ordem de grandeza mais sensível.
Compromissos que precisam estar escritos **antes** do primeiro cliente pagante:

1. **Nunca trafega credencial** — é propriedade da arquitetura (§2), e deve ter teste
   automatizado provando.
2. **Redação no cliente antes do envio:** ARN de conta, IP privado, nome de bucket de
   produção, string de conexão. Sai o formato, não o segredo.
3. **Não treinamos nada com infraestrutura de cliente.** Memória de time é isolada por
   organização. Compromisso contratual, não parágrafo de blog.
4. **Retenção curta e definida**, deletável por API.
5. **DPA e opção on-premise** no Enterprise.

O `.env` já está no `.gitignore` e o autolearn já é opt-in local — a cultura do projeto
está certa. Falta virar documento assinável.

---

## 7. Faturamento

Use **merchant of record** (Paddle ou Lemon Squeezy), não Stripe direto. O MoR vende ao
cliente final, cuida de imposto em cada jurisdição, emite o documento fiscal dele, e te
paga como fornecedor único no exterior — você emite **uma** invoice por mês em vez de
NF por assinante por município. A taxa maior (~5% contra ~3%) é o preço de não montar
operação fiscal.

Decida com contador, antes de vender, se recebe via PJ brasileira (câmbio, enquadramento
de exportação de serviço) ou PJ no exterior — muda o líquido em dezenas de pontos
percentuais. Não sou contador nem advogado; o que afirmo aqui é o caminho, não o
enquadramento. Enterprise vai por contrato e NF direta — são poucos, dá para tratar
manualmente.

---

## 8. Roadmap

**Fase 0 — contenção (esta semana, antes de qualquer código).**
O checklist da §0. Despublicar, fechar o repositório, trocar a licença. **A janela do
`iacmp@2.3.0` fecha segunda 27/07 às 13:49.**

**Fase 1 — o corte cliente/servidor (4 a 6 semanas).**
Serializar `Stack` → JSON no cliente; `buildGraph` + `emit*` atrás de um endpoint;
API key; cache local; fallback com mensagem clara quando não houver rede. Sem portal —
as chaves saem de um comando administrativo seu e vão por e-mail. Isso já é o produto
inteiro para os primeiros clientes.

**Fase 2 — cobrança (2 a 3 semanas).**
MoR, trial de 14 dias com cartão, quota do degrau grátis. Ainda sem console de admin.

**Fase 3 — plataforma de time.**
Memória compartilhada por organização, convite por e-mail, dashboard. É o que segura a
renovação.

**Fase 4 — continuidade e Enterprise.**
Drift, histórico de auditoria, Action de policy, SSO, imagem on-premise. Puxado por
cliente concreto, nunca antecipado.

**Um pedido, ainda que o modelo tenha mudado:** as Fases 1 e 2 somam ~2 meses de
trabalho antes da primeira cobrança. Coloque uma página com preço no ar **na semana que
vem**, com lista de espera, e converse com cinco times durante a Fase 1. Se ninguém
demonstrar interesse em pagar, o problema não estará na arquitetura — e é muito melhor
descobrir na semana 2 do que na semana 9.

---

## 9. Riscos

| Risco | Peso | Mitigação |
|---|---|---|
| **Uptime: sua API cai, ninguém sintetiza** | **Alto** | Endpoint puro e sem estado, multirregião; `deploy` independe do servidor (§3.1) |
| Ferramenta paga e desconhecida contra CDK/Pulumi/Terraform grátis | **Alto** | Degrau grátis por quota (§4); vender confiança validada, não geração de código |
| Fork da 2.3.0 sobrevivente | Baixo | Corpus congelado envelhece; marca registrada impede uso do nome (§5.3) |
| Fundador solo com produto + plataforma + suporte + plantão | **Alto** | Fases 1 e 2 cabem em uma pessoa; Fase 4 não — planeje ajuda ou preço maior |
| Vazar infraestrutura de cliente pela API | Alto | §6, com teste de redação antes do primeiro cliente |
| **README subvende o Azure** — diz "experimental / congelado / nunca validado em deploy real", o que já não é verdade | Médio | §9.1. Está deixando dinheiro na mesa e mandando o comprador não usar metade do produto |
| GCP prometido no nome e inexistente na prática | Médio | Deployment Manager foi descontinuado pela Google. Ou sai da promessa comercial, ou entra como "roadmap" com data, nunca como provider suportado |
| Fiscal/câmbio corroendo margem | Médio | MoR + contador antes da primeira venda (§7) |

### 9.1 O README está subvendendo o Azure

Conferindo o `docs/backlog-e2e-multicloud.md` contra o `README.md`, os dois discordam —
e quem está errado é o README, contra você.

**Estado real do Azure:** a matriz do harness marca **AWS 19/20 · Azure 19/20**, e o
único cenário que falta é WebSocket, que falta **nos dois**. O synth Azure emite Bicep,
usa Deployment Stacks, e cobre APIM (inclusive compartilhado, que corta 30–45 min por
projeto), Container Apps, Cosmos, Key Vault, Event Hubs, Logic Apps, WAF via App
Gateway/Front Door e Monitor. A auditoria de 24/07 fechou Workflow, Stream/Event Hubs e
microsserviço composto. Há API deployada de verdade rodando em `azure-api.net`. O que
de fato falta é **completar a bateria e2e pela régua dupla** — vários cenários ainda
sem deploy real do lado Azure, e o 08 travado por limite da subscription free-trial,
que é problema de conta, não de ferramenta.

**O que o README diz:** *"Experimental / congelado — synth gera ARM templates mas nunca
validado em deploy real; não recebe novas features. Não use Azure em produção."*

Três coisas erradas de uma vez: não é ARM (é Bicep), foi validado em deploy real, e
recebeu features esta semana. Pior: o próprio README, poucas linhas abaixo, mostra o
endpoint Azure funcionando.

Isso importa porque **multi-cloud é justificativa de preço**. Você vai cobrar por uma
plataforma cujo diferencial é escrever uma vez e subir em nuvens diferentes — e a sua
página de vendas manda o comprador não usar a segunda nuvem.

**Posição adotada (24/07): esta versão suporta AWS e Azure. Terraform e GCP são versões
futuras.** O README já foi atualizado nesses termos. As duas nuvens suportadas em
paridade de síntese (19/20 cada, faltando WebSocket nas duas), AWS com bateria e2e
completa, Azure com deploy real validado e bateria em conclusão.

Sobre o Terraform, registre a escolha para não reabrir depois: o emissor existe e teve
2 cenários validados em deploy real, então tirá-lo do escopo é **decisão comercial, não
limitação técnica** — reduz superfície de suporte e concentra a promessa em duas nuvens
bem cobertas. Ele volta quando houver bateria própria.

Honestidade calibrada vende mais caro do que otimismo ou pessimismo. O README estava
pessimista com o Azure e otimista com o GCP — exatamente invertido. Agora está calibrado.

---

## 10. Decisões em aberto

1. Existe **degrau grátis por quota**, ou a porta é 100% paga? Recomendo o degrau —
   é o funil, e não é forkável.
2. Onde hospeda o endpoint de synth, e qual a meta de disponibilidade que você assume
   por escrito?
3. **Fecha a bateria e2e do Azure antes de cobrar, ou vende com "Azure em validação"
   escrito na página?** Minha posição: vender com a ressalva. Esperar paridade e2e
   completa adia a receita por meses, e a ressalva honesta não derruba negócio.
4. O WebSocket (único cenário ausente, nas duas nuvens) entra antes de cobrar?

**Decididas em 24/07:** despublicar todos os pacotes do npm · repositório privado
(já era) · **AWS e Azure suportados, Terraform e GCP como versão futura**.
