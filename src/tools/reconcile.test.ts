import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FreeAgentClient } from "../client.js";
import { registerReconcileTools } from "./reconcile.js";

type ToolHandler = (...args: any[]) => any;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    server: {
      tool: vi.fn((...args: any[]) => {
        const name = args[0] as string;
        const cb = typeof args[2] === "function" ? args[2] : args[3];
        tools.set(name, cb);
      }),
      registerTool: vi.fn(),
    } as any,
    tools,
  };
}

const TX = {
  bank_transaction: {
    url: "https://api.freeagent.com/v2/bank_transactions/99",
    dated_on: "2026-01-15",
    amount: "120.00",
    unexplained_amount: "100.00",
  },
};

function createMockClient(overrides: Record<string, any> = {}) {
  return {
    get: vi.fn().mockResolvedValue(TX),
    postJson: vi.fn().mockResolvedValue({
      bank_transaction_explanation: {
        url: "https://api.freeagent.com/v2/bank_transaction_explanations/5",
      },
    }),
    ...overrides,
  } as unknown as FreeAgentClient;
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe("registerReconcileTools", () => {
  it("registers one tool", () => {
    const { server, tools } = createMockServer();
    registerReconcileTools(server, createMockClient());
    expect(tools.size).toBe(1);
    expect(tools.has("freeagent_reconcile_bank_transaction")).toBe(true);
  });

  it("explains against a category nominal code, defaulting date/amount from the transaction", async () => {
    const { server, tools } = createMockServer();
    const client = createMockClient({
      get: vi.fn(async (path: string) => {
        if (path.startsWith("/bank_transactions/")) return TX;
        if (path.startsWith("/categories/")) {
          return {
            category: { url: "https://api.freeagent.com/v2/categories/285" },
          };
        }
        throw new Error(`unexpected GET ${path}`);
      }),
    });
    registerReconcileTools(server, client);
    const handler = tools.get("freeagent_reconcile_bank_transaction")!;

    const result = await handler({ bank_transaction_id: "99", category: "285" });

    expect(client.get).toHaveBeenCalledWith("/bank_transactions/99");
    expect(client.get).toHaveBeenCalledWith("/categories/285");
    expect(client.postJson).toHaveBeenCalledWith("/bank_transaction_explanations", {
      bank_transaction_explanation: {
        bank_transaction: TX.bank_transaction.url,
        dated_on: "2026-01-15",
        // defaults to the transaction's unexplained_amount, not its total amount
        gross_value: "100.00",
        category: "https://api.freeagent.com/v2/categories/285",
      },
    });
    expect(result.isError).toBeUndefined();
  });

  it("accepts a full bank-transaction URL and reduces it to a relative path", async () => {
    const { server, tools } = createMockServer();
    const client = createMockClient();
    registerReconcileTools(server, client);
    const handler = tools.get("freeagent_reconcile_bank_transaction")!;

    await handler({
      bank_transaction_id: "https://api.freeagent.com/v2/bank_transactions/99",
      paid_invoice: "https://api.freeagent.com/v2/invoices/7",
    });

    expect(client.get).toHaveBeenCalledWith("/bank_transactions/99");
    // a passed-in invoice URL is used as-is (no extra GET to resolve it)
    expect(client.postJson).toHaveBeenCalledWith(
      "/bank_transaction_explanations",
      expect.objectContaining({
        bank_transaction_explanation: expect.objectContaining({
          paid_invoice: "https://api.freeagent.com/v2/invoices/7",
        }),
      })
    );
  });

  it("passes description and marked_for_review through", async () => {
    const { server, tools } = createMockServer();
    const client = createMockClient();
    registerReconcileTools(server, client);
    const handler = tools.get("freeagent_reconcile_bank_transaction")!;

    await handler({
      bank_transaction_id: "99",
      paid_bill: "https://api.freeagent.com/v2/bills/3",
      description: "Office supplies",
      marked_for_review: true,
    });

    expect(client.postJson).toHaveBeenCalledWith(
      "/bank_transaction_explanations",
      expect.objectContaining({
        bank_transaction_explanation: expect.objectContaining({
          paid_bill: "https://api.freeagent.com/v2/bills/3",
          description: "Office supplies",
          marked_for_review: true,
        }),
      })
    );
  });

  it("rejects when no link target is provided", async () => {
    const { server, tools } = createMockServer();
    const client = createMockClient();
    registerReconcileTools(server, client);
    const handler = tools.get("freeagent_reconcile_bank_transaction")!;

    const result = await handler({ bank_transaction_id: "99" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/exactly one/);
    expect(client.postJson).not.toHaveBeenCalled();
  });

  it("rejects when more than one link target is provided", async () => {
    const { server, tools } = createMockServer();
    const client = createMockClient();
    registerReconcileTools(server, client);
    const handler = tools.get("freeagent_reconcile_bank_transaction")!;

    const result = await handler({
      bank_transaction_id: "99",
      category: "285",
      paid_bill: "3",
    });

    expect(result.isError).toBe(true);
    expect(client.postJson).not.toHaveBeenCalled();
  });
});
