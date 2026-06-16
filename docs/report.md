# Relatório de Melhorias — Projeto iacmp

> **Data:** 2026-06-16
> **Escopo:** documentação + código (monorepo Turborepo TypeScript, CLI multi-cloud com geração de IaC via IA)
> **Método:** auditoria multi-agente em 10 dimensões com verificação adversarial. Achados rejeitados foram removidos e severidades ajustadas pelo passe de verificação. Este relatório sintetiza, agrupa duplicatas entre dimensões e prioriza — não introduz achados novos.

---

## 1. Sumário executivo

O iacmp tem uma fundação técnica acima da média para um produto nesse estágio: `strict:true` herdado por todos os pacotes, zero `any` em código de produção, validação runtime do output da IA, defaults de criptografia ativos na maioria dos providers e uma documentação volumosa em pt-BR. Porém a auditoria revela **dívida concentrada em três frentes que minam o valor central do produto**: (1) o **pipeline pós-`synth` está quebrado** — `synth` grava em `synth-out/<provider>/` mas todos os comandos downstream leem `synth-out/` plano, inutilizando o caminho feliz documentado; (2) há uma **superfície de segurança real** na cadeia "IA gera arquivo/comando → CLI executa", com path traversal e command injection sem validação, agravada por execução de código TS gerado via `require()`; e (3) a **publicação npm está quebrada na prática** (deps internas `*` sem bundle nem inclusão no pacote). Somam-se a isso lacunas estruturais — zero CI, sem linter, cobertura de testes desbalanceada (CLI com 3.484 LOC e zero testes) — e desalinhamentos sérios entre documentação e código. As correções de maior impacto têm esforço baixo: os 3 achados críticos e boa parte dos `high` são `effort: low`.

### Contagem por severidade

| Severidade | Quantidade |
|---|---|
| 🔴 Critical | 3 |
| 🟠 High | 17 |
| 🟡 Medium | 50 |
| ⚪ Low | 27 |
| **Total** | **97** |

### Contagem por dimensão

| Dimensão | 🔴 | 🟠 | 🟡 | ⚪ | Total |
|---|---|---|---|---|---|
| Arquitetura | 0 | 1 | 6 | 2 | 9 |
| AI / RAG | 0 | 1 | 6 | 4 | 11 |
| AI Chat / Tools | 0 | 3 | 6 | 3 | 12 |
| CLI | 1 | 3 | 3 | 3 | 10 |
| Providers / Synth | 0 | 3 | 6 | 5 | 14 |
| Segurança | 0 | 2 | 3 | 3 | 8 |
| Testes | 2 | 3 | 2 | 0 | 7 |
| Documentação | 0 | 0 | 10 | 2 | 12 |
| Build / DevEx / CI-CD | 1 | 1 | 5 | 3 | 10 |
| Type-safety / Erros | 0 | 1 | 3 | 2 | 6 |

> **Nota sobre duplicatas entre dimensões:** o path traversal nos tools `file-writer`/`file-deleter` aparece em quatro dimensões (SEC-01/SEC-02 de ai-chat-tools, SEC-01 de segurança, TS-01 de type-safety, RAG-09 de ai-rag). A senha `changeme` aparece em IAC-02 (providers) e SEC-03 (segurança). A publicação npm quebrada aparece em DX-01 e ARCH-05. O `synth-out/<provider>/` quebrado aparece em CLI-01 e DOC-08. Tratamos cada cluster como um único trabalho de correção (ver Top 10 e Roadmap).

---

## 2. Top 10 prioridades

Ordenado por (severidade × impacto / esforço). Clusters duplicados aparecem uma vez.

| # | Achado | Dimensão | Severidade | Esforço | Por que agora |
|---|---|---|---|---|---|
| 1 | **Pipeline `synth → deploy/destroy/diff/dashboard` quebrado** (synth grava em `synth-out/<provider>/`, consumidores leem plano) — CLI-01 | CLI | 🔴 Critical | Low | O caminho feliz principal do README está 100% inutilizável; correção é trivial e de altíssimo impacto. |
| 2 | **Cadeia de path traversal + command injection na IA** (file-writer, file-deleter, execSync com stackName/provider) — SEC-01/02/03 (ai-tools), SEC-01 (seg), TS-01, RAG-09 | Segurança / AI-Tools | 🟠 High | Low | Escrita/remoção fora do projeto e RCE local a partir de saída da IA; fix é uma função `safeJoin` + `execFileSync`. Cluster de maior risco. |
| 3 | **Publicação npm quebrada** (deps `*` sem bundle, `files` não inclui `@iacmp/*`) — DX-01, ARCH-05 | Build/DevEx | 🔴 Critical | High | `npm install -g iacmp` falha; bloqueia o objetivo de distribuir o produto. |
| 4 | **CLI inteiro sem testes** (3.484 LOC, 17 comandos, 4 módulos de diagrama) — TEST-01 | Testes | 🔴 Critical | High | Maior package por LOC, com toda a orquestração, sem rede de segurança — daí o CLI-01 passar despercebido. |
| 5 | **Ausência total de CI** (sem `.github/`, sem gate em PR) — DX-02, TEST-05 | Build/DevEx | 🟠 High | Medium | 229 testes existentes não protegem nada automaticamente; merges podem quebrar build/publicação. |
| 6 | **Senha `changeme` em plaintext no Terraform (RDS/DocumentDB)** — IAC-02, SEC-03 | Providers / Seg | 🟠 High | Low | Único provider que crava credencial previsível no `.tf`; quebra paridade de segurança; fix de 2 linhas. |
| 7 | **HCL não escapa strings** (quebra de template / interpolação) — IAC-01 | Providers | 🟠 High | Low | Valores gerados por IA quebram `terraform plan`; uma função `hclString()` resolve toda a superfície. |
| 8 | **Templates estruturalmente não-deployáveis** (subnets/SGs/VpcId vazios) — IAC-03 | Providers | 🟠 High | High | Output parece completo mas falha no apply; mina a confiança no produto. |
| 9 | **`diff`/`deploy`/`destroy` carregam `.ts` sem ts-node; `destroy` hard-coded p/ AWS** — CLI-02, CLI-03 | CLI | 🟠 High | Medium | Comandos silenciosamente inúteis para projetos `.ts` (o default) e para não-AWS. |
| 10 | **Busca vetorial/semântica é código morto** (embeddings Voyage gerados mas nunca consultados) — RAG-01 | AI/RAG | 🟠 High | Medium | Paga custo de API Voyage sem retorno; a principal vantagem do RAG moderno está ausente. |

---

## 3. Seções por dimensão

### 3.1 Arquitetura

**Estado:** fundação limpa (Stack/BaseConstruct minimalistas e agnósticos de provider, constructs por domínio com validação no construtor, separação razoável de packages). A dívida está em **dois mecanismos de provider paralelos** (plugin-sdk parcialmente decorativo), **extensibilidade cara** (4 synths de ~1000 linhas com switches de 31 casos espelhados + duplicação da API no system-prompt) e **tooling de monorepo subaproveitado** (sem project references, sem lint, versionamento fake).

| ID | Título | Sev | Esforço | Evidência | Recomendação |
|---|---|---|---|---|---|
| ARCH-02 | Adicionar construct exige editar 5+ arquivos com switches de 31 casos espelhados | 🟠 High | High | `cloudformation.ts` (1065), `arm.ts` (1087), `deployment-manager.ts` (966), `hcl.ts` (945) — todos com 31 `case`; sem registro central (`stack.ts:3` `type` é só `string`) | Registro central de tipos (enum/const + metadados) em core; cada synth registra handlers num `Map<type,handler>`; gerar `TYPE_META` e doc do prompt a partir dele |
| ARCH-01 | Dois mecanismos de provider paralelos; nativos não implementam `IacmpProvider` | 🟡 Medium | Medium | `plugin-sdk/src/plugin.ts:3-12` define a interface; `providers/aws/src/provider.ts:4-10` não usa `implements`; `synth.ts:71-170` hardcoda `nativeProviders` em switch, plugins via `loadPlugins()` separado | Fazer providers nativos `implements IacmpProvider`, registrá-los no mesmo registry; CLI itera `Map<string,IacmpProvider>`; tipo de retorno comum `SynthArtifact` |
| ARCH-03 | API do `@iacmp/core` duplicada à mão em system-prompt de 658 linhas (drift) | 🟡 Medium | Medium | `ai/src/prompts/system-prompt.ts` (658 linhas, `## API completa do @iacmp/core` na :8); sem geração automática nem teste de paridade | Gerar a seção a partir dos `.d.ts`/AST do core, ou teste que verifique que todos os exports de `core/src/index.ts` aparecem no prompt |
| ARCH-04 | Sem TS project references/composite; typecheck depende de `^build` | 🟡 Medium | Medium | `tsconfig.base.json` sem `composite`/`incremental`; nenhum `references` nos packages; `turbo.json` typecheck `dependsOn: ["^build"]` | Adotar `composite:true` + `references` por package + `tsc -b`; remove necessidade de `^build` em typecheck |
| ARCH-05 | Versionamento fake: todos em 1.0.0 com deps internas `*` | 🟡 Medium | Low | 10 packages em `1.0.0`, deps internas `"@iacmp/core": "*"`; sem changesets | Versões/ranges casados (`^1.0.0`) ou changesets; workspace ranges p/ deps puramente internas. **(Cluster com DX-01)** |
| ARCH-06 | Construct de tipo desconhecido descartado silenciosamente no synth | 🟡 Medium | Low | `cloudformation.ts:986-987` `default: return []` sem log; padrão nos 4 synths | Emitir warning estruturado ou acumular lista de `unsupported` retornada ao CLI. **(Cluster com IAC-06)** |
| ARCH-07 | `loadPlugins` assume export ambíguo e engole erros | 🟡 Medium | Low | `plugin-sdk/src/loader.ts:27,29` checa `pluginModule.providers`; `definePlugin` não define export; default export cai no warn da :32; catches mascaram config quebrada | Normalizar `const mod = m.default ?? m`; documentar shape; propagar erro de parse de `iacmp.json` |
| ARCH-08 | Sem task de lint; sem ESLint/Prettier | ⚪ Low | Low | `turbo.json` e raiz sem `lint`; sem `.eslintrc`/`.prettierrc` | ESLint (typescript-eslint) + Prettier + task `lint` no turbo. **(Cluster com DX-03, TS-06)** |
| ARCH-09 | Task `test` do Turbo depende de `build` e não cobre `cli` | ⚪ Low | Low | `turbo.json` test `dependsOn: ["build"]` (redundante p/ ts-jest sobre src); `cli` (3484 LOC) sem script test | Remover `dependsOn:[build]` do test; configurar jest no `cli`. **(Cluster com TEST-01, DX-09)** |

---

### 3.2 AI / RAG

**Estado:** muitas peças sofisticadas implementadas (BM25 próprio, Contextual Retrieval, embeddings Voyage, vector store, query-router, live-retriever), mas a arquitetura está **parcialmente desconectada**: o caminho vetorial é persistido mas nunca consultado, o query-router não roda no fluxo real, e o índice pré-construído é ignorado. O tokenizer destrói acentos do português — grave num produto pt-BR.

> **Nota de verificação:** RAG-02 (tokenizer) e RAG-09 (path traversal) foram rebaixados de high→medium. O tokenizer é simétrico (não quebra a recuperação por completo, mas degrada relevância em pt-BR); o path traversal tem confirmação interativa mitigante e paths absolutos já neutralizados por `path.join`.

| ID | Título | Sev | Esforço | Evidência | Recomendação |
|---|---|---|---|---|---|
| RAG-01 | Busca vetorial/semântica é gerada e persistida mas nunca consultada (código morto) | 🟠 High | Medium | `indexer.ts:194-221` gera embeddings Voyage e salva `vector-index.bin`; `retriever.ts:28-66` só chama `bm25Search()`; `.search()` (`vector-store.ts:43`) nunca invocado | Embeddar a query (`input_type:'query'`), rodar `vectorStore.search()`, fundir via RRF; ou remover o pipeline Voyage se for só BM25 |
| RAG-02 | Tokenizer destrói acentos — degrada recuperação em pt-BR | 🟡 Medium | Low | `bm25.ts:24-30` e `embedder.ts:100-106` usam `/[^a-z0-9\s._-]/g`; `'função'→['fun']`, `'máximo'→['ximo']` | Normalizar `text.normalize('NFD').replace(/[̀-ͯ]/g,'')` antes do replace; util compartilhado; reindexar |
| RAG-03 | Query-router implementado/testado mas nunca usado no fluxo | 🟡 Medium | Low | `query-router.ts` exportado e testado, mas `routeQuery` só aparece em testes; `context-reader.ts:160-165` busca sempre nos 3 corpora; `minScore=0.05` agrava | Ligar `routeQuery()` em `readProjectContextRAG`; zerar `projectK/docsK/knowledgeK` conforme `RoutingDecision`; usar `decision.useLive` |
| RAG-04 | Corpus de conhecimento sem Contextual Retrieval e fragmentado por seção pequena | 🟡 Medium | Medium | `indexer.ts` aplica Contextualizer só a project/docs; knowledge cru (:176/:182); `chunker.ts:104` split em todo `#/##/###`; títulos <50 chars descartados | Aplicar `enrichBatch` aos knowledgeChunks (markdown do arquivo como `fullDocument`); chunking hierárquico herdando título pai; embeddar `contextualContent` |
| RAG-05 | Contextual Retrieval de stacks usa documento truncado em 8KB e errado | 🟡 Medium | Low | `indexer.ts:146` concatena TODAS as stacks; `contextualizer.ts:39` `slice(0,8000)` | Contextualizar cada chunk contra o `.ts` de origem (via `metadata.file`), não a concatenação global; eliminar/ampliar o slice por arquivo |
| RAG-06 | Validação TS valida arquivos isolados com colisão de basename | 🟡 Medium | Medium | `validator.ts:18-19` usa `path.basename` descartando subpasta; arquivos de mesmo nome se sobrescrevem; imports relativos falham; `strict:false` (:51) | Preservar estrutura relativa de `file.path` no tmpDir; incluir stacks existentes no `include`; considerar `strict:true` |
| RAG-09 | Parser aceita caminhos sem validação — path traversal | 🟡 Medium | Low | `code-extractor.ts:74-77` aceita qualquer string; `file-writer.ts:16/30/48` `path.join` sem checar traversal; conteúdo controlado pelo LLM (injeção via RSS de `live-retriever.ts:196`) | `path.resolve(projectDir,file.path)` + `startsWith`; rejeitar `..`. **(Cluster de segurança; ver SEC-01)** |
| RAG-07 | Índice BM25 pré-construído (`corpus3-index.json`, ~940KB) gerado mas nunca carregado | ⚪ Low | Low | `scripts/ingest-knowledge.ts` gera o JSON; zero referências em código; `indexer.ts:68-89,176` re-chunka tudo a cada `buildIndexes` | Fonte única: carregar o JSON (ingest como build) ou remover o script/artefato |
| RAG-08 | Cache de índices em memória é escrito mas nunca lido — reindexa a cada mensagem | ⚪ Low | Low | `context-reader.ts:9` `indexCache=new Map`; `:158` faz `set` mas nada lê antes do `buildIndexes` (:157); `invalidateIndexCache` (:192) opera em cache não consultado | `if (indexCache.has(projectDir)) return cached`; invalidar só quando o hash de stacks mudar |
| RAG-10 | Tratamento de erros excessivamente silencioso mascara falhas | ⚪ Low | Low | Catches vazios em `contextualizer.ts:59-62`, `indexer.ts:81-84`, `context-reader.ts:185-188`, `vector-store.ts:156`, `live-retriever.ts:67` | Emitir avisos via `onProgress`/console; diferenciar erro recuperável de fatal; logar 1× por sessão quando cai no fallback legado |
| RAG-11 | Chunker de stacks usa regex frágil — perde props aninhadas e multi-construct | ⚪ Low | Medium | `chunker.ts:27` `\{[\s\S]*?\}` non-greedy trunca no 1º `}`; id só aceita aspas simples `[\w-]` | Matcher de chaves balanceadas (profundidade) + aspas duplas; idealmente usar AST do TS |

---

### 3.3 AI Chat / Tools

**Estado:** subsistema funcional com boa higiene de UX (confirmação via diff, dry-run, validação do JSON, cache com TTL, detecção de sessão malformada). A **fronteira de segurança é fraca**: caminhos e nomes de stack vêm do JSON da IA e são usados em `fs`/`execSync` sem validação. Robustez de rede também é fraca no caminho Copilot.

> **Nota de verificação:** SEC-01/SEC-02/SEC-03 foram rebaixados de critical→high (exigem resposta da IA maliciosa/comprometida + confirmação do usuário, não exploráveis por dados externos triviais). A evidência original alegava que paths absolutos escapam via `path.join` — isso é **incorreto** (`path.join` neutraliza o 2º arg absoluto); o vetor real é apenas `..`. REL-01 foi rebaixado de high→medium (o SDK Anthropic já aplica `maxRetries=2` por padrão; o gap real é o caminho Copilot).

| ID | Título | Sev | Esforço | Evidência | Recomendação |
|---|---|---|---|---|---|
| SEC-01 | Path traversal na escrita de arquivos (file-writer) | 🟠 High | Low | `file-writer.ts:48-50` `path.join(projectDir,file.path)`; `file.path` cru de `code-extractor.ts:74-77`; `../../../../Users/alex/.zshrc` escapa; diff mostra path literal | `const full=path.resolve(projectDir,file.path); if(!full.startsWith(path.resolve(projectDir)+path.sep)) throw`; rejeitar `..`; aplicar no dry-run |
| SEC-02 | Path traversal na remoção de arquivos (file-deleter) | 🟠 High | Low | `file-deleter.ts:122-125` `fs.rmSync(path.join(...), {force:true})`; `deletions` cru de `code-extractor.ts:83-85`; `removeReferences` (:35-48) reescreve `.ts` por regex de `stackName` | Validar cada path com `path.resolve`+`startsWith` antes de `allToDelete`; mostrar caminho absoluto na confirmação |
| SEC-03 | Command injection em destroy/synth via `stackName`/`provider` em `execSync` | 🟠 High | Low | `file-deleter.ts:104` `execSync(\`iacmp destroy --stack ${stackName} --provider ${iacProvider} --force\`)`; `synth-runner.ts:6,15` interpola `${provider}`; provider não validado contra allowlist | `execFileSync` com array de args (sem shell); validar `stackName` com `/^[A-Za-z0-9_-]+$/` e provider contra allowlist |
| REL-01 | Zero retry/backoff/timeout nas chamadas de provider (Copilot) | 🟡 Medium | Medium | Sem retry/429/AbortController em `providers/*.ts`; `copilot.ts:27,61` `fetch` sem timeout; erro de stream só falha o spinner (`ai.ts:109-113`) | `AbortController`+timeout+backoff exponencial em 429/5xx no Copilot; tratar erro de stream com 1-2 retries (Anthropic já tem resiliência do SDK) |
| REL-02 | Acesso não-guardado a `response.content[0]` e `data.choices[0]` | 🟡 Medium | Low | `anthropic.ts:25` `response.content[0]`; `copilot.ts:52` `data.choices[0].message.content`; cast `as` sem validar shape (:46) | Guardar `if(!block||block.type!=='text')`; validar `data.choices?.[0]?.message?.content` com erro descritivo |
| SEC-04 | `.iacmp/session.json` e `cache.json` não estão no `.gitignore` | 🟡 Medium | Low | `session-store.ts:6` grava histórico; `response-cache.ts:5` grava prompt+resposta; `git check-ignore` confirma não-ignorados | `init`/scaffold adiciona `.iacmp/` ao `.gitignore` do projeto; não persistir respostas completas em texto plano. **(Cluster com SEC-08, DX-05)** |
| REL-03 | `removeReferences` usa regex gananciosa que corrompe código não-relacionado | 🟡 Medium | Medium | `file-deleter.ts:37-42` `.*${stackName}.*` casa qualquer linha com a substring; `stackName` sem escape de metacaracteres (ex. `api.v2`) | Escapar `stackName`; limitar a imports/exports do módulo exato; mostrar diff e confirmar antes de reescrever |
| ROB-01 | Cache key no modo direto ignora contexto do projeto — resposta stale | 🟡 Medium | Low | `ai.ts:87,130` usa só `lastUserPrompt`; `chat.js:124-128` inclui hash de contexto; TTL 7 dias | Incluir hash de `projectContext` e provider na chave também no modo direto |
| ROB-02 | Sem limite de tamanho/contagem em `files`/`deletions` | ⚪ Low | Low | `code-extractor.ts:68-92` sem limites; `context-reader.ts:53-56` injeta todas as stacks sem teto de tokens | Limitar nº de files/deletions e tamanho em `validate()`; truncar/avisar quando contexto exceder orçamento de tokens |
| ROB-03 | `clearCache` chamado com 2 args mas implementação limpa o cache inteiro | ⚪ Low | Low | `chat.js:143,268` `clearCache(cwd, cacheKey)`; `response-cache.ts:72` só usa o 1º arg e faz `unlinkSync` do arquivo todo | `clearCacheEntry(projectDir, prompt)` que remove só a entrada com hash correspondente |

---

### 3.4 CLI

**Estado:** boa cobertura de comandos com flags consistentes e UX cuidada, mas o **pipeline pós-synth está quebrado** (achado crítico nº 1) e há divergências de carregamento de stacks (`.ts` sem ts-node), `destroy` hard-coded para AWS, varredura não-recursiva em `diff`, mistura de idioma e ausência de exit codes para CI.

| ID | Título | Sev | Esforço | Evidência | Recomendação |
|---|---|---|---|---|---|
| CLI-01 | `synth` grava em `synth-out/<provider>/` mas consumidores leem plano — pipeline quebrado | 🔴 Critical | Low | `synth.ts:121-122` cria `providerOutDir`; `deploy.ts:65,71`/`destroy.ts:43,48-50`/`diff.ts:115,123,148`/`dashboard.ts:76,80` leem plano → `templates.length===0`; plugin grava plano (`synth.ts:164`) | Padronizar: consumidores lerem `path.join(cwd,'synth-out',provider)`; teste e2e `synth→deploy` nos 4 providers. **(Cluster com DOC-08)** |
| CLI-02 | `deploy`/`destroy`/`diff` carregam `.ts` via `require()` sem ts-node | 🟠 High | Medium | `diff.ts:158` `require(stackPath)` sobre `.ts` sem registrar ts-node (vs `synth.ts:87-104`, `audit.ts:57-72`); CLI roda compilado | Extrair helper de registro de ts-node (duplicado em synth/audit) e reusar em `diff`; idealmente `diff` reusa `audit.loadStacks(cwd)` |
| CLI-03 | `destroy` hard-coded para AWS: só lê `.json` e conta `template.Resources` | 🟠 High | Low | `destroy.ts:49` filtra só `.json`; `:61` conta `Resources` (PascalCase, só AWS); Azure/GCP usam `resources` array; Terraform usa HCL; `deploy.ts:12-32` faz certo | Reusar `getResourceCount(path, provider)` de `deploy.ts` (extrair p/ módulo comum) + extensão por provider |
| CLI-04 | `diff` varre só o nível raiz de `stacks/` (não recursivo) | 🟡 Medium | Low | `diff.ts:135` sem recursão (vs `synth.ts:45-57`, `audit.ts:36-48`); templates de `init` criam em `stacks/compute/`, `stacks/network/` | Varredura recursiva (reusar `findStackFiles`/`loadStacks`); corrigir junto com CLI-01 |
| CLI-05 | README diz que deploy/destroy "fazem deploy" mas são simulados (MVP) | 🟡 Medium | Low | `README.md:53-54` sem ressalva; impl. só imprime `Would deploy/destroy` + `(MVP)` (`deploy.ts:90-96`, `destroy.ts:78-80`) | Marcar como `(simulado / dry-run no MVP)` no README; imprimir aviso de MVP em destaque (amarelo) |
| CLI-07 | Auditorias não retornam exit code ≠ 0 ao achar issues críticas | 🟡 Medium | Low | Sem `process.exit`/`this.exit` em `audit-*.ts`; `audit-security.ts:140-187` conta `critical` mas sai 0 | Flag `--fail-on=critical\|warning` (ou `--ci`) que faça `this.exit(1)`; manter exit 0 por padrão |
| CLI-06 | Comandos de auditoria e diagram em inglês; restante em pt-BR | ⚪ Low | Medium | `audit-security.ts:112,143,30` em inglês; idem `audit-ha/dr/improvements`; `diagram.ts` mistura | Padronizar descriptions/mensagens/relatórios `.md` em pt-BR (ou adotar i18n) |
| CLI-08 | Geradores de diagrama interpolam labels/descrições sem escape | ⚪ Low | Medium | `mermaid.ts:11-20` e `structurizr.ts:103` interpolam `label`/`description` sem escapar aspas/colchetes; props arbitrárias (`builder.ts:42-186`) | Escapar aspas duplas em label/description nos dois renderers; testes com caracteres especiais |
| CLI-09 | `watch` usa debounce global e re-sintetiza tudo, com mensagens confusas | ⚪ Low | Low | `watch.ts:37,60-64`: timer único; `runSynth` ignora `_event` e não filtra extensão; mostra arquivo temporário | Filtrar callback por `.ts/.js`; ignorar temporários; mensagem genérica "sintetizando" |
| CLI-10 | `loadStacks` (audit) engole erros de carregamento silenciosamente | ⚪ Low | Low | `audit.ts:77-85` catch com `// silently skip invalid stacks` sem log; auditorias e diagram dependem disso | Warning (stderr) por stack que falhar (como `synth.ts:108` faz com `this.warn`); retornar lista de falhas |

---

### 3.5 Providers / Synth

**Estado:** os 4 synths compartilham mapeamento consistente (~26 tipos cada) com bons defaults de segurança em vários pontos (S3 PublicAccessBlock, RDS StorageEncrypted, Azure TLS1_2). Porém há **problemas de correção sérios**: HCL não escapa strings, senha hardcoded no Terraform, muitos templates não-deployáveis (refs de rede vazias) e várias props silenciosamente ignoradas.

> **Nota de verificação:** IAC-02 (senha changeme) verificado com paths reais `packages/providers/aws/...` e `azure/...` (o achado abreviou os caminhos, mas os números de linha batem). IAC-01: termo "injeção" é tecnicamente codegen local (não injeção runtime web), mas a corrupção de template é real.

| ID | Título | Sev | Esforço | Evidência | Recomendação |
|---|---|---|---|---|---|
| IAC-01 | Gerador de HCL não escapa strings | 🟠 High | Low | `hcl.ts:40-43` `attr()` retorna `${key} = "${value}"` sem escape; afeta SG/secret/WAF descriptions (:310,:836), env vars (:615), `search_string` (:332) | `hclString(v)` escapando `\`→`\\`, `"`→`\"`, `${`→`$${`, `%{`→`%%{`; usar em todas as interpolações de string |
| IAC-02 | Senha de banco hardcoded `changeme` no Terraform | 🟠 High | Low | `hcl.ts:492` `attr('password','changeme')`; `:512` `master_password`; CFN usa SSM (`cloudformation.ts:534,557`), ARM usa `parameters` (`arm.ts:529...`) | `variable "db_password" { sensitive = true }` ou `random_password`+Secrets Manager. **(Cluster com SEC-03 de segurança)** |
| IAC-03 | Templates estruturalmente incompletos / não-deployáveis | 🟠 High | High | ECS `Subnets:[]` (`cloudformation.ts:153`/`hcl.ts:132`), EKS `SubnetIds:[]`, TargetGroup `VpcId:''` (`cloudformation.ts:396`), EC2 sem subnet/SG/profile (:51-58), GCP LB `backends:[]` | Referenciar VPC/subnets sintetizados (`synthesizeVPCChildren`) ou adicionar props obrigatórios (`vpcId`/`subnetIds`) com validação |
| IAC-04 | GCP `Storage.Bucket` lê `props.region` inexistente — location sempre default | 🟡 Medium | Low | `deployment-manager.ts:218,260` `(props.region as string) ?? 'US'`; `StorageBucketProps` (`storage.ts:3-11`) não tem `region` | Adicionar `region?`/`location?` a `StorageBucketProps` e propagar, ou remover leitura enganosa |
| IAC-05 | GCP lifecycle: transição e expiração mutuamente exclusivas e `condition` incorreta | 🟡 Medium | Low | `deployment-manager.ts:225-234` ternário perde transição quando há ambos; dois `age` na mesma `condition` (segundo sobrescreve) | Emitir regra GCS separada por ação (SetStorageClass + Delete) quando ambos presentes, como o S3 |
| IAC-06 | Construct não suportado descartado silenciosamente | 🟡 Medium | Low | 4 synths com `default: return []`/`return ''` sem log (`cloudformation.ts:986-987` etc.) | Emitir aviso coletável (metadado `unsupported`) listando `type`+provider; expor ao usuário. **(Cluster com ARCH-06)** |
| IAC-07 | Azure NSG: `protocol.toUpperCase()` quebra com undefined e casing inválido | 🟡 Medium | Low | `arm.ts:317,333` `.toUpperCase()`; protocol ausente → TypeError; Azure espera `Tcp/Udp/Icmp/*` | Mapa explícito `{tcp:'Tcp',udp:'Udp',icmp:'Icmp','-1':'*'}` com fallback seguro |
| IAC-08 | Props dos constructs ignoradas silenciosamente em vários providers | 🟡 Medium | Medium | `layerArns` (`function.ts:11`) em nenhum synth; `authType` (:23) ignorado; WAF `mode` só Azure; `deletionProtection` só CFN; `rotationDays` não no CFN | Auditar cada prop × 4 synths; implementar ou documentar não-suportadas; matriz de paridade testada |
| IAC-09 | Defaults inseguros: S3 público/CORS aberto e ApiGateway CORS `*` | 🟡 Medium | Low | ApiGateway CORS `['*']` (`cloudformation.ts:696`, `hcl.ts:646`); CloudFront `Cookies:{Forward:'all'}` (:461); S3 sem `BucketEncryption` explícita | CORS configurável (origins explícitos); `BucketEncryption` configurável; padronizar postura de cookies |
| IAC-10 | AWS EC2 `Compute.Instance` gera recurso isolado sem rede nem IAM | 🟡 Medium | Medium | `cloudformation.ts:51-58` só `InstanceType`/`ImageId`; sem subnet/SG/IamInstanceProfile/EBS; GCP usa `default` network | Expandir `ComputeInstanceProps` (subnet/SG/keyName/EBS); evitar default network no GCP; aplicar IamInstanceProfile |
| IAC-11 | AWS AutoScaling usa `LaunchConfiguration` (legado/descontinuado) | ⚪ Low | Medium | `cloudformation.ts:65-72`/`hcl.ts:68-89`; descontinuado p/ contas novas desde out/2023 | Migrar p/ `LaunchTemplate` + `AutoScalingGroup.LaunchTemplate` |
| IAC-12 | AWS ApiGateway REST emite Route/Integration com tipo V2 (mistura) | ⚪ Low | Medium | `cloudformation.ts:685-737`: RestApi (:691,701) com rotas V2 (:718,728); HCL ignora REST (`hcl.ts:638-683`) | Implementar caminho REST completo (Resource/Method/Deployment) ou normalizar/rejeitar `type:'REST'` |
| IAC-13 | Placeholders hardcoded (`PROJECT_ID`, `ACCOUNT_ID`, region `us-east-1`) | ⚪ Low | Medium | GCP `PROJECT_ID` (`deployment-manager.ts:535...`); HCL region fixa `us-east-1` (:935); ARM `admin@example.com` (`arm.ts:745`) | Usar `data.aws_caller_identity`/`var.region` (TF), variáveis Jinja (GCP) em vez de literais |
| IAC-14 | GCP DNS/CDN/ApiGateway processam só parte das listas (perda de dados) | ⚪ Low | Medium | `deployment-manager.ts:465-468` só `records[0]`; `:427` só `origins[0]`; LB ignora `listeners` (:399-414) | Iterar todas as entradas (records, origins, listeners) como nos demais providers |

---

### 3.6 Segurança

**Estado:** postura mista. Fortes: segredos não versionados (`.env` coberto), templates `.env` vazios, providers AWS/Azure/GCP com criptografia ativa e senhas parametrizadas. Riscos: cadeia "IA → arquivo/comando → execução", senha plaintext no Terraform, SGs default `0.0.0.0/0`. As 23 vulns do `npm audit` são todas em dev/build, não em runtime.

> **Nota de verificação:** SEC-01 — `file-deleter` tem o mesmo padrão vulnerável mas `deleteFiles()` **não é chamado em nenhum fluxo de comando** (só re-exportado e exercitado em testes); a superfície ativa hoje é o `file-writer`. SEC-03 (senha) rebaixado high→medium aqui (synth só gera o arquivo, não aplica; `.tf` fica em `synth-out/` gitignorado), enquanto IAC-02 (providers) manteve high pela ótica de paridade — tratar como o **mesmo** trabalho de correção.

| ID | Título | Sev | Esforço | Evidência | Recomendação |
|---|---|---|---|---|---|
| SEC-01 | Path traversal em file-writer e file-deleter | 🟠 High | Low | `file-writer.ts:48-50` `path.join` sem containment; `file.path` cru (`code-extractor.ts:74-77`); `validator.ts:18` usa basename isolado; `file-deleter.ts:69,122-125` (código morto, não religado) | `path.resolve`+`startsWith(resolve(projectDir)+sep)`; aplicar em ambos + `validate()`. **(Cluster com ai-tools SEC-01/02, TS-01, RAG-09)** |
| SEC-02 | Código TS gerado pela IA executado via `require()`/ts-node no synth | 🟠 High | Medium | `synth.ts:86-106` registra ts-node e `require(stackPath)`; `.ts` escritos pela IA (`file-writer.ts:47-50`); sugerido automaticamente (`ai.ts:162-163`); sem sandbox/AST check | AST check rejeitando imports fora de `@iacmp/core` e `child_process`/`fs`/`eval`; ou synth em worker/VM isolado; no mínimo aviso explícito antes de executar |
| SEC-03 | Senha plaintext `changeme` no Terraform gerado | 🟡 Medium | Low | `hcl.ts:492,512`; diverge de CFN (SSM) e ARM (parameters) | `variable sensitive=true` ou `random_password`+Secrets Manager. **(Mesmo trabalho que IAC-02)** |
| SEC-04 | SG/NSG/Firewall default `0.0.0.0/0` quando CIDR omitido | 🟡 Medium | Low | `cloudformation.ts:311` `?? '0.0.0.0/0'`; `hcl.ts:290`; `deployment-manager.ts:315`; `arm.ts:322 ?? '*'`; egress allow-all | Exigir `cidr` explícito p/ ingress (erro de synth se ausente) ou defaultar p/ CIDR da VPC |
| SEC-05 | Dados externos não confiáveis (RSS/JSON) injetados no contexto da IA | 🟡 Medium | Medium | `live-retriever.ts:196,329,428` injeta texto parseado via `context-reader.ts:172-183`; parse só remove tags, não neutraliza instruções | Delimitar bloco como `<untrusted_data>` no prompt; truncar; reforçar no system-prompt; combinar com AST de SEC-02 |
| SEC-06 | `synth-runner`/`file-deleter` passam `provider` para shell em string | ⚪ Low | Low | `synth-runner.ts:6,15` interpola `${provider}`; `file-deleter.ts:104` interpola `${stackName}`/`${iacProvider}` | `execFileSync`/`spawn` com array de args. **(Cluster com SEC-03 de ai-tools)** |
| SEC-07 | Vulns de dependências concentradas em dev/build (npm audit: 23) | ⚪ Low | Medium | 1 high (`tmp <=0.2.5` via `@oclif/dev-cli`), 21 moderate (`js-yaml` via jest/ts-jest); nenhuma em runtime | `npm audit fix`; substituir `@oclif/dev-cli` por `@oclif/core`; atualizar stack jest/ts-jest |
| SEC-08 | Artefatos `.iacmp/` não cobertos pelo `.gitignore` do monorepo | ⚪ Low | Low | `session-store.ts:6`, `response-cache.ts:5`, `live-retriever.ts:4` gravam em `.iacmp/`; `git check-ignore` retorna exit 1; projetos do `init` protegidos (`init.ts:306`) | Adicionar `.iacmp/` ao `.gitignore` raiz. **(Cluster com SEC-04 de ai-tools, DX-05)** |

---

### 3.7 Testes

**Estado:** 273 casos em 19 arquivos, mas fortemente desbalanceado — `@iacmp/ai` concentra 229 testes enquanto **CLI, dashboard, plugin-sdk, registry e todo o subsistema de diagramas têm ZERO testes**. Sem CI, sem threshold de cobertura, sem snapshot/golden tests. Os bugs já corrigidos no synth não têm regressão protegendo-os.

| ID | Título | Sev | Esforço | Evidência | Recomendação |
|---|---|---|---|---|---|
| TEST-01 | CLI inteiro (3484 LOC, 17 comandos + 4 módulos de diagrama) sem nenhum teste | 🔴 Critical | High | `cli/package.json` sem `test`/`jest`; nenhum `*.test.ts` sob `cli/`; bugs BUG-05/16/17 vivem nesse código | Adicionar script+jest; priorizar diagramas (funções puras), synth (namespacing), e2e via `execa` (init→synth→assert) |
| TEST-05 | Sem CI e sem config/threshold de cobertura | 🟠 High | Low | Sem `.github/workflows`; grep `collectCoverage`/`coverageThreshold` vazio; `test` `dependsOn:[build]` aborta a run se `cli#build` falhar | Workflow GH Actions (`turbo run typecheck test` em PR); habilitar `collectCoverage`+threshold; `--passWithNoTests` nos packages sem teste. **(Cluster com DX-02)** |
| TEST-02 | Sem regressão para bugs já corrigidos (environment, DeletionPolicy, maxAzs) | 🟠 High | Low | `cloudformation.ts:543` (DeletionPolicy), `:674` (Environment.Variables), `:991-1043` (VPC children); `cloudformation.test.ts` não asserta nenhum | Converter cada bug do `TESTES.md` num teste de regressão (sintetizar e asserir o JSON) |
| TEST-03 | Paridade dos 4 providers não testada — 31 constructs, só 5-8 cobertos | 🟠 High | Medium | aws=8, azure=5 (sem Lambda/VPC), gcp=5, terraform=5; Kubernetes/Container/DynamoDB/LoadBalancer/IAM/etc. sem teste em nenhum | Matriz parametrizada: para cada construct, teste mínimo por provider (tipo de recurso + props-chave); fixtures compartilhados |
| TEST-04 | Testes da IA nunca exercitam o LLM nem o pipeline real | 🟡 Medium | High | `scenario-context.test.ts`/`chat-flow.test.ts` validam respostas fabricadas à mão; `anthropic.ts`/`copilot.ts` sem teste | Testes do provider com rede mockada (jest.mock SDK/fetch); testar `system-prompt`/`validator`; golden transcripts |
| TEST-06 | Tools de IO da IA (escrita/remoção/exec) sem teste | 🟡 Medium | Medium | Sem teste: `file-writer.ts` (54 LOC), `file-deleter.ts` (142 LOC), `synth-runner.ts`, `indexer.ts` (227), `contextualizer.ts` (90) | Testar em tmpdir (`mkdtempSync`): criação, sobrescrita, recusa de traversal, remoção só dos alvos; mockar `execSync` |
| TEST-07 | Testes de provider verificam implementação superficial, não validade do template | 🟡 Medium | Medium | Sem `toMatchSnapshot`/`__snapshots__`; assercões só checam `.Type`+1-2 props; `hcl.test.ts` usa `toContain` de substrings | Snapshot tests por construct/provider; validar contra schema/validador real (cfn-lint, hcl2json, `$schema` ARM) em smoke por provider |

---

### 3.8 Documentação

**Estado:** volumosa e bem escrita em pt-BR, mas com **desalinhamento sério com o código atual**. O onboarding básico (init/synth/comandos) é sólido e os comandos do README existem todos, mas docs de status estão congeladas, o RAG é invisível na doc de usuário, e há inconsistências de versão e ausência de arquivos básicos (LICENSE).

> **Nota de verificação:** vários achados foram rebaixados de high→medium porque são staleness de documentação (impacto = confusão pontual, não bloqueio funcional). DOC-01: `MVP-STATUS.md` é um snapshot histórico de fase encerrada, não a doc canônica. DOC-02: RAG não está totalmente ausente — `docs/estudo-rag.md` cobre parte; o path real do context-reader é `tools/context-reader.ts`.

| ID | Título | Sev | Esforço | Evidência | Recomendação |
|---|---|---|---|---|---|
| DOC-01 | `MVP-STATUS.md` desatualizado: "apenas AWS" + paths `/Users/cmelo/` | 🟡 Medium | Low | `:8` "6 comandos", `:37` "apenas AWS"; realidade 4 providers + 17 comandos; paths hardcoded `:15,27,30` | Atualizar ou remover apontando p/ changelog/README; paths relativos |
| DOC-02 | Módulo RAG/knowledge ausente da doc de usuário; arquitetura.md descreve fluxo antigo | 🟡 Medium | Medium | `rag/` e `knowledge/` implementados; README/manual/faq sem menção real; `arquitetura.md:96-113` descreve fluxo sem RAG | Seção RAG no manual/faq; atualizar `arquitetura.md` (query-router/retriever/live); mencionar no README |
| DOC-03 | `estudo-rag.md` framado como plano futuro quando o RAG já existe | 🟡 Medium | Low | `:1` "Plano de Implementação"; `:314` "Arquivos a criar"; `:281` fases futuras; arquivos já existem | Converter para "documentação de arquitetura do RAG (estado atual)" + seção "Próximos passos" |
| DOC-04 | Inconsistência de versão: `package.json` 1.0.0 vs changelog/manual 1.1.0 | 🟡 Medium | Low | Todos `1.0.0`; `changelog.md:5` `[1.1.0]`; `manual-de-uso.md:445` `v1.1.0`; `doctor.ts:38` reportaria 1.0.0 | Decidir versão real e alinhar package.json (todos), changelog e rodapé. **(Cluster com DX-07, ARCH-05)** |
| DOC-05 | README declara MIT mas não existe arquivo LICENSE | 🟡 Medium | Low | `README.md:184-186` + `cli/package.json` MIT; `ls LICENSE*` sem matches | Adicionar `LICENSE` (MIT, titular Caio Melo) na raiz. **(Cluster com DX-06)** |
| DOC-06 | README documenta só 5 dos 13 namespaces de constructs | 🟡 Medium | Medium | `core/src/index.ts` exporta 13 namespaces (:4-74); README (:97-111)/`constructs.md` só 5; subtipos não citados | Expandir `constructs.md` p/ 13 namespaces+subtipos; gerar referência a partir dos tipos |
| DOC-07 | Exemplo de "novo construct" em contribuindo.md não bate com o padrão real | 🟡 Medium | Low | `contribuindo.md:116-135` usa `extends BaseConstruct`/`Cache.Cluster`/`CacheOptions`; real usa `namespace`+`implements`+`*Props`+`stack.addConstruct(this)` | Reescrever (:110-144) com o padrão real, copiando de `cache.ts` |
| DOC-08 | Doc descreve `synth-out/` flat, mas synth grava em `synth-out/<provider>/` | 🟡 Medium | Low | `synth.ts:121-122`; `faq.md:51-55`, `manual-de-uso.md:91`, `providers.md:66` dizem flat | Atualizar faq/manual/providers p/ `synth-out/<provider>/<stack>.<ext>`. **(Cluster com CLI-01)** |
| DOC-09 | FAQ diz que synth usa ts-node "automaticamente"; código exige ts-node no projeto | 🟡 Medium | Low | `faq.md:7`; `synth.ts:87-104` só registra se `resolveTsNode()` achar; senão warn+skip; ts-node não é dep do CLI | Corrigir faq (ts-node deve estar no projeto) ou empacotar ts-node como dep. **(Cluster com CLI-02)** |
| DOC-10 | Modelo de IA documentado é inválido (`claude-sonnet-4-6`) | 🟡 Medium | Low | `changelog.md:103` reflete `anthropic.ts:19,41`; ID não é válido na Anthropic | Após corrigir o ID no código, atualizar changelog para o modelo válido |
| DOC-11 | Manual contradiz a si: doctor "iacmp ai disponível na Fase 3" vs Roadmap "Disponível" | ⚪ Low | Low | `manual-de-uso.md:290` ("disponível na Fase 3") vs `:438` ("Disponível"); `doctor.ts:51-57` não menciona Fase 3 | Trocar por "(necessário para iacmp ai)", alinhar com output real do doctor |
| DOC-12 | Índice de docs no README omite 3 arquivos; URLs/identidade inconsistentes | ⚪ Low | Low | README (:165-172) lista 7 de 10 docs; URL `seu-usuario/iacmp` vs `cmelo/iacmp`; author "Caio Melo" vs git "melocalex"; sem `CONTRIBUTING.md` na raiz | Completar índice; padronizar URL/author; `CONTRIBUTING.md` stub na raiz |

---

### 3.9 Build / DevEx / CI-CD

**Estado:** fundação razoável (build/typecheck/test orquestrados, lockfile commitado, `node>=20`, `packageManager` fixado), mas **maturidade de automação quase nula**: zero CI, sem linter/hooks, sem release automation. A **publicação npm documentada está quebrada na prática**.

| ID | Título | Sev | Esforço | Evidência | Recomendação |
|---|---|---|---|---|---|
| DX-01 | Publicação npm quebrada: deps internas `*` sem bundle nem inclusão no pacote | 🔴 Critical | High | `cli/package.json` deps `*` (:45-53); `files` (:32-36) sem `node_modules`; build só `tsc` (sem bundler); imports em runtime reais; `bin/run.js` instala hook `_resolveFilename` | (a) bundlar com tsup/esbuild (self-contained) ou (b) publicar todos `@iacmp/*` e trocar `*` por versões; smoke test `npm pack`+install em dir limpo. **(Cluster com ARCH-05)** |
| DX-02 | Ausência total de CI | 🟠 High | Medium | Sem `.github/`; changelog/manual descrevem CI gerado PARA o usuário, mas o próprio repo não tem | `.github/workflows/ci.yml`: matrix node 20.x, `npm ci`, `turbo run build typecheck test`; cache `.turbo`. **(Cluster com TEST-05)** |
| DX-03 | Sem linter/formatter (ESLint/Prettier/Biome) | 🟡 Medium | Medium | grep lint/eslint/prettier/biome vazio; `contribuindo.md` define convenções não impostas | Biome (ou ESLint+Prettier) + script `lint`/`format` no turbo + CI. **(Cluster com ARCH-08, TS-06)** |
| DX-04 | `oclif.manifest.json` listado em `files` mas nunca gerado (sem prepack) | 🟡 Medium | Low | `files` inclui `/oclif.manifest.json`; build `tsc`; script `manifest` separado sem hook; arquivo não existe no disco | `"prepack": "npm run build && npm run manifest"` (fallback runtime existe → não quebra, só degrada) |
| DX-05 | Artefato de teste em `tmp/` commitado e `.DS_Store` não ignorado | 🟡 Medium | Low | `git ls-files` mostra `tmp/test-init-compute/*`; `.DS_Store` untracked; `.gitignore` sem entradas | `.DS_Store`/`tmp/` no `.gitignore`; `git rm -r --cached tmp/`. **(Cluster com SEC-08)** |
| DX-06 | Ausência de LICENSE apesar de declarar MIT | 🟡 Medium | Low | `cli/package.json` MIT; sem `LICENSE*`; outros packages sem campo license | `LICENSE` (MIT) na raiz; incluir no `files`. **(Cluster com DOC-05)** |
| DX-07 | Sem release automation; changelog manual dessincronizado | ⚪ Low | Medium | Sem changesets/semantic-release; bump manual; 1.0.0 vs `[1.1.0]` no changelog | `@changesets/cli` ou script de sincronização via commits convencionais. **(Cluster com DOC-04)** |
| DX-08 | Sem pre-commit hooks (husky/lint-staged) | ⚪ Low | Low | Sem `.husky/`; sem husky/lint-staged | Após linter (DX-03): husky+lint-staged nos staged; ou hook pre-push `turbo run typecheck test` |
| DX-09 | Turbo `test` sem caching efetivo e cobertura ausente | ⚪ Low | Low | `test` `outputs:[]` + `dependsOn:[build]`; sem coverage; dashboard/plugin-sdk/registry/cli sem teste | `jest --coverage` + `outputs:["coverage/**"]` + inputs corretos. **(Cluster com ARCH-09)** |
| DX-10 | `.env` local com `ANTHROPIC_API_KEY` no working tree (não versionado) | ⚪ Low | Low | `.env` existe com chave real; `git ls-files`/`log` vazios; coberto por `*.env` | Manter fora do git; rotacionar chave se exposta; adicionar `.env.example` versionado |

---

### 3.10 Type-safety / Tratamento de erros

**Estado:** melhor que o esperado — `strict:true` herdado, zero `any` em produção, validador runtime robusto. Três fraquezas reais: tsconfig sem `noUncheckedIndexedAccess`, `BaseConstruct.props` como `Record<string,unknown>` (apaga tipos fortes → ~578 casts), e tratamento de erro inconsistente.

| ID | Título | Sev | Esforço | Evidência | Recomendação |
|---|---|---|---|---|---|
| TS-01 | file-writer/deleter gravam caminhos da IA sem validar containment | 🟠 High | Low | `file-writer.ts:16,30,48` `path.join`; `file.path` da IA sem validar; `file-deleter.ts` só `f.includes('stacks/')` (guard fraco) | `safeJoin` com `path.resolve`+`startsWith`; rejeitar `isAbsolute`; centralizar. **(Cluster com SEC-01)** |
| TS-02 | Props como `Record<string,unknown>` forçam ~578 casts não-checados | 🟡 Medium | High | `stack.ts:4`; `network.ts:105...` (35 `as unknown as` em core); casts por synth: CFN 184, HCL 167, DM 129, ARM 98 | `BaseConstruct<P>` genérico ou getter tipado; alternativa: helpers `getString/getNumber` validados |
| TS-03 | `JSON.parse` de configs do usuário sem try/catch — crash com stack cru | 🟡 Medium | Low | `deploy.ts:20,59`, `destroy.ts:40,60`, `synth.ts:37`, `watch.ts:27`, `diff.ts:113`, `dashboard.ts:10`, `registry/client.ts:20`; doctor já trata | Util `readJsonFile()` com try/catch + `this.error` amigável (pt-BR); aplicar nos ~9 sites |
| TS-05 | tsconfig sem `noUncheckedIndexedAccess` nem `exactOptionalPropertyTypes` | 🟡 Medium | Medium | `tsconfig.base.json` strict mas sem essas flags; `anthropic.ts:25` `content[0]`, `doctor.ts:25` `split('.')[0]`, `code-extractor.ts:24` `codeBlock[1]` | Habilitar `noUncheckedIndexedAccess` e corrigir acessos; avaliar `exactOptionalPropertyTypes`; incremental por package |
| TS-04 | 18 casts `(err as Error)` sem guard `instanceof Error` | ⚪ Low | Low | 18 ocorrências; 0 `instanceof Error` (audit-*/diff/ai/diagram/synth/loader/indexer) | Helper `errMessage(e:unknown)`; substituir os 18 casts |
| TS-06 | Ausência de ESLint — sem barreira contra any/floating promises/catch vazios | ⚪ Low | Medium | Sem `.eslintrc*`; 4 `catch {}` (doctor.ts:103,118; init.ts:512; dashboard.ts:105) | typescript-eslint (`no-explicit-any`, `no-floating-promises`, `no-empty` allowEmptyCatch:false) no turbo. **(Cluster com ARCH-08, DX-03)** |

---

## 4. Roadmap sugerido

### Onda 1 — Quick wins (effort low, alto retorno)
Correções de baixo esforço que destravam o produto e fecham a maior superfície de risco:

1. **CLI-01 / DOC-08** — Unificar a convenção `synth-out/<provider>/` nos consumidores. *Destrava o caminho feliz inteiro.*
2. **Cluster de segurança da IA** — `safeJoin` (`path.resolve`+`startsWith`, rejeitar `..`/absolutos) em file-writer/file-deleter (SEC-01/02, TS-01, RAG-09) + `execFileSync` com args validados (SEC-03/SEC-06).
3. **IAC-02 / SEC-03** — Substituir `changeme` por `variable sensitive`/`random_password`.
4. **IAC-01** — Função `hclString()` de escape.
5. **CLI-03** — `destroy` reusar `getResourceCount` por provider.
6. **TEST-02** — Testes de regressão para os bugs já corrigidos (environment, DeletionPolicy, maxAzs).
7. **Higiene de repo** — `.iacmp/`, `.DS_Store`, `tmp/` no `.gitignore` (SEC-08, DX-05); LICENSE MIT (DOC-05, DX-06); alinhar versão 1.1.0 (DOC-04).
8. **Doc staleness** — DOC-01, DOC-03, DOC-08, DOC-09, DOC-10 (fixes textuais).
9. **TS-03/TS-04** — Utils `readJsonFile()` e `errMessage()`.
10. **CLI-07** — Flag `--fail-on` nas auditorias para CI.

### Onda 2 — Curto prazo (effort medium / gates de qualidade)
Estabelecer a rede de segurança e fechar gaps funcionais:

1. **DX-02 / TEST-05** — CI no GitHub Actions (`turbo run typecheck test build` em PR) + cobertura com baseline.
2. **DX-03 / ARCH-08 / TS-06** — Linter+formatter (Biome ou ESLint+Prettier) na raiz + task no turbo.
3. **CLI-02 / DOC-09** — Helper compartilhado de ts-node reusado em `diff`; decidir empacotamento de ts-node.
4. **CLI-04** — Varredura recursiva em `diff`.
5. **RAG-01 / RAG-03** — Ligar o vector store (RRF) e o query-router ao fluxo real.
6. **RAG-02** — Normalização Unicode (NFD) no tokenizer + reindexação.
7. **SEC-02 / SEC-05** — AST check no synth + delimitação de dados não confiáveis no prompt.
8. **TEST-03 / TEST-06 / TEST-07** — Matriz de paridade dos providers + testes dos tools de IO + snapshot tests.
9. **DOC-02 / DOC-06 / DOC-07** — Documentar RAG, 13 namespaces, e corrigir o exemplo de novo construct.
10. **TS-05** — Habilitar `noUncheckedIndexedAccess` incrementalmente.
11. **IAC-04 a IAC-10** — Correções de paridade/correção dos synths (region GCP, lifecycle, NSG, props ignoradas, defaults inseguros, EC2 sem rede).

### Onda 3 — Estrutural / longo prazo (effort high)
Refatorações que reduzem o custo marginal de evolução:

1. **DX-01 / ARCH-05** — Resolver a publicação npm (bundler ou publicar `@iacmp/*` + versões reais) + smoke test.
2. **TEST-01** — Cobertura de testes do CLI (diagramas → synth → e2e via execa).
3. **ARCH-02** — Registro central de tipos de construct + `Map<type,handler>` nos synths (elimina os switches de 31 casos espelhados).
4. **ARCH-01** — Unificar o mecanismo de provider (`implements IacmpProvider` + registry único + `SynthArtifact`).
5. **ARCH-03** — Gerar a seção de API do system-prompt a partir do AST do core.
6. **ARCH-04** — TS project references/composite.
7. **TS-02** — `BaseConstruct<P>` genérico ou helpers de leitura validada.
8. **IAC-03** — Templates deployáveis (referências de rede reais com props obrigatórios validados).
9. **TEST-04** — Testes de contrato/golden transcripts da IA.
10. **DX-07** — Release automation (changesets).

---

## 5. Apêndice: metodologia e limitações

### Metodologia
- **Auditoria multi-agente em 10 dimensões:** arquitetura, AI/RAG, AI chat/tools, CLI, providers/synth, segurança, testes, documentação, build/DevEx/CI-CD, type-safety/erros.
- **Verificação adversarial:** cada achado passou por um passe de verificação independente que (a) confirmou ou refutou a evidência factual (file:line, greps, testes empíricos), (b) ajustou severidades, e (c) removeu achados não confirmados. As notas de verificação relevantes estão preservadas no início de cada dimensão e em achados específicos.
- **Priorização:** Top 10 ordenado por (severidade × impacto / esforço), com clusters de duplicatas tratados como um único trabalho de correção.

### Limitações e ressalvas
- **Severidades ajustadas pela verificação:** vários achados originalmente `critical`/`high` foram rebaixados quando a verificação encontrou mitigantes reais — notadamente a **confirmação interativa** antes de escrever/apagar arquivos e o fato de `path.join` **neutralizar paths absolutos** (o vetor de traversal real é apenas `..`, não `/etc/...` como algumas evidências originais afirmavam). Correções de evidência foram incorporadas no texto.
- **`deleteFiles()` é código morto hoje:** o `file-deleter` é vulnerável mas não está religado a nenhum fluxo de comando; a superfície ativa é o `file-writer`. A correção deve ser aplicada mesmo assim (defesa em profundidade) antes de qualquer religação.
- **Achados de paridade não exaustivos:** IAC-08 lista props ignoradas por amostragem; uma matriz prop×provider completa exigiria auditoria dedicada (recomendada).
- **Counts e LOC** refletem o estado do repositório na data da auditoria; pequenas divergências (ex.: "18 comandos" vs 17 reais) foram corrigidas onde a verificação detectou.
- **Não foram executados:** deploy real em nuvem, `terraform plan`/`cfn-lint` sobre os templates gerados, nem chamadas reais ao LLM — as conclusões sobre validade de template e comportamento da IA baseiam-se em análise estática e nos testes existentes.
- **Sem novos achados:** este relatório não introduz problemas além dos auditados e verificados; o escopo foi síntese, agrupamento e priorização.