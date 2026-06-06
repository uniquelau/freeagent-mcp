import { describe, it, expect, vi } from "vitest";
import { loadToolPolicy, createGatedRegistrar, isReadTool } from "./tool-policy.js";

describe("loadToolPolicy", () => {
  it("is locked down by default: reads + reconcile on, writes off", () => {
    const p = loadToolPolicy({});
    expect(p.isEnabled("freeagent_list_invoices")).toBe(true);
    expect(p.isEnabled("freeagent_get_company")).toBe(true);
    expect(p.isEnabled("freeagent_reconcile_bank_transaction")).toBe(true);

    expect(p.isEnabled("freeagent_delete_bank_account")).toBe(false);
    expect(p.isEnabled("freeagent_create_invoice")).toBe(false);
    expect(p.isEnabled("freeagent_send_invoice_email")).toBe(false);
  });

  it("FREEAGENT_ENABLE_WRITES=true enables every tool", () => {
    const p = loadToolPolicy({ FREEAGENT_ENABLE_WRITES: "true" });
    expect(p.isEnabled("freeagent_delete_bank_account")).toBe(true);
    expect(p.isEnabled("freeagent_create_invoice")).toBe(true);
  });

  it("an allowlist registers only the listed tools", () => {
    const p = loadToolPolicy({
      FREEAGENT_ENABLED_TOOLS:
        "freeagent_get_company, freeagent_reconcile_bank_transaction",
    });
    expect(p.isEnabled("freeagent_get_company")).toBe(true);
    expect(p.isEnabled("freeagent_reconcile_bank_transaction")).toBe(true);
    // a read tool that is NOT on the allowlist is excluded
    expect(p.isEnabled("freeagent_list_invoices")).toBe(false);
  });

  it("the blocklist always wins, even over allowlist / writes", () => {
    const p = loadToolPolicy({
      FREEAGENT_ENABLE_WRITES: "true",
      FREEAGENT_DISABLED_TOOLS: "freeagent_delete_bank_account",
    });
    expect(p.isEnabled("freeagent_create_invoice")).toBe(true);
    expect(p.isEnabled("freeagent_delete_bank_account")).toBe(false);

    const p2 = loadToolPolicy({
      FREEAGENT_ENABLED_TOOLS: "freeagent_get_company,freeagent_delete_bank_account",
      FREEAGENT_DISABLED_TOOLS: "freeagent_delete_bank_account",
    });
    expect(p2.isEnabled("freeagent_get_company")).toBe(true);
    expect(p2.isEnabled("freeagent_delete_bank_account")).toBe(false);
  });

  it("isReadTool identifies list_/get_ tools only", () => {
    expect(isReadTool("freeagent_list_x")).toBe(true);
    expect(isReadTool("freeagent_get_x")).toBe(true);
    expect(isReadTool("freeagent_create_x")).toBe(false);
    expect(isReadTool("freeagent_reconcile_bank_transaction")).toBe(false);
  });
});

describe("createGatedRegistrar", () => {
  it("only forwards policy-enabled tools to the underlying server", () => {
    const registered: string[] = [];
    const fakeServer = {
      tool: vi.fn((name: string) => registered.push(name)),
      registerTool: vi.fn((name: string) => registered.push(name)),
    } as any;
    const policy = loadToolPolicy({}); // locked down
    const reg = createGatedRegistrar(fakeServer, policy);

    reg.tool(
      "freeagent_list_invoices",
      "d",
      {},

      (async () => ({})) as any
    );
    reg.tool(
      "freeagent_delete_bank_account",
      "d",
      {},

      (async () => ({})) as any
    );
    reg.registerTool(
      "freeagent_reconcile_bank_transaction",

      {} as any,

      (async () => ({})) as any
    );

    expect(registered).toEqual([
      "freeagent_list_invoices",
      "freeagent_reconcile_bank_transaction",
    ]);
    expect(policy.describe()).toContain("locked down");
    expect(policy.describe()).toContain("not registered");
  });
});
