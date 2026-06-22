# Plano — Entrada de voz no chat (transcrição PT/EN/ES)

## Objetivo

Permitir que o usuário escolha, a cada interação, entre digitar (fluxo atual, mantido sem mudanças) ou falar no `iacmp chat`, com transcrição automática em português, inglês ou espanhol, alimentando o mesmo fluxo de texto que já existe hoje (`ask()` → `session.addUserMessage()`). Voz é um modo adicional, não um substituto — o teclado continua funcionando exatamente como hoje em qualquer momento.

## Contexto atual

- `packages/cli/bin/chat.js` é um loop REPL puro em Node: `readline` lê stdin linha a linha via `ask(question)` (linha 93) e o texto vai direto para `session.addUserMessage()` (linha 284).
- Não há nenhuma dependência de áudio no monorepo hoje (`packages/ai/package.json`, `packages/cli/package.json`).
- A Anthropic não expõe API de speech-to-text. É necessário um provider externo de STT.

## Decisão de provider de STT

| Opção | Multilíngue (pt/en/es) | Custo | Complexidade |
|---|---|---|---|
| OpenAI Whisper API (`whisper-1` / `gpt-4o-transcribe`) | Sim, detecção automática de idioma | Pago por minuto | Baixa (1 chamada HTTP) |
| Whisper local (`whisper.cpp` / `faster-whisper`) | Sim | Grátis, custo de CPU/GPU local | Média (binário nativo, modelo a baixar) |
| Google Cloud Speech-to-Text | Sim | Pago | Média (SDK + credenciais GCP) |

Recomendação: **OpenAI Whisper API** como padrão (mesma filosofia de "configurar chave no `.env`" já usada para `ANTHROPIC_API_KEY`), com opção de variável de ambiente para apontar para um binário local (`whisper.cpp`) no futuro, sem acoplar a escolha agora.

## Captura de áudio

Node não grava áudio nativamente. Opções:

1. **`sox` / `arecord` / `ffmpeg` via child_process** — grava um `.wav` enquanto o usuário mantém uma tecla pressionada ou até apertar Enter de novo (push-to-talk simplificado). Sem dependência npm nativa, mas exige o binário instalado no sistema (`brew install sox` no macOS).
2. **Pacote npm `mic` ou `node-record-lpcm16`** — wrapper de `sox`/`rec`, mesma exigência de binário externo, mas API mais simples em JS.

Recomendação: usar `sox` via child_process diretamente (sem dependência npm extra), documentando a instalação do binário como pré-requisito — consistente com o estilo atual do projeto (scripts simples, poucas dependências).

## Fluxo proposto — texto e voz coexistindo

O prompt `> Você:` continua aceitando texto digitado normalmente, sem nenhuma mudança de comportamento. Voz é apenas mais uma opção disponível a cada turno, acionada por um comando explícito:

```
usuário digita normalmente            → segue exatamente o fluxo atual, sem alterações
usuário digita "/voz" no prompt        → entra no modo de gravação
  → chat.js inicia gravação (sox -d arquivo.wav) com mensagem "gravando... pressione Enter para parar"
  → ask() espera o Enter (reaproveita a fila de stdin já existente)
  → para a gravação (SIGINT no processo sox)
  → envia arquivo.wav para a API Whisper com idioma "auto"
  → recebe texto transcrito + idioma detectado
  → mostra "Você disse (pt): <texto>"
  → pede confirmação: Enter para usar como está, "/voz" para regravar, ou digitar texto livre para substituir/corrigir manualmente
  → texto final (transcrito ou corrigido) segue o fluxo normal: session.addUserMessage(texto) → runGeneration(...)
```

Ou seja, em nenhum momento o teclado é bloqueado: mesmo depois de transcrever, o usuário pode digitar para corrigir em vez de aceitar a transcrição, e na próxima rodada pode voltar a digitar normalmente sem precisar de `/voz` novamente. Mantém o texto como contrato interno único — a IA (Claude) continua recebendo apenas texto, sem qualquer mudança em `system-prompt.ts`, `context-reader.ts` ou `builder.ts`.

## Mudanças de código necessárias

1. **Novo módulo `packages/ai/src/voice/transcribe.ts`**
   - `recordAudio(): Promise<string>` — spawna `sox`, grava até receber sinal de parada, retorna caminho do `.wav` temporário.
   - `transcribeAudio(filePath: string): Promise<{ text: string; language: string }>` — chama a API Whisper (`POST https://api.openai.com/v1/audio/transcriptions`, `model: whisper-1`, sem `language` fixo para detecção automática entre pt/en/es).
   - Exportado em `packages/ai/src/index.ts`, igual ao padrão de `extractResponse`, `buildSystemPrompt`, etc.

2. **`packages/cli/bin/chat.js`**
   - Novo comando `/voz` no loop principal (ao lado de `/sair`, `/limpar`), opcional e isolado: quando digitado, dispara o fluxo de gravar → transcrever → confirmar → seguir fluxo normal de `input`. Quando não digitado, o loop se comporta exatamente como hoje (`ask()` lendo texto direto).
   - Banner inicial (linha 239, `Comandos: /sair, /quit ...`) ganha `/voz — grava um áudio e transcreve` na lista, deixando claro que é uma opção a mais e não substitui a digitação.
   - Mensagem de erro clara se `OPENAI_API_KEY` não estiver configurada ou se `sox` não for encontrado no PATH (`which sox`), apontando o comando de instalação (`brew install sox` / `apt install sox`) — e nesse caso o chat continua funcional por texto, sem travar.

3. **`.env.example` / docs**
   - Nova variável `OPENAI_API_KEY` (somente para STT, não confundir com a chave da Anthropic usada para geração).
   - Atualizar `docs/manual-de-uso.md` com seção "Entrada por voz".

4. **Dependências**
   - Nenhuma nova dependência npm obrigatória (chamada HTTP feita com `fetch` nativo do Node 20+, já é o `engines.node` mínimo do projeto).
   - Pré-requisito de sistema: binário `sox` instalado (documentar, não instalar automaticamente).

## Idioma de resposta

A transcrição já chega em texto no idioma original (pt/en/es). O comportamento de resposta do Claude já é determinado pelo `system-prompt.ts` — hoje fixo em português. Duas opções, a decidir com o usuário antes de implementar:
- (a) manter resposta sempre em pt-BR, independente do idioma falado (mais simples, consistente com a preferência global do usuário);
- (b) responder no mesmo idioma detectado pela transcrição (exige passar `language` detectado para o system prompt).

Recomendação: opção (a) por padrão, já que o usuário deste projeto trabalha em pt-BR; o reconhecimento multilíngue serve para aceitar comandos falados em outros idiomas, não necessariamente para mudar o idioma de resposta da ferramenta.

## Tratamento de erros e casos de borda

- Áudio vazio ou silêncio total → Whisper retorna string vazia → tratar como "não entendi, tente novamente" sem chamar o modelo.
- Idioma não suportado bem (ex: mistura de idiomas na mesma frase) → Whisper geralmente lida bem, mas exibir o texto transcrito para confirmação do usuário antes de enviar é a rede de segurança (já previsto no fluxo acima).
- Sem microfone disponível / `sox` falha ao abrir device → erro claro, não trava o REPL, volta ao prompt de texto normal.
- Custo: cada chamada de voz tem custo monetário (Whisper API) — vale logar a duração do áudio enviado, para o usuário ter noção de custo acumulado.

## Testes

- Testes automatizados de `transcribeAudio()` mockando a chamada HTTP (sem gravar áudio real), cobrindo: resposta válida, resposta vazia, erro de rede, erro de autenticação (401).
- Teste manual obrigatório do fluxo completo (gravação real + transcrição real) nos três idiomas antes de considerar a feature concluída — consistente com a exigência already conhecida do usuário de nunca declarar algo funcionando sem testar de fato.

## Fora de escopo (não fazer nesta etapa)

- Síntese de voz (texto → áudio) para a resposta do assistente — não foi pedido, só entrada de voz.
- Streaming de transcrição em tempo real (parcial enquanto fala) — complexidade desproporcional ao ganho para um CLI.
- Wake word / ativação por voz sem comando explícito `/voz`.

## Ordem de implementação sugerida

1. Módulo `transcribe.ts` isolado, testável com mocks, sem integração ainda com `chat.js`.
2. Captura de áudio via `sox` isolada (`recordAudio()`), testada manualmente.
3. Integração do comando `/voz` no loop de `chat.js`.
4. Documentação (`manual-de-uso.md`, `.env.example`).
5. Teste manual end-to-end nos três idiomas (pt, en, es) antes de considerar pronto.
