const DEFAULT_BASE_URL = "https://api.freeagent.com/v2";

export class FreeAgentApiError extends Error {
  public readonly status: number;
  public readonly errorCode: string;

  constructor(status: number, errorCode: string, message: string) {
    super(`FreeAgent API error (${status}): ${errorCode} - ${message}`);
    this.name = "FreeAgentApiError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

function parseApiError(status: number, body: string): FreeAgentApiError {
  try {
    const parsed = JSON.parse(body);
    const code = parsed?.error ?? parsed?.code ?? "unknown";
    let message =
      parsed?.message ??
      parsed?.error_description ??
      parsed?.errors?.error?.message;
    // FreeAgent validation errors come back as `{ "errors": [ { "message": ... } ] }`.
    // Surface all of them so callers see the actual reason (e.g. VAT rules) rather
    // than a bare status code.
    if (!message && Array.isArray(parsed?.errors)) {
      message = parsed.errors
        .map((e: { message?: string }) => e?.message)
        .filter(Boolean)
        .join("; ");
    }
    if (!message) message = `HTTP ${status}`;
    return new FreeAgentApiError(status, code, message);
  } catch {
    return new FreeAgentApiError(status, "unknown", `HTTP ${status} error`);
  }
}

function encodeFormBody(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

export interface RetryOptions {
  /** Retries after a 429 before giving up (default 5; 0 disables). */
  maxRetries?: number;
  /** First backoff delay when the response has no Retry-After (default 1000ms). */
  baseDelayMs?: number;
  /** Longest single wait; a longer Retry-After fails fast instead (default 60000ms). */
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry-After is either delta-seconds or an HTTP date. */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export class FreeAgentClient {
  private getAccessToken: () => Promise<string>;
  private baseUrl: string;
  private retry: Required<RetryOptions>;

  constructor(
    tokenOrProvider: string | (() => Promise<string>),
    baseUrl?: string,
    retry: RetryOptions = {}
  ) {
    this.getAccessToken =
      typeof tokenOrProvider === "function"
        ? tokenOrProvider
        : async () => tokenOrProvider;
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.retry = {
      maxRetries: retry.maxRetries ?? 5,
      baseDelayMs: retry.baseDelayMs ?? 1000,
      maxDelayMs: retry.maxDelayMs ?? 60_000,
      sleep: retry.sleep ?? sleepFor,
    };
  }

  async get<T = unknown>(
    path: string,
    params?: Record<string, string>
  ): Promise<T> {
    return this.request<T>("GET", path, undefined, undefined, params);
  }

  async postForm<T = unknown>(
    path: string,
    body?: Record<string, string>
  ): Promise<T> {
    return this.request<T>("POST", path, body, "form");
  }

  async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body, "json");
  }

  async putForm<T = unknown>(
    path: string,
    body?: Record<string, string>
  ): Promise<T> {
    return this.request<T>("PUT", path, body, "form");
  }

  async putJson<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body, "json");
  }

  async patchJson<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body, "json");
  }

  async deleteReq<T = unknown>(
    path: string,
    params?: Record<string, string>
  ): Promise<T> {
    return this.request<T>("DELETE", path, undefined, undefined, params);
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    bodyType?: "form" | "json",
    params?: Record<string, string>
  ): Promise<T> {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/";
    const fullPath = path.startsWith("/") ? path.slice(1) : path;

    if (/\.\.[\\/]/.test(fullPath) || /^[a-z]+:\/\//i.test(fullPath)) {
      throw new Error(`Unsafe API path rejected: ${fullPath}`);
    }

    const url = new URL(fullPath, base);

    if (url.origin !== new URL(base).origin) {
      throw new Error(`Resolved URL origin does not match base: ${url.origin}`);
    }

    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "freeagent-mcp-server",
    };

    let encodedBody: string | undefined;

    if (body && bodyType === "json") {
      headers["Content-Type"] = "application/json";
      encodedBody = JSON.stringify(body);
    } else if (body && bodyType === "form") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      encodedBody = encodeFormBody(body as Record<string, string>);
    }

    // FreeAgent rate-limits per user (HTTP 429). A 429 means the request was
    // rejected, not processed, so retrying is safe for every method, writes included.
    for (let attempt = 0; ; attempt++) {
      // Fetched per attempt so a long wait can't leave us with an expired token.
      headers.Authorization = `Bearer ${await this.getAccessToken()}`;

      const response = await fetch(url.toString(), {
        method,
        headers,
        body: encodedBody,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 429 && attempt < this.retry.maxRetries) {
          const delay =
            parseRetryAfter(response.headers?.get?.("retry-after")) ??
            Math.min(this.retry.baseDelayMs * 2 ** attempt, this.retry.maxDelayMs);
          // A Retry-After beyond our ceiling (e.g. the hourly limit) means waiting
          // here would hang the caller; surface the 429 instead.
          if (delay <= this.retry.maxDelayMs) {
            await this.retry.sleep(delay);
            continue;
          }
        }
        throw parseApiError(response.status, errorBody);
      }

      const text = await response.text();
      if (!text) return {} as T;
      return JSON.parse(text) as T;
    }
  }
}
