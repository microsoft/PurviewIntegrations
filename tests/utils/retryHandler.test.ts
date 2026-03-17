// Mock @actions/core before importing RetryHandler (Logger depends on it)
jest.mock('@actions/core', () => ({
  getBooleanInput: jest.fn().mockReturnValue(false),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
}));

import { RetryHandler, RetryOptions } from '../../src/utils/retryHandler';

describe('RetryHandler', () => {
  let handler: RetryHandler;

  beforeEach(() => {
    handler = new RetryHandler();
    // Speed up tests by mocking setTimeout
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns result on first successful attempt', async () => {
    const operation = jest.fn().mockResolvedValue('success');

    const resultPromise = handler.executeWithRetry(operation, 'test-op');
    jest.runAllTimers();
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable network error and succeeds', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('recovered');

    const resultPromise = handler.executeWithRetry(operation, 'test-op', {
      maxAttempts: 3,
      initialDelay: 10,
      jitter: false,
    });

    // Advance past the retry delay
    await jest.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries on timeout error', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new Error('request timeout'))
      .mockResolvedValue('ok');

    const resultPromise = handler.executeWithRetry(operation, 'timeout-op', {
      maxAttempts: 2,
      initialDelay: 10,
      jitter: false,
    });

    await jest.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 rate limit error', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValue('ok');

    const resultPromise = handler.executeWithRetry(operation, 'rate-limit-op', {
      maxAttempts: 2,
      initialDelay: 10,
      jitter: false,
    });

    await jest.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 server error', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new Error('500 Internal Server Error'))
      .mockResolvedValue('ok');

    const resultPromise = handler.executeWithRetry(operation, 'server-error-op', {
      maxAttempts: 2,
      initialDelay: 10,
      jitter: false,
    });

    await jest.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries on ECONNRESET error', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('ok');

    const resultPromise = handler.executeWithRetry(operation, 'connreset-op', {
      maxAttempts: 2,
      initialDelay: 10,
      jitter: false,
    });

    await jest.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 401 authentication error', async () => {
    const operation = jest.fn()
      .mockRejectedValue(new Error('401 Unauthorized'));

    await expect(
      handler.executeWithRetry(operation, 'auth-op', {
        maxAttempts: 3,
        initialDelay: 10,
        jitter: false,
      })
    ).rejects.toThrow('401 Unauthorized');

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 403 forbidden error', async () => {
    const operation = jest.fn()
      .mockRejectedValue(new Error('403 Forbidden'));

    await expect(
      handler.executeWithRetry(operation, 'forbidden-op', {
        maxAttempts: 3,
        initialDelay: 10,
        jitter: false,
      })
    ).rejects.toThrow('403 Forbidden');

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry on generic unknown errors', async () => {
    const operation = jest.fn()
      .mockRejectedValue(new Error('some unexpected error'));

    await expect(
      handler.executeWithRetry(operation, 'unknown-op', {
        maxAttempts: 3,
        initialDelay: 10,
        jitter: false,
      })
    ).rejects.toThrow('some unexpected error');

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('exhausts all retry attempts and throws last error', async () => {
    jest.useRealTimers();
    const operation = jest.fn()
      .mockRejectedValue(new Error('502 Bad Gateway'));

    await expect(
      handler.executeWithRetry(operation, 'exhaust-op', {
        maxAttempts: 3,
        initialDelay: 1,
        maxDelay: 5,
        jitter: false,
      })
    ).rejects.toThrow('502 Bad Gateway');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('converts non-Error throwables to Error', async () => {
    const operation = jest.fn()
      .mockRejectedValue('string error');

    await expect(
      handler.executeWithRetry(operation, 'string-op', {
        maxAttempts: 1,
        initialDelay: 10,
        jitter: false,
      })
    ).rejects.toThrow('string error');
  });

  it('respects custom retry options', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValue('recovered');

    const options: RetryOptions = {
      maxAttempts: 5,
      initialDelay: 50,
      maxDelay: 200,
      backoffFactor: 3,
      jitter: false,
    };

    const resultPromise = handler.executeWithRetry(operation, 'custom-op', options);
    await jest.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(result).toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
