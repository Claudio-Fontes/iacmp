import { Language } from './languages';

export interface Messages {
  chat: {
    bannerTitle: string;
    bannerCommands: string;
    prompt: string;
    sessionDiscarded: string;
    sessionLoaded: (count: number) => string;
    sessionCleared: string;
    exiting: string;
    generating: string;
    cachedResponse: string;
    errorPrefix: string;
    messageNotSaved: string;
    validationFailedRetrying: string;
    retryError: string;
    configureKey: string;
    langUsage: string;
    langInvalid: (valid: string) => string;
    langChanged: (lang: string) => string;
    voice: {
      recording: string;
      empty: string;
      said: (lang: string, text: string) => string;
      confirmPrompt: string;
      soxMissing: string;
      modelMissing: string;
      binMissing: string;
      transcribeError: (msg: string) => string;
    };
  };
  renderer: {
    thinking: string;
    explanationHeader: string;
    warningsHeader: string;
    nextStepsHeader: string;
  };
  diff: {
    newLabel: string;
    modifiedLabel: string;
    applyPrompt: string;
    modifiedCount: (n: number) => string;
    newCount: (n: number) => string;
  };
  fileWriter: {
    dryRunHeader: string;
    dryRunFooter: string;
    operationCancelled: string;
  };
  fileDeleter: {
    noFilesFound: string;
    filesToRemove: string;
    runDestroyPrompt: string;
    runningDestroy: (name: string) => string;
    destroySkipped: (msg: string, name: string) => string;
    destroyFailed: (name: string) => string;
    confirmDeleteLocal: string;
    deletionCancelled: string;
    couldNotRemove: (rel: string) => string;
    referencesRemoved: (file: string) => string;
    ignoring: (msg: string, file: string) => string;
  };
}

export const MESSAGES: Record<Language, Messages> = {
  pt: {
    chat: {
      bannerTitle: '\niacmp ai — Modo Chat Interativo',
      bannerCommands:
        'Comandos: /sair, /quit — encerra | /limpar — limpa sessão e cache | /voz — grava um áudio e transcreve | /lang pt|en|es — troca idioma da interface\n',
      prompt: '> Você: ',
      sessionDiscarded: '\n  Sessão anterior descartada (contexto desatualizado)',
      sessionLoaded: count => `\n  Sessão anterior carregada (${count} mensagens)`,
      sessionCleared: 'Sessão e cache limpos.\n',
      exiting: '\nEncerrando chat.',
      generating: 'Gerando...\n',
      cachedResponse: '  ↩ resposta do cache\n',
      errorPrefix: 'Erro: ',
      messageNotSaved: 'Sua mensagem não foi salva na sessão — pode repetir o pedido.\n',
      validationFailedRetrying: 'Validação falhou — corrigindo...\n',
      retryError: 'Erro no retry: ',
      configureKey: 'Configure ANTHROPIC_API_KEY no .env do projeto',
      langUsage: 'Uso: /lang pt|en|es',
      langInvalid: valid => `Idioma inválido. Use um de: ${valid}`,
      langChanged: lang => `Idioma da interface alterado para: ${lang}`,
      voice: {
        recording: 'gravando... pressione Enter para parar\n',
        empty: 'Não entendi, tente novamente.\n',
        said: (lang, text) => `Você disse (${lang}): ${text}`,
        confirmPrompt: '[Enter] usar, /voz regravar, ou digite para corrigir: ',
        soxMissing:
          'sox não encontrado no PATH. Instale com: brew install sox (macOS) ou apt install sox (Linux).',
        modelMissing:
          'IACMP_WHISPER_MODEL não configurado. Defina no .env o caminho do modelo ggml do whisper.cpp.',
        binMissing:
          'Binário whisper.cpp não encontrado. Configure IACMP_WHISPER_BIN ou instale whisper-cli no PATH.',
        transcribeError: msg => `Erro na transcrição: ${msg}`,
      },
    },
    renderer: {
      thinking: 'Gerando stack...',
      explanationHeader: '─── Explicação ─────────────────────────────────',
      warningsHeader: 'Avisos:',
      nextStepsHeader: 'Próximos passos:',
    },
    diff: {
      newLabel: '[novo]',
      modifiedLabel: '[modificado]',
      applyPrompt: 'Aplicar mudanças? [y/n] ',
      modifiedCount: n => `${n} modificado(s)`,
      newCount: n => `${n} novo(s)`,
    },
    fileWriter: {
      dryRunHeader: '\n[dry-run] Arquivos que seriam gerados:\n',
      dryRunFooter: '[dry-run] Nenhum arquivo foi salvo.\n',
      operationCancelled: '\n  Operação cancelada. Nenhum arquivo foi alterado.\n',
    },
    fileDeleter: {
      noFilesFound: '\n  Nenhum arquivo encontrado para remover.\n',
      filesToRemove: '  Arquivos que serão removidos:',
      runDestroyPrompt:
        'Rodar `iacmp destroy` para remover os recursos na nuvem antes de apagar? [y/n] ',
      runningDestroy: name => `\n  Rodando destroy para ${name}...`,
      destroySkipped: (msg, name) => `  ! ${msg} — pulando destroy de ${name}`,
      destroyFailed: name => `  ! destroy falhou para ${name} — continuando com remoção local`,
      confirmDeleteLocal: '\nApagar arquivos locais? [y/n] ',
      deletionCancelled: '  Remoção cancelada.\n',
      couldNotRemove: rel => `  ! Não foi possível remover: ${rel}`,
      referencesRemoved: file => `  ~ referências removidas em: ${file}`,
      ignoring: (msg, file) => `  ! ${msg} — ignorando ${file}`,
    },
  },
  en: {
    chat: {
      bannerTitle: '\niacmp ai — Interactive Chat Mode',
      bannerCommands:
        'Commands: /sair, /quit — exit | /limpar — clear session and cache | /voz — record audio and transcribe | /lang pt|en|es — change interface language\n',
      prompt: '> You: ',
      sessionDiscarded: '\n  Previous session discarded (outdated context)',
      sessionLoaded: count => `\n  Previous session loaded (${count} messages)`,
      sessionCleared: 'Session and cache cleared.\n',
      exiting: '\nEnding chat.',
      generating: 'Generating...\n',
      cachedResponse: '  ↩ cached response\n',
      errorPrefix: 'Error: ',
      messageNotSaved: 'Your message was not saved in the session — you can repeat the request.\n',
      validationFailedRetrying: 'Validation failed — fixing...\n',
      retryError: 'Retry error: ',
      configureKey: 'Set ANTHROPIC_API_KEY in the project .env',
      langUsage: 'Usage: /lang pt|en|es',
      langInvalid: valid => `Invalid language. Use one of: ${valid}`,
      langChanged: lang => `Interface language changed to: ${lang}`,
      voice: {
        recording: 'recording... press Enter to stop\n',
        empty: "Didn't catch that, please try again.\n",
        said: (lang, text) => `You said (${lang}): ${text}`,
        confirmPrompt: '[Enter] use it, /voz to re-record, or type to correct: ',
        soxMissing:
          'sox not found in PATH. Install it with: brew install sox (macOS) or apt install sox (Linux).',
        modelMissing:
          'IACMP_WHISPER_MODEL is not set. Set the path to the whisper.cpp ggml model in .env.',
        binMissing:
          'whisper.cpp binary not found. Set IACMP_WHISPER_BIN or install whisper-cli in PATH.',
        transcribeError: msg => `Transcription error: ${msg}`,
      },
    },
    renderer: {
      thinking: 'Generating stack...',
      explanationHeader: '─── Explanation ─────────────────────────────────',
      warningsHeader: 'Warnings:',
      nextStepsHeader: 'Next steps:',
    },
    diff: {
      newLabel: '[new]',
      modifiedLabel: '[modified]',
      applyPrompt: 'Apply changes? [y/n] ',
      modifiedCount: n => `${n} modified`,
      newCount: n => `${n} new`,
    },
    fileWriter: {
      dryRunHeader: '\n[dry-run] Files that would be generated:\n',
      dryRunFooter: '[dry-run] No files were saved.\n',
      operationCancelled: '\n  Operation cancelled. No files were changed.\n',
    },
    fileDeleter: {
      noFilesFound: '\n  No files found to remove.\n',
      filesToRemove: '  Files that will be removed:',
      runDestroyPrompt:
        'Run `iacmp destroy` to remove the cloud resources before deleting? [y/n] ',
      runningDestroy: name => `\n  Running destroy for ${name}...`,
      destroySkipped: (msg, name) => `  ! ${msg} — skipping destroy for ${name}`,
      destroyFailed: name => `  ! destroy failed for ${name} — continuing with local removal`,
      confirmDeleteLocal: '\nDelete local files? [y/n] ',
      deletionCancelled: '  Deletion cancelled.\n',
      couldNotRemove: rel => `  ! Could not remove: ${rel}`,
      referencesRemoved: file => `  ~ references removed in: ${file}`,
      ignoring: (msg, file) => `  ! ${msg} — skipping ${file}`,
    },
  },
  es: {
    chat: {
      bannerTitle: '\niacmp ai — Modo Chat Interactivo',
      bannerCommands:
        'Comandos: /sair, /quit — salir | /limpar — limpia sesión y caché | /voz — graba un audio y transcribe | /lang pt|en|es — cambia el idioma de la interfaz\n',
      prompt: '> Tú: ',
      sessionDiscarded: '\n  Sesión anterior descartada (contexto desactualizado)',
      sessionLoaded: count => `\n  Sesión anterior cargada (${count} mensajes)`,
      sessionCleared: 'Sesión y caché borrados.\n',
      exiting: '\nFinalizando chat.',
      generating: 'Generando...\n',
      cachedResponse: '  ↩ respuesta en caché\n',
      errorPrefix: 'Error: ',
      messageNotSaved: 'Tu mensaje no se guardó en la sesión — puedes repetir la solicitud.\n',
      validationFailedRetrying: 'Validación falló — corrigiendo...\n',
      retryError: 'Error en el reintento: ',
      configureKey: 'Configura ANTHROPIC_API_KEY en el .env del proyecto',
      langUsage: 'Uso: /lang pt|en|es',
      langInvalid: valid => `Idioma inválido. Usa uno de: ${valid}`,
      langChanged: lang => `Idioma de la interfaz cambiado a: ${lang}`,
      voice: {
        recording: 'grabando... presiona Enter para detener\n',
        empty: 'No entendí, intenta de nuevo.\n',
        said: (lang, text) => `Dijiste (${lang}): ${text}`,
        confirmPrompt: '[Enter] usar, /voz para regrabar, o escribe para corregir: ',
        soxMissing:
          'sox no encontrado en el PATH. Instálalo con: brew install sox (macOS) o apt install sox (Linux).',
        modelMissing:
          'IACMP_WHISPER_MODEL no está configurado. Define en el .env la ruta del modelo ggml de whisper.cpp.',
        binMissing:
          'Binario de whisper.cpp no encontrado. Configura IACMP_WHISPER_BIN o instala whisper-cli en el PATH.',
        transcribeError: msg => `Error de transcripción: ${msg}`,
      },
    },
    renderer: {
      thinking: 'Generando stack...',
      explanationHeader: '─── Explicación ─────────────────────────────────',
      warningsHeader: 'Avisos:',
      nextStepsHeader: 'Próximos pasos:',
    },
    diff: {
      newLabel: '[nuevo]',
      modifiedLabel: '[modificado]',
      applyPrompt: '¿Aplicar cambios? [y/n] ',
      modifiedCount: n => `${n} modificado(s)`,
      newCount: n => `${n} nuevo(s)`,
    },
    fileWriter: {
      dryRunHeader: '\n[dry-run] Archivos que se generarían:\n',
      dryRunFooter: '[dry-run] No se guardó ningún archivo.\n',
      operationCancelled: '\n  Operación cancelada. Ningún archivo fue modificado.\n',
    },
    fileDeleter: {
      noFilesFound: '\n  No se encontraron archivos para eliminar.\n',
      filesToRemove: '  Archivos que serán eliminados:',
      runDestroyPrompt:
        '¿Ejecutar `iacmp destroy` para eliminar los recursos en la nube antes de borrar? [y/n] ',
      runningDestroy: name => `\n  Ejecutando destroy para ${name}...`,
      destroySkipped: (msg, name) => `  ! ${msg} — omitiendo destroy de ${name}`,
      destroyFailed: name => `  ! destroy falló para ${name} — continuando con la eliminación local`,
      confirmDeleteLocal: '\n¿Borrar archivos locales? [y/n] ',
      deletionCancelled: '  Eliminación cancelada.\n',
      couldNotRemove: rel => `  ! No se pudo eliminar: ${rel}`,
      referencesRemoved: file => `  ~ referencias eliminadas en: ${file}`,
      ignoring: (msg, file) => `  ! ${msg} — omitiendo ${file}`,
    },
  },
};
