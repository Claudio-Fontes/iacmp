# Relatório de avaliação técnica e de segurança — iacmp

*Repositório avaliado:* Claudio-Fontes/iacmp  
*Commit avaliado:* 2d076d4aa9b45a2685f129135e1a16d4bb43d873  
*Data da avaliação:* 31/07/2026  
*Local do código clonado:* iacmp/  
*Escopo:* arquitetura, qualidade, testes, dependências, execução local, autenticação, autorização, segredos, Terraform state, segurança dos providers AWS/Azure/GCP e cadeia de fornecimento.

## 1. Resumo executivo

O iacmp tem uma proposta técnica relevante e uma base de engenharia acima da média para um projeto em evolução: monorepo organizado, separação clara entre core, CLI, runtime e providers, documentação extensa, testes por golden files e validações nativas de CloudFormation e Terraform.

Apesar desses pontos fortes, a versão avaliada *não deve ser considerada segura para produção* antes da correção dos bloqueadores descritos neste relatório. Os riscos mais importantes são:

1. configurações de autenticação podem resultar em endpoints públicos ou permitir acesso direto ao backend, contornando o gateway;
2. o fluxo de geração por IA constrói comandos de shell a partir de nomes de módulos provenientes de código gerado;
3. o provider GCP concede permissões amplas à service account padrão e não preserva corretamente a semântica de policies IAM;
4. há segredos determinísticos no Azure e states Terraform locais que podem armazenar dados sensíveis;
5. o script postinstall altera arquivos de inicialização do shell e pode substituir um comando existente no PATH;
6. a auditoria de segurança embutida é superficial e pode classificar recursos como seguros sem verificar controles essenciais.

Segurança absoluta não pode ser garantida apenas por revisão estática. A aprovação para produção deve depender da implementação das correções P0/P1, testes negativos de segurança e uma nova auditoria sobre os artefatos finais publicados.

## 2. Classificação geral

| Área | Avaliação | Observação |
|---|---|---|
| Arquitetura e organização | Boa | Separação de responsabilidades clara e providers isolados |
| Qualidade de compilação | Boa | Build e typecheck aprovados |
| Cobertura funcional | Boa, com ressalvas | Muitos testes e goldens; suíte completa não está totalmente verde |
| Autenticação e exposição de APIs | Crítica | Há caminhos de downgrade para público e bypass do gateway |
| Execução local e geração por IA | Crítica | Possibilidade de command injection e instalação não confiável |
| IAM e menor privilégio | Alta | Roles amplas e diferenças semânticas entre clouds |
| Segredos e Terraform state | Alta | Segredos determinísticos e state local com dados sensíveis |
| Cadeia de fornecimento | Média/alta | Dependências vulneráveis e componentes de build externos ao repositório |
| Prontidão para produção | Não aprovada | Corrigir P0/P1 antes de qualquer deploy produtivo |

## 3. Pontos fortes

### 3.1 Arquitetura modular

- O monorepo separa adequadamente core, CLI, runtime, dashboard, SDK de plugins, registry e providers.
- Os providers AWS, Azure, GCP e Terraform possuem responsabilidades explícitas e testes de isolamento.
- O fluxo de referências cross-stack está documentado e centralizado.
- A arquitetura permite adicionar providers sem acoplar diretamente um provider a outro.

### 3.2 Validações antecipadas

- Existem guards de synth-time para erros de referências, handlers inexistentes, SDK de cloud incorreto, dependências circulares e configurações incompatíveis.
- Erros de carregamento de stack são tratados como falha, evitando synth parcial silencioso.
- Há detecção de colisão entre nomes de stacks que produziriam o mesmo arquivo.
- O projeto valida diversos erros antes do deploy, reduzindo falhas tardias e custos desnecessários na cloud.

### 3.3 Testes e validação dos artefatos

- O projeto possui testes unitários, testes de providers e comparações por golden files.
- O CI executa build, typecheck e testes.
- Templates AWS selecionados são validados com cfn-lint.
- Artefatos Terraform AWS e GCP selecionados passam por terraform validate no CI.
- Os testes exercitam deploy, destroy, synth, diff, diagramas, auditorias e empacotamento de handlers.

### 3.4 Cuidados já presentes na execução de deploy

- A maior parte dos comandos de cloud utiliza execFileSync/spawn com argumentos separados, reduzindo risco de injeção de shell.
- Valores secretos usados no deploy Azure são mascarados em logs e no modo dry-run.
- Parâmetros secretos Azure são gravados em arquivo temporário com permissão 0600 e removidos no cleanup.
- O projeto oferece --dry-run e confirmações para operações destrutivas.
- Algumas rotinas tratam falhas transitórias e acompanham o estado de operações longas.

### 3.5 Alguns defaults de infraestrutura são seguros

- Storage Azure força HTTPS e TLS 1.2.
- Buckets são privados por padrão nos providers que implementam a propriedade corretamente.
- DynamoDB habilita point-in-time recovery por padrão.
- Redis AWS habilita criptografia em trânsito e em repouso por padrão.
- RDS/Aurora possuem suporte a criptografia, backup e deletion protection.
- Secrets temporários de deploy não são enviados em argumentos visíveis pelo ps.

### 3.6 Higiene do repositório

- .env, synth-out, states derivados e artefatos locais estão cobertos pelo .gitignore principal.
- Não foram encontradas assinaturas comuns de chaves AWS, tokens GitHub, chaves Anthropic/OpenAI ou chaves privadas no conteúdo atual ou na busca realizada no histórico Git.
- O projeto possui documentação em português e inglês, além de documentos de arquitetura e providers.

## 4. Achados críticos — P0

### P0-01 — Autenticação não é aplicada de forma consistente entre os providers

*Impacto:* acesso não autorizado a APIs e bypass de gateways/autorizadores.

O contrato público de Function.ApiGateway declara authType com valores NONE, JWT, AWS_IAM e COGNITO, mas os providers não preservam essa semântica de maneira uniforme.

Evidências:

- contrato: iacmp/packages/core/src/constructs/function.ts, linhas 35–55;
- AWS: iacmp/packages/providers/aws/src/synth/constructs/function.ts, linhas 223–236 e 375–392;
- Azure: iacmp/packages/providers/azure/src/synth/constructs/function.ts, linhas 231–239;
- Azure Function trigger anônimo: iacmp/packages/cli/src/deploy/azure/function-bundle.ts, linhas 138–157;
- GCP JWT com issuer/JWKS placeholder: iacmp/packages/providers/gcp/src/synth/constructs/function.ts, linhas 14–41;
- GCP concede roles/run.invoker a allUsers: iacmp/packages/providers/gcp/src/synth/constructs/function.ts, linhas 468–480.

Problemas confirmados:

- No AWS, authType sem um Lambda authorizer não impede a geração de AuthorizationType: NONE.
- No Azure, o código procura props.authorizer, propriedade ausente do contrato público, enquanto endpoints HTTP são empacotados com authLevel: anonymous.
- No GCP, toda Function HTTP sem event trigger recebe acesso público, mesmo quando usada atrás de um API Gateway autenticado.
- O GCP gera issuer e JWKS de exemplo, não uma configuração de identidade utilizável.
- Um usuário pode chamar diretamente o endpoint público do backend e evitar a política aplicada no gateway.

Correções recomendadas:

1. Substituir o contrato atual por uma configuração de autenticação explícita e validável, por exemplo:

   typescript
   auth: {
     type: 'jwt',
     issuer: 'https://issuer.example.com',
     audiences: ['api-audience'],
     jwksUri: 'https://issuer.example.com/.well-known/jwks.json'
   }
   

2. Falhar no synth quando o provider não puder implementar a semântica solicitada. Nunca fazer downgrade silencioso para NONE.
3. AWS:
   - implementar de fato AWS_IAM, Cognito e JWT onde suportados;
   - exigir authorizerLambdaId somente para authorizer customizado;
   - gerar testes que confirmem AuthorizationType para cada modalidade.
4. Azure:
   - não expor Function Apps diretamente de forma anônima quando estiverem atrás de APIM;
   - usar access restrictions/private endpoints, Easy Auth ou chave de Function mantida apenas pelo APIM;
   - corrigir o contrato para usar authType/auth real;
   - combinar CORS e validação JWT na mesma policy, em vez de usar branches mutuamente exclusivos.
5. GCP:
   - remover allUsers de Functions usadas como backend do Gateway;
   - conceder run.invoker somente à service account dedicada do Gateway;
   - exigir issuer, audience e JWKS reais antes do synth;
   - permitir endpoint público apenas com uma propriedade explícita como publicAccess: true.
6. Adicionar testes negativos end-to-end:
   - chamada sem token deve retornar 401/403;
   - token inválido deve ser rejeitado;
   - chamada direta ao backend deve falhar;
   - somente gateway/service account autorizada deve invocar o backend.

### P0-02 — Command injection e instalação de pacotes a partir de código gerado por IA

*Impacto:* execução arbitrária de comandos com os privilégios do usuário e comprometimento da máquina local.

Evidências:

- iacmp/packages/cli/src/generation/synth-validator.ts, linhas 28–52;
- iacmp/packages/cli/bin/chat.js, linhas 392 e 459;
- iacmp/packages/cli/src/bootstrap.ts, linha 119.

O fluxo extrai nomes de módulos de erros TypeScript e os concatena em comandos como:

typescript
execSync(`npm install ${modulesToInstall.join(' ')}`)


O conteúdo teve origem em código produzido por um modelo e não deve ser tratado como entrada confiável. Além da injeção direta por metacaracteres de shell, npm install pode executar scripts de lifecycle de pacotes maliciosos.

Correções recomendadas:

1. Eliminar execSync com string e usar argumentos separados:

   typescript
   execFileSync('npm', ['install', '--ignore-scripts', ...packages], options);
   

2. Validar nomes com uma gramática restrita para pacotes npm, rejeitando URLs, caminhos locais, aliases, opções iniciadas por - e metacaracteres.
3. Não instalar dependências automaticamente. Mostrar o plano e solicitar autorização explícita.
4. Manter uma allowlist por provider para SDKs conhecidos.
5. Executar a primeira instalação com --ignore-scripts; scripts necessários devem exigir aprovação separada.
6. Fixar versões no lockfile e mostrar ao usuário qualquer alteração de dependência.
7. Executar synth de código gerado em processo isolado, com permissões mínimas, sem credenciais cloud e sem acesso irrestrito ao filesystem/rede.
8. Considerar validação por AST em vez de carregar imediatamente o arquivo gerado com require().
9. Criar testes com nomes de módulos contendo espaços, opções, ;, &&, $(), caminhos e URLs, comprovando que todos são rejeitados.

## 5. Achados de prioridade alta — P1

### P1-01 — Service account GCP padrão recebe permissões excessivas

*Impacto:* comprometimento de uma Function ou build pode permitir acesso amplo a storage, secrets, Pub/Sub, monitoring e outros recursos do projeto.

Evidência: iacmp/packages/cli/src/deploy/gcp/preflight.ts, linhas 24–44 e 130–181.

O preflight concede roles amplas à default compute service account e usa a mesma identidade para build e runtime.

Correções recomendadas:

- criar service accounts distintas para build, deploy, gateway e cada workload;
- conceder apenas roles exigidas pelos constructs realmente presentes;
- preferir bindings no recurso, não no projeto inteiro;
- nunca alterar IAM automaticamente sem exibir um plano e solicitar confirmação;
- permitir uma opção de somente diagnóstico que liste permissões faltantes;
- remover roles/pubsub.editor, roles/storage.objectAdmin e roles/monitoring.editor como defaults globais;
- adicionar IAM Conditions quando aplicável.

### P1-02 — Tradução de IAM para GCP perde escopo e pode transformar Deny em concessão

*Impacto:* uma policy aparentemente restritiva pode produzir mais privilégios que o solicitado.

Evidência: iacmp/packages/providers/gcp/src/synth/constructs/function.ts, linhas 291–357 e 615–649.

O mapeamento converte actions AWS em roles agregadas GCP no projeto inteiro, ignora resources e não preserva Deny. Actions desconhecidas recebem roles/viewer.

Correções recomendadas:

- falhar explicitamente para Deny, actions desconhecidas ou semânticas que não possam ser preservadas;
- nunca converter Deny em role concedida;
- modelar autorização de forma agnóstica por capacidades, não reutilizar diretamente actions AWS em todas as clouds;
- gerar bindings por recurso quando o serviço permitir;
- emitir relatório de perda semântica e exigir aceite explícito antes do deploy;
- adicionar testes comparativos de menor privilégio entre AWS, Azure e GCP.

### P1-03 — Secrets Azure determinísticos e proteção insuficiente do Key Vault

*Impacto:* segredo previsível, dificuldade de recuperação após exclusão e risco para tokens/JWT que dependam desse valor.

Evidência: iacmp/packages/providers/azure/src/synth/constructs/policy.ts, linhas 86–94.

O valor do secret é derivado de uniqueString, que é determinístico, e o vault é criado com enableSoftDelete: false.

Correções recomendadas:

- gerar o segredo com um gerador criptograficamente seguro fora do template;
- transportar o valor como parâmetro @secure() ou integrá-lo a um gerenciador seguro;
- habilitar soft-delete e purge protection;
- implementar rotação real e expiração;
- não retornar secret value em outputs;
- validar políticas de acesso e rede do Key Vault;
- adicionar teste que comprove que duas recriações não produzem o mesmo segredo.

### P1-04 — Terraform state local pode conter segredos e é ponto único de falha

*Impacto:* exposição local de credenciais, perda de controle da infraestrutura, corrida entre operadores e impossibilidade de recuperação consistente.

Evidências:

- iacmp/packages/cli/src/deploy/terraform.ts, linhas 21–42;
- iacmp/packages/cli/src/deploy/gcp/index.ts, linhas 128–155;
- secret GCP persistido via Terraform: iacmp/packages/providers/gcp/src/synth/constructs/database.ts, linhas 166–184.

Correções recomendadas:

- suportar backends remotos criptografados com locking para AWS, Azure e GCP;
- separar state por projeto, ambiente, conta/subscription/project e região;
- bloquear deploy produtivo com backend local, salvo override explícito;
- orientar migração de state e backup;
- evitar secret material em state quando possível;
- restringir permissões de qualquer state local e alertar quando ele contiver campos sensíveis;
- não depender de synth-out/terraform.tfstate como fonte durável de verdade;
- preservar e verificar .terraform.lock.hcl por ambiente para builds reproduzíveis.

### P1-05 — postinstall modifica o shell e pode substituir comandos existentes

*Impacto:* alteração inesperada da máquina do usuário, perda de executável legítimo e aumento do impacto de um ataque de supply chain.

Evidência: iacmp/packages/cli/scripts/postinstall.js, especialmente linhas 62–98.

Correções recomendadas:

- remover toda alteração automática de .zprofile, .zshrc, .bash_profile e .bashrc;
- nunca executar unlinkSync sobre um destino existente sem verificar propriedade/origem;
- deixar a criação do binário para o mecanismo padrão do npm;
- oferecer um comando explícito e reversível, como iacmp setup-path;
- mostrar diff e pedir confirmação antes de alterar configuração do shell;
- criar backup e instruções de rollback caso uma alteração seja autorizada;
- manter o postinstall informativo e sem mutações do sistema.

### P1-06 — Regras de rede e roles padrão falham de forma permissiva

*Impacto:* serviços expostos à internet ou permissões wildcard quando uma configuração está incompleta.

Evidências:

- security group AWS sem CIDR usa 0.0.0.0/0: iacmp/packages/providers/aws/src/synth/constructs/network.ts, linhas 182–220;
- regra equivalente no GCP: iacmp/packages/providers/gcp/src/synth/constructs/network.ts, linhas 125–171;
- roles automáticas AWS com Resource: '*': iacmp/packages/providers/aws/src/synth/resolvers.ts, linhas 269–286;
- Step Functions com permissions e iam:PassRole em Resource: '*': iacmp/packages/providers/aws/src/synth/constructs/workflow.ts, linhas 78–99.

Correções recomendadas:

- rejeitar ingress sem CIDR ou source security group;
- exigir opt-in explícito para 0.0.0.0/0 e ::/0;
- impedir iam:PassRole com wildcard;
- resolver ARNs cross-stack para gerar policies específicas;
- transformar warnings de menor privilégio em erros no profile de produção;
- oferecer profiles development e production, sendo o segundo fail-closed.

## 6. Melhorias importantes — P2

### P2-01 — Ampliar a auditoria de segurança embutida

Evidência: iacmp/packages/cli/src/commands/audit-security.ts, linhas 25–118.

A auditoria atual verifica poucos atributos de cinco tipos de construct e marca os demais como “OK”. Isso pode transmitir uma garantia indevida.

Correções recomendadas:

- auditar os artefatos finais CloudFormation/Bicep/Terraform, não apenas os constructs de entrada;
- verificar autenticação, endpoints diretos, IAM wildcard, PassRole, CORS, TLS, criptografia, logging, WAF, backups, deletion protection, secrets, state e exposição de rede;
- nunca imprimir “OK” para controles que não foram efetivamente analisados;
- diferenciar PASS, FAIL, NOT_APPLICABLE e NOT_CHECKED;
- adicionar fixtures inseguras para cada regra;
- usar --fail-on=critical como padrão em CI;
- exportar resultados em SARIF/JSON para integração com pipelines.

### P2-02 — Tornar o build reproduzível e auditável

Evidência: iacmp/packages/cli/tsup.config.ts, linhas 38–87.

O build pode incorporar MCP a partir de um checkout irmão (../../../iacmp-mcp) que não faz parte deste repositório. Os módulos Pro também são externos.

Correções recomendadas:

- publicar MCP/Pro como dependências versionadas e verificáveis ou incluir o código necessário no repositório correspondente;
- fixar versão e integridade dos componentes incorporados;
- garantir que um checkout limpo produza o mesmo artefato publicado;
- gerar SBOM e provenance assinada;
- comparar o tarball npm publicado com um build reproduzido no CI;
- documentar explicitamente quais partes não são open source e qual é a fronteira de confiança.

### P2-03 — Fortalecer a cadeia de fornecimento

Correções recomendadas:

- adicionar SECURITY.md com canal de divulgação responsável e SLAs;
- automatizar atualizações de dependências;
- executar análise estática, secret scanning e análise de IaC no CI;
- fixar GitHub Actions por commit SHA;
- fixar versões de ferramentas Python/Terraform usadas no CI;
- proteger publicação npm com ambiente restrito, aprovação e identidade federada;
- assinar releases e gerar checksums;
- revisar e minimizar dependências de desenvolvimento Oclif antigas.

### P2-04 — Corrigir vulnerabilidades de dependências

Resultado do npm audit no momento da avaliação:

- total: 13 vulnerabilidades;
- 2 altas;
- 8 moderadas;
- 3 baixas;
- dependências de produção: 7 moderadas e 1 baixa, sem altas/críticas.

Pacotes/cadeias relevantes incluem @google-cloud/firestore, @google-cloud/storage, google-gax, retry-request, teeny-request, uuid, esbuild, brace-expansion, tmp e dependências Oclif antigas.

Correções recomendadas:

- atualizar SDKs Google e validar breaking changes em branch separada;
- atualizar esbuild para versão fora do advisory identificado;
- remover ou substituir @oclif/dev-cli antigo;
- atualizar dependências que trazem tmp, glob e brace-expansion vulneráveis;
- manter auditorias separadas para produção e desenvolvimento;
- não aplicar npm audit fix --force sem revisão dos impactos semânticos.

### P2-05 — Restringir o dashboard local

Evidências:

- iacmp/packages/dashboard/src/index.ts, linhas 5–11;
- iacmp/packages/dashboard/src/server.ts, linhas 4–14.

O servidor usa listen(port) sem host explícito e não implementa autenticação nem headers defensivos.

Correções recomendadas:

- bind padrão em 127.0.0.1 e ::1;
- exigir flag explícita para escutar na rede;
- usar token aleatório quando exposto fora de loopback;
- adicionar CSP, X-Content-Type-Options, Referrer-Policy e proteção contra framing;
- responder 404 para rotas desconhecidas;
- documentar que o dashboard mostra metadados de infraestrutura.

### P2-06 — Melhorar estabilidade e compatibilidade dos testes

O teste isolado longrunning.test.ts aprovou 13 de 15 casos. Os dois casos de startup usam timeout fixo de 3 segundos, enquanto o carregamento do CLI neste ambiente levou aproximadamente 2,5–3,5 segundos.

Correções recomendadas:

- aguardar uma mensagem/porta pronta em vez de usar timeout temporal rígido;
- aumentar o limite somente como proteção final;
- executar a matriz com Node 20, 22 e 24, ou restringir corretamente engines se versões novas não forem suportadas;
- configurar Jest para não depender de Watchman em CI/sandbox;
- atualizar a configuração depreciada do ts-jest;
- adicionar testes reais ao pacote runtime, que atualmente aceita ausência de testes;
- garantir encerramento e cleanup de processos long-running para evitar suíte pendurada.

## 7. Plano de correção sugerido

### Fase 1 — Bloquear exposição e execução arbitrária

1. Corrigir o contrato de autenticação e impedir downgrade para público.
2. Fechar backends Azure/GCP contra acesso direto.
3. Remover allUsers das Functions protegidas.
4. Eliminar comandos de shell construídos a partir da saída da IA.
5. Desabilitar instalação automática de dependências sem confirmação.
6. Adicionar testes de bypass e command injection.

*Critério de saída:* nenhuma API declarada como protegida pode ser invocada sem credencial válida, inclusive pela URL direta do backend; nenhuma saída da IA pode virar comando de shell.

### Fase 2 — Menor privilégio e proteção de segredos

1. Separar service accounts GCP por função.
2. Remover roles project-wide automáticas.
3. Falhar em traduções IAM sem equivalência segura.
4. Corrigir geração e proteção de secrets Azure.
5. Implementar backend remoto/locking para Terraform.
6. Remover defaults wildcard e fail-open de rede.

*Critério de saída:* policies geradas passam por revisão automatizada de menor privilégio e nenhum segredo depende de valor determinístico ou state local desprotegido.

### Fase 3 — Supply chain e auditoria contínua

1. Remover mutações do postinstall.
2. Atualizar dependências vulneráveis/depreciadas.
3. Tornar builds reproduzíveis.
4. Adicionar política de segurança, SBOM, provenance e scans no CI.
5. Reescrever audit-security para analisar os templates finais.
6. Executar matriz de Node e estabilizar testes long-running.

*Critério de saída:* build reproduzível a partir de checkout limpo, auditoria sem vulnerabilidades altas/críticas conhecidas e suíte completa verde.

## 8. Checklist mínimo para aprovação de produção

- [ ] P0-01 corrigido e validado por testes negativos end-to-end.
- [ ] P0-02 corrigido e validado contra payloads de command injection.
- [ ] Nenhum backend protegido pode ser acessado diretamente.
- [ ] Nenhuma Function protegida possui binding público allUsers.
- [ ] IAM GCP usa identidades dedicadas e menor privilégio.
- [ ] Statements Deny ou semânticas não suportadas falham no synth.
- [ ] Secrets Azure são aleatórios, rotacionáveis e protegidos contra purge.
- [ ] Terraform usa backend remoto criptografado e locking.
- [ ] postinstall não altera shell nem remove executáveis.
- [ ] Security groups incompletos falham fechados.
- [ ] Auditoria examina artefatos finais e não produz “OK” sem cobertura.
- [ ] npm audit --omit=dev sem vulnerabilidades altas/críticas.
- [ ] Build reproduzível e artefatos publicados verificáveis.
- [ ] Suíte completa verde nas versões Node suportadas.
- [ ] Revisão de segurança repetida após as correções.

## 9. Verificações executadas

| Verificação | Resultado |
|---|---|
| Clone e inspeção do commit | Concluído |
| Inventário de arquitetura e dependências | Concluído |
| Busca de padrões comuns de secrets no tree/histórico | Nenhum encontrado |
| Instalação com npm ci --ignore-scripts | Aprovada |
| npm run typecheck | Aprovado |
| npm run build | 10/10 pacotes aprovados |
| Testes de core | 67 aprovados |
| Testes de dashboard | 9 aprovados |
| Testes de plugin SDK | 10 aprovados |
| Testes do provider AWS | 208 aprovados |
| Testes do provider Azure | 187 aprovados |
| Testes do provider GCP | 36 aprovados |
| Testes do provider Terraform | 17 aprovados |
| Runtime | Nenhum teste encontrado; comando configurado com --passWithNoTests |
| Teste isolado long-running | 13 aprovados, 2 falharam por startup/timeout |
| npm audit completo | 13 vulnerabilidades |
| npm audit --omit=dev | 8 vulnerabilidades de produção, sem alta/crítica |

## 10. Limitações desta avaliação

- Não foram executados deploys reais em contas AWS, Azure ou GCP.
- Os componentes privados @iacmp/ai, @iacmp/knowledge e o source externo do MCP não estavam disponíveis para revisão completa.
- Não foi realizada análise dinâmica contra ambientes cloud produtivos.
- A ausência de assinatura conhecida de segredo não comprova que nunca houve exposição por outros formatos.
- Dependências e advisories podem mudar após a data deste relatório.
- Nenhuma correção foi aplicada ao código-fonte durante esta avaliação.

## 11. Conclusão

O iacmp possui fundamentos fortes de arquitetura, documentação e testes, mas atualmente mistura abstrações multi-cloud com comportamentos de segurança que não são semanticamente equivalentes. O principal risco é o usuário declarar autenticação ou menor privilégio e receber um artefato final mais permissivo do que o solicitado.

A recomendação é manter o projeto restrito a laboratório/desenvolvimento até a conclusão das fases 1 e 2. Após essas correções, deve ser feita uma nova auditoria focada nos templates sintetizados, nos pacotes publicados e em testes de bypass reais nas três clouds.