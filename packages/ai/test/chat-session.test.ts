import { ChatSession } from '../src/chat/session';

describe('ChatSession — estado básico', () => {
  test('inicia vazia', () => {
    const s = new ChatSession();
    expect(s.getMessages()).toEqual([]);
  });

  test('addUserMessage adiciona mensagem user', () => {
    const s = new ChatSession();
    s.addUserMessage('oi');
    expect(s.getMessages()).toHaveLength(1);
    expect(s.getMessages()[0]).toEqual({ role: 'user', content: 'oi' });
  });

  test('addAssistantMessage adiciona mensagem assistant', () => {
    const s = new ChatSession();
    s.addAssistantMessage('resposta');
    expect(s.getMessages()[0]).toEqual({ role: 'assistant', content: 'resposta' });
  });

  test('getMessages retorna cópia — mutação externa não afeta o estado', () => {
    const s = new ChatSession();
    s.addUserMessage('oi');
    const msgs = s.getMessages();
    msgs.push({ role: 'user', content: 'intruso' });
    expect(s.getMessages()).toHaveLength(1);
  });

  test('sequência user+assistant+user+assistant', () => {
    const s = new ChatSession();
    s.addUserMessage('msg 1');
    s.addAssistantMessage('resp 1');
    s.addUserMessage('msg 2');
    s.addAssistantMessage('resp 2');
    const msgs = s.getMessages();
    expect(msgs).toHaveLength(4);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[2].role).toBe('user');
    expect(msgs[3].role).toBe('assistant');
  });
});

describe('ChatSession — removeLast', () => {
  test('remove a última mensagem', () => {
    const s = new ChatSession();
    s.addUserMessage('msg 1');
    s.addAssistantMessage('resp 1');
    s.addUserMessage('msg 2'); // sem resposta — simula erro na geração
    s.removeLast();
    expect(s.getMessages()).toHaveLength(2);
    expect(s.getMessages()[1].role).toBe('assistant');
  });

  test('não lança erro em sessão vazia', () => {
    const s = new ChatSession();
    expect(() => s.removeLast()).not.toThrow();
    expect(s.getMessages()).toEqual([]);
  });

  test('remove somente a última — não afeta o resto', () => {
    const s = new ChatSession();
    s.addUserMessage('a');
    s.addAssistantMessage('b');
    s.addUserMessage('c');
    s.removeLast();
    const msgs = s.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('a');
    expect(msgs[1].content).toBe('b');
  });

  test('após removeLast a sessão pode receber novas mensagens', () => {
    const s = new ChatSession();
    s.addUserMessage('original');
    s.removeLast();
    s.addUserMessage('nova');
    s.addAssistantMessage('resp nova');
    expect(s.getMessages()).toHaveLength(2);
    expect(s.getMessages()[0].content).toBe('nova');
  });
});

describe('ChatSession — clear', () => {
  test('limpa todas as mensagens', () => {
    const s = new ChatSession();
    s.addUserMessage('a');
    s.addAssistantMessage('b');
    s.clear();
    expect(s.getMessages()).toEqual([]);
  });

  test('após clear pode receber novas mensagens normalmente', () => {
    const s = new ChatSession();
    s.addUserMessage('a');
    s.clear();
    s.addUserMessage('b');
    s.addAssistantMessage('c');
    expect(s.getMessages()).toHaveLength(2);
  });
});

describe('ChatSession — compactAssistantHistory (poda do loop de correção)', () => {
  const bigGen = (v: string) => `{"explanation":"${v}","files":[{"path":"a.ts","content":"${'x'.repeat(500)}"}]}`;

  test('substitui gerações antigas por stub, mantém a última intacta', () => {
    const s = new ChatSession();
    s.addUserMessage('cria lambda');
    s.addAssistantMessage(bigGen('v1'));
    s.addUserMessage('corrija A');
    s.addAssistantMessage(bigGen('v2'));
    s.addUserMessage('corrija B');
    s.addAssistantMessage(bigGen('v3'));
    s.compactAssistantHistory(1);
    const msgs = s.getMessages();
    // v1 e v2 viram stub; v3 (última) intacta
    expect(msgs[1].content).toContain('_omitido');
    expect(msgs[3].content).toContain('_omitido');
    expect(msgs[5].content).toBe(bigGen('v3'));
    // o prompt original (user) nunca é tocado
    expect(msgs[0]).toEqual({ role: 'user', content: 'cria lambda' });
  });

  test('reduz o tamanho estimado do contexto', () => {
    const s = new ChatSession();
    s.addUserMessage('prompt');
    s.addAssistantMessage(bigGen('v1'));
    s.addUserMessage('corrija');
    s.addAssistantMessage(bigGen('v2'));
    const before = s.estimateTokens();
    s.compactAssistantHistory(1);
    expect(s.estimateTokens()).toBeLessThan(before);
  });

  test('idempotente — compactar duas vezes não muda nada', () => {
    const s = new ChatSession();
    s.addUserMessage('p');
    s.addAssistantMessage(bigGen('v1'));
    s.addUserMessage('c');
    s.addAssistantMessage(bigGen('v2'));
    s.compactAssistantHistory(1);
    const snapshot = JSON.stringify(s.getMessages());
    s.compactAssistantHistory(1);
    expect(JSON.stringify(s.getMessages())).toBe(snapshot);
  });
});

describe('ChatSession — cenários do fluxo do chat', () => {
  test('simula: geração bem-sucedida salva user+assistant', () => {
    const s = new ChatSession();
    s.addUserMessage('cria uma lambda');
    s.addAssistantMessage('{"explanation":"ok","files":[],"deletions":[],"nextSteps":[],"warnings":[]}');
    const msgs = s.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[msgs.length - 1].role).toBe('assistant');
  });

  test('simula: erro na geração — removeLast desfaz mensagem do usuário', () => {
    const s = new ChatSession();
    // sessão com histórico prévio
    s.addUserMessage('msg anterior');
    s.addAssistantMessage('{"explanation":"resp anterior","files":[],"deletions":[],"nextSteps":[],"warnings":[]}');
    // nova mensagem — modelo falhou
    s.addUserMessage('msg nova');
    s.removeLast(); // desfaz
    const msgs = s.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[msgs.length - 1].role).toBe('assistant');
  });

  test('simula: /limpar zera histórico da conversa', () => {
    const s = new ChatSession();
    s.addUserMessage('a');
    s.addAssistantMessage('b');
    s.addUserMessage('c');
    s.addAssistantMessage('d');
    s.clear();
    expect(s.getMessages()).toHaveLength(0);
  });

  test('simula: retry de TypeScript — user+assistant extras no histórico', () => {
    const s = new ChatSession();
    s.addUserMessage('cria lambda');
    s.addAssistantMessage('{"explanation":"v1","files":[{"path":"a.ts","content":"erro"}],"deletions":[],"nextSteps":[],"warnings":[]}');
    // retry automático de TS
    s.addUserMessage('Erros TypeScript:\nTS2345\n\nCorrija e retorne o JSON completo.');
    s.addAssistantMessage('{"explanation":"v2 corrigida","files":[{"path":"a.ts","content":"ok"}],"deletions":[],"nextSteps":[],"warnings":[]}');
    expect(s.getMessages()).toHaveLength(4);
    expect(s.getMessages()[3].role).toBe('assistant');
  });

  test('sessão carregada do disco restaura histórico completo', () => {
    const s = new ChatSession();
    const previous = [
      { role: 'user' as const, content: 'mensagem anterior' },
      { role: 'assistant' as const, content: '{"explanation":"anterior","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    for (const msg of previous) {
      if (msg.role === 'user') s.addUserMessage(msg.content);
      else s.addAssistantMessage(msg.content);
    }
    s.addUserMessage('nova mensagem');
    s.addAssistantMessage('{"explanation":"nova resposta","files":[],"deletions":[],"nextSteps":[],"warnings":[]}');
    expect(s.getMessages()).toHaveLength(4);
  });
});
