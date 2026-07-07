function isRetryable(err: unknown): boolean {
  if ((err as { noRetry?: boolean })?.noRetry) return false;
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const code = (err as { code?: string })?.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ERR_STREAM_PREMATURE_CLOSE') return true;
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      const delayMs = 500 * 2 ** (attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}
