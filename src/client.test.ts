import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FreeAgentClient, FreeAgentApiError } from "./client.js";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response;
}

function mockError(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    text: async () =>
      typeof body === "string" ? body : JSON.stringify(body),
  } as Response;
}

describe("FreeAgentClient - GET", () => {
  it("sends Authorization header", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient("test-token");
    await client.get("/v2/test");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/v2/test");
    expect(opts.headers.Authorization).toBe("Bearer test-token");
  });

  it("sends Accept and User-Agent headers", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient("token");
    await client.get("/v2/test");

    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>).Accept).toBe(
      "application/json"
    );
    expect((opts.headers as Record<string, string>)["User-Agent"]).toBe(
      "freeagent-mcp-server"
    );
  });

  it("appends query params", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient("token");
    await client.get("/v2/test", { foo: "bar", limit: "10" });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("foo=bar");
    expect(url).toContain("limit=10");
  });

  it("uses default production base URL", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient("token");
    await client.get("/v2/company");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("api.freeagent.com");
    expect(url).not.toContain("sandbox");
  });

  it("uses custom base URL when provided", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient(
      "token",
      "https://api.sandbox.freeagent.com/v2"
    );
    await client.get("/v2/company");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("api.sandbox.freeagent.com");
  });

  it("handles empty response body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "",
    } as Response);
    const client = new FreeAgentClient("token");
    const result = await client.get("/v2/test");
    expect(result).toEqual({});
  });
});

describe("FreeAgentClient - POST", () => {
  it("sends JSON body for postJson", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient("token");
    await client.postJson("/v2/test", { invoice: { amount: 100 } });

    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe("POST");
    expect(
      (opts.headers as Record<string, string>)["Content-Type"]
    ).toBe("application/json");
    expect(opts.body).toBe('{"invoice":{"amount":100}}');
  });

  it("sends form body for postForm", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient("token");
    await client.postForm("/v2/test", { key: "value" });

    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(
      (opts.headers as Record<string, string>)["Content-Type"]
    ).toBe("application/x-www-form-urlencoded");
    expect(opts.body).toBe("key=value");
  });
});

describe("FreeAgentClient - PUT", () => {
  it("sends JSON body for putJson", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient("token");
    await client.putJson("/v2/test/123", { contact: { name: "Sam" } });

    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe("PUT");
    expect(
      (opts.headers as Record<string, string>)["Content-Type"]
    ).toBe("application/json");
  });
});

describe("FreeAgentClient - DELETE", () => {
  it("sends DELETE request", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({}));
    const client = new FreeAgentClient("token");
    await client.deleteReq("/v2/test/123");

    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe("DELETE");
  });
});

describe("FreeAgentClient - token provider", () => {
  it("accepts an async function as token provider", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const provider = async () => "dynamic-token";
    const client = new FreeAgentClient(provider);
    await client.get("/v2/test");

    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      "Bearer dynamic-token"
    );
  });

  it("calls provider on each request", async () => {
    let callCount = 0;
    const provider = async () => `token-${++callCount}`;
    const client = new FreeAgentClient(provider);

    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    await client.get("/v2/test1");

    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    await client.get("/v2/test2");

    const opts1 = mockFetch.mock.calls[0][1] as RequestInit;
    const opts2 = mockFetch.mock.calls[1][1] as RequestInit;
    expect((opts1.headers as Record<string, string>).Authorization).toBe(
      "Bearer token-1"
    );
    expect((opts2.headers as Record<string, string>).Authorization).toBe(
      "Bearer token-2"
    );
  });

  it("still works with a plain string token", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient("static-token");
    await client.get("/v2/test");

    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      "Bearer static-token"
    );
  });
});

describe("FreeAgentClient - path safety", () => {
  it("rejects absolute URLs that would override the base", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient("token");

    await expect(
      client.get("https://evil.com/steal")
    ).rejects.toThrow();
  });

  it("rejects paths with traversal sequences", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient("token");

    await expect(
      client.get("/contacts/../../users/me")
    ).rejects.toThrow();
  });

  it("allows normal API paths", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ data: "ok" }));
    const client = new FreeAgentClient("token");

    await client.get("/contacts/123");
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("api.freeagent.com");
    expect(url).toContain("/contacts/123");
  });
});

describe("FreeAgentClient - error handling", () => {
  it("throws FreeAgentApiError with parsed fields", async () => {
    mockFetch.mockResolvedValueOnce(
      mockError(400, { error: "invalid_param", message: "bad request" })
    );

    const client = new FreeAgentClient("token");
    try {
      await client.get("/v2/test");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FreeAgentApiError);
      const err = e as FreeAgentApiError;
      expect(err.status).toBe(400);
      expect(err.errorCode).toBe("invalid_param");
    }
  });

  it("handles nested error format", async () => {
    mockFetch.mockResolvedValueOnce(
      mockError(422, {
        errors: { error: { message: "Contact is required" } },
      })
    );

    const client = new FreeAgentClient("token");
    try {
      await client.get("/v2/test");
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as FreeAgentApiError;
      expect(err.status).toBe(422);
    }
  });

  it("surfaces array-form validation errors (FreeAgent 422)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockError(422, {
        errors: [
          { message: "sales_tax_rate must be set to 'Auto' or '0.0' for Reverse Charge" },
          { message: "description can't be blank" },
        ],
      })
    );

    const client = new FreeAgentClient("token");
    try {
      await client.get("/v2/test");
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as FreeAgentApiError;
      expect(err.status).toBe(422);
      expect(err.message).toContain("Reverse Charge");
      expect(err.message).toContain("description can't be blank");
    }
  });

  it("returns safe fallback for malformed error body", async () => {
    mockFetch.mockResolvedValueOnce(mockError(500, "not json"));

    const client = new FreeAgentClient("token");
    try {
      await client.get("/v2/test");
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as FreeAgentApiError;
      expect(err.errorCode).toBe("unknown");
      expect(err.message).not.toContain("not json");
    }
  });
});

describe("FreeAgentClient - rate limit retry", () => {
  function mock429(retryAfter?: string): Response {
    return {
      ok: false,
      status: 429,
      headers: new Headers(retryAfter ? { "Retry-After": retryAfter } : {}),
      text: async () => "",
    } as Response;
  }

  it("retries a 429 and returns the eventual success", async () => {
    mockFetch
      .mockResolvedValueOnce(mock429())
      .mockResolvedValueOnce(mock429())
      .mockResolvedValueOnce(mockOk({ data: "ok" }));
    const sleep = vi.fn(async () => {});
    const client = new FreeAgentClient("token", undefined, { sleep });
    const result = await client.get("/v2/test");
    expect(result).toEqual({ data: "ok" });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // exponential backoff from baseDelayMs when there is no Retry-After
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("honours a Retry-After header in seconds", async () => {
    mockFetch
      .mockResolvedValueOnce(mock429("7"))
      .mockResolvedValueOnce(mockOk({ data: "ok" }));
    const sleep = vi.fn(async () => {});
    const client = new FreeAgentClient("token", undefined, { sleep });
    await client.get("/v2/test");
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("retries writes too, resending the same body", async () => {
    mockFetch
      .mockResolvedValueOnce(mock429())
      .mockResolvedValueOnce(mockOk({ bill: { url: "x" } }));
    const client = new FreeAgentClient("token", undefined, { sleep: async () => {} });
    await client.postJson("/v2/bills", { bill: { reference: "059" } });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][1].method).toBe("POST");
    expect(mockFetch.mock.calls[1][1].body).toBe(mockFetch.mock.calls[0][1].body);
  });

  it("gives up after maxRetries and throws the 429", async () => {
    mockFetch.mockResolvedValue(mock429());
    const sleep = vi.fn(async () => {});
    const client = new FreeAgentClient("token", undefined, { maxRetries: 2, sleep });
    await expect(client.get("/v2/test")).rejects.toMatchObject({ status: 429 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fails fast when Retry-After exceeds maxDelayMs", async () => {
    mockFetch.mockResolvedValue(mock429("3600"));
    const sleep = vi.fn(async () => {});
    const client = new FreeAgentClient("token", undefined, { sleep });
    await expect(client.get("/v2/test")).rejects.toBeInstanceOf(FreeAgentApiError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry other errors", async () => {
    mockFetch.mockResolvedValue(mockError(500, { error: "boom" }));
    const sleep = vi.fn(async () => {});
    const client = new FreeAgentClient("token", undefined, { sleep });
    await expect(client.get("/v2/test")).rejects.toMatchObject({ status: 500 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("re-reads the access token on each attempt", async () => {
    mockFetch
      .mockResolvedValueOnce(mock429())
      .mockResolvedValueOnce(mockOk({ data: "ok" }));
    const provider = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    const client = new FreeAgentClient(provider, undefined, { sleep: async () => {} });
    await client.get("/v2/test");
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer new");
  });
});
