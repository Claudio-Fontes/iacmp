import { withRetry } from '../src/providers/retry';

function errWithStatus(status: number): Error {
  return Object.assign(new Error(`erro ${status}`), { status });
}

function errWithCode(code: string): Error {
  return Object.assign(new Error(`erro ${code}`), { code });
}

describe('withRetry', () => {
  test('retorna o resultado direto quando não há erro', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('tenta novamente em erro 500 e eventualmente resolve', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(errWithStatus(500))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, 3);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('tenta novamente em erro 429 (rate limit)', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(errWithStatus(429))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, 3);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('tenta novamente em ECONNRESET', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(errWithCode('ECONNRESET'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, 3);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('tenta novamente em ERR_STREAM_PREMATURE_CLOSE (conexão de stream encerrada antes do fim)', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(errWithCode('ERR_STREAM_PREMATURE_CLOSE'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, 3);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('desiste após esgotar as tentativas e propaga o último erro', async () => {
    const fn = jest.fn().mockRejectedValue(errWithStatus(500));
    await expect(withRetry(fn, 3)).rejects.toThrow('erro 500');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('não tenta novamente em erro 400 (não retryable)', async () => {
    const fn = jest.fn().mockRejectedValue(errWithStatus(400));
    await expect(withRetry(fn, 3)).rejects.toThrow('erro 400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('não tenta novamente em erro 401 (autenticação)', async () => {
    const fn = jest.fn().mockRejectedValue(errWithStatus(401));
    await expect(withRetry(fn, 3)).rejects.toThrow('erro 401');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('respeita a flag noRetry mesmo com status retryable', async () => {
    const err = Object.assign(errWithStatus(500), { noRetry: true });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withRetry(fn, 3)).rejects.toThrow('erro 500');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('maxAttempts customizado é respeitado', async () => {
    const fn = jest.fn().mockRejectedValue(errWithStatus(503));
    await expect(withRetry(fn, 1)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
