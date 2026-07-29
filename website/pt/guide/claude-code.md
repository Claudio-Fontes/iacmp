# Usando o iacmp com Claude Code

O iacmp embute um servidor MCP. Um comando o registra no Claude Code e no Claude Desktop:

```bash
iacmp setup
```

Só isso. Reinicie o Claude Code e o agente ganha ferramentas estruturadas para operar o iacmp — tudo local, sem API key, sem IA embutida:

| Ferramenta | O que o agente faz com ela |
|---|---|
| `write_stack` | Escreve/atualiza stacks com código de constructs validado |
| `synth_project` | Roda o synth e lê os erros de volta para se autocorrigir |
| `deploy_project` / `destroy_project` | Deploy/destroy reais, com confirmações |
| `validate_stack` | Validação semântica de uma stack antes do synth |
| `read_synth_output` | Inspeciona o CloudFormation/Bicep/Terraform gerado |

## O fluxo na prática

1. Crie e entre num projeto:

```bash
iacmp init minha-api --template blank
cd minha-api
```

2. Abra o Claude Code **na pasta do projeto** e descreva o que precisa:

> Crie uma API de clientes: API Gateway, uma Lambda de CRUD e uma tabela DynamoDB. Depois rode o synth e me mostre o resultado.

3. O agente escreve as stacks, roda `synth_project`, lê os erros de validação e corrige até ficar verde. Você revisa o TypeScript gerado — e só você decide a hora do `deploy`.

## Sem MCP? Também funciona

O `iacmp init` gera um `CLAUDE.md` no projeto que guia qualquer agente pelo fluxo certo (escrever stack → `iacmp synth` até ficar verde → perguntar antes do deploy). Mesmo sem as ferramentas MCP, agentes que leem o arquivo seguem o mesmo caminho pelo terminal.

## Dicas

- Mantenha uma stack por domínio (`stacks/network/`, `stacks/database/`, `stacks/compute/`) — o agente segue a estrutura existente.
- Peça `iacmp audit-all` depois da geração: auditorias de segurança, HA e DR em segundos.
- `iacmp diagram` te dá um diagrama C4 para conferir a arquitetura que o agente montou.
