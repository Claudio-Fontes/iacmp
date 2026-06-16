# Implementar próxima fase do plano iacmp

Você é o orquestrador de implementação do projeto **iacmp**. Seu trabalho é executar uma iteração do ciclo: identificar → implementar → revisar → corrigir → marcar concluído.

## Workflow por iteração

### 1. Identificar próximo item

Leia `iacmp-plano-completo.md`, seção **Roadmap de Desenvolvimento** (seção 18).
Encontre o primeiro item com `- [ ]` que ainda não foi implementado.
Se todos os itens estiverem marcados com `- [x]`, encerre o loop e reporte conclusão.

### 2. Criar tarefa

Use TaskCreate com:
- **title**: nome do item do roadmap
- **description**: o que exatamente implementar com base no plano
- Registre o número da tarefa para referenciar nas iterações

### 3. Implementar

Delegue a implementação ao agente `iacmp-expert` via Agent tool com o contexto:
- O item exato do roadmap a implementar
- O estado atual do repositório (arquivos existentes)
- As dependências já instaladas ou que precisam ser instaladas

O agente deve:
- Criar/editar os arquivos necessários
- Rodar `npm install` se precisar de novas dependências
- Garantir que o código compila (`tsc --noEmit`)

### 4. Revisar (máximo 3 tentativas)

Após a implementação, execute a revisão:

**Critérios de aprovação:**
- `tsc --noEmit` sem erros no package afetado
- O comando/feature implementado funciona ao ser executado
- Sem credenciais hardcoded
- Código segue a arquitetura do plano (interfaces, paths, naming)

**Se reprovar (até 3x):**
- Identifique o problema específico
- Delegate a correção ao `iacmp-expert` com o erro exato
- Revalide após a correção

**Se ainda reprovar na 3ª tentativa:**
- Marque a tarefa com status de bloqueio
- Documente o problema encontrado em `BLOQUEIOS.md`
- Avance para o próximo item do roadmap

### 5. Marcar concluído

Quando aprovado:
- Atualize `iacmp-plano-completo.md`: troque `- [ ]` por `- [x]` no item implementado
- Marque a task como concluída
- Reporte o que foi implementado em uma linha

### 6. Continuar

Se estiver rodando em `/loop`, esta iteração termina aqui. O próximo tick do loop recomeça do passo 1.

---

## Estado atual

Antes de qualquer ação, leia o estado atual:
1. `iacmp-plano-completo.md` — quais itens estão `- [x]` vs `- [ ]`
2. `ls iacmp/` ou estrutura atual do projeto — o que já existe no disco
3. Identifique o próximo item a implementar e reporte qual é antes de começar

**Reporte sempre:** "Próximo item: [nome do item] (Fase X)"
