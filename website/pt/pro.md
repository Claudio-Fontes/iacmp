# iacmp Pro <Badge type="tip" text="em breve" />

O CLI aberto é completo e gratuito — synth, deploy, destroy, diff, auditorias e diagramas nas três nuvens, para sempre. O **iacmp Pro** é a camada paga sendo lançada em cima dele, construída em torno de um ativo: um corpus de padrões de infraestrutura em que **cada entrada foi validada por deploy real** — deployada, exercitada em runtime e destruída — em contas reais de AWS, Azure e GCP.

## O que o Pro destrava

### 1. Geração via IA que deploya de primeira

```bash
iacmp ai "uma API de pedidos: API Gateway, Lambda de CRUD e tabela DynamoDB, com worker de fila"
```

O gerador consulta o corpus validado antes de escrever qualquer linha — então as stacks que ele produz já carregam o que só a nuvem real ensina: o SSL que o RDS exige, o visibility timeout que o SQS impõe, o índice que o Cosmos cobra pra ordenar, as roles de IAM que um projeto GCP novo não tem. Hoje o corpus tem **58 padrões validados em deploy real** (e 97 rascunhos rotulados), e cresce a cada ciclo de validação.

### 2. MCP premium: seu agente consulta padrões validados

O Pro adiciona `search_examples` e `list_examples` ao servidor MCP embutido — antes de escrever infraestrutura, seu agente de código busca o padrão comprovado, com as regras aprendidas anexadas a cada exemplo.

Testado ponta a ponta com **Claude Code** e **Claude Desktop**. Outros clientes MCP devem funcionar (é protocolo aberto), mas ainda não foram validados — só afirmamos o que testamos.

### 3. Aprendizado compartilhado (submit_example)

Quando seu agente descobre um padrão que o corpus não cobre, ele pode **propor**. Nós validamos a proposta com deploy real — o mesmo processo de bateria que construiu o corpus — e todo assinante herda. O corpus continua curado: propostas são revisadas e testadas em deploy, nunca escritas direto.

## O que continua gratuito

Tudo que o CLI faz hoje: `init`, `synth`, `deploy`, `destroy`, `diff`, `diagram`, `audit-all`, `doctor`, o runtime agnóstico e as ferramentas mecânicas do MCP (`write_stack`, `synth_project`, `deploy_project`…). O CLI aberto nunca depende do Pro — esse é o acordo, permanente.

## Quando e quanto

Preço e data de lançamento serão anunciados aqui. Para ser avisado:

- **Dê watch ou star no repositório**: https://github.com/Claudio-Fontes/iacmp
- Ou me chame no [LinkedIn](https://www.linkedin.com/in/claudio-me1o) — interesse antecipado genuinamente molda o que sai primeiro.
