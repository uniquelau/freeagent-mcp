import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Tool-gating policy.
 *
 * By default the server runs "locked down": only read tools (list_* / get_*)
 * and the reconcile tool are registered. Write/delete tools (create_*, update_*,
 * delete_*, send_*, mark_*, start_/stop_timer, ...) are NOT registered unless
 * explicitly enabled. This keeps the blast radius small when the server is
 * driven by an LLM that could otherwise delete accounts or email customers.
 *
 * Environment controls (all optional):
 *   FREEAGENT_ENABLED_TOOLS   Comma-separated allowlist. If set, ONLY these
 *                             tools are registered (overrides every default).
 *   FREEAGENT_DISABLED_TOOLS  Comma-separated blocklist, applied last. Always
 *                             wins, even over the allowlist.
 *   FREEAGENT_ENABLE_WRITES   "true" registers every tool (legacy behaviour).
 */

const READ_TOOL_PREFIXES = ["freeagent_list_", "freeagent_get_"] as const;

/**
 * Write tools enabled by default even in the locked-down posture, because they
 * are required for core reconciliation / cash-flow workflows and are far lower
 * blast radius than delete/send operations.
 */
const DEFAULT_ENABLED_WRITES = new Set<string>([
  "freeagent_reconcile_bank_transaction",
  "freeagent_approve_explanation",
]);

export interface ToolPolicy {
  isEnabled(name: string): boolean;
  /** Record a tool that was skipped, for the startup summary. */
  noteSkipped(name: string): void;
  /** Human-readable one-line summary for startup logging. */
  describe(): string;
}

function parseList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export function isReadTool(name: string): boolean {
  return READ_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

export function loadToolPolicy(env: NodeJS.ProcessEnv = process.env): ToolPolicy {
  const allow = parseList(env.FREEAGENT_ENABLED_TOOLS);
  const deny = parseList(env.FREEAGENT_DISABLED_TOOLS);
  const enableWrites = env.FREEAGENT_ENABLE_WRITES === "true";
  const skipped: string[] = [];

  function baseEnabled(name: string): boolean {
    // Explicit allowlist wins over the default posture.
    if (allow.size > 0) return allow.has(name);
    if (enableWrites) return true;
    return isReadTool(name) || DEFAULT_ENABLED_WRITES.has(name);
  }

  let mode: string;
  if (allow.size > 0) mode = `allowlist (${allow.size} tool(s))`;
  else if (enableWrites) mode = "writes enabled (all tools)";
  else mode = "locked down (read + reconcile)";

  return {
    isEnabled(name: string): boolean {
      // Blocklist always wins.
      if (deny.has(name)) return false;
      return baseEnabled(name);
    },
    noteSkipped(name: string): void {
      skipped.push(name);
    },
    describe(): string {
      const denyNote = deny.size > 0 ? `, ${deny.size} explicitly disabled` : "";
      const skipNote =
        skipped.length > 0 ? `; ${skipped.length} write tool(s) not registered` : "";
      return `${mode}${denyNote}${skipNote}`;
    },
  };
}

/**
 * Wrap an McpServer so that only policy-enabled tools are actually registered.
 *
 * Returns a minimal facade rather than a Proxy: the SDK's McpServer uses private
 * class fields, which break when accessed through a Proxy. The register* helpers
 * only ever call .tool() / .registerTool(), so a two-method facade is sufficient
 * and keeps every tool file untouched.
 */
export function createGatedRegistrar(server: McpServer, policy: ToolPolicy): McpServer {
  const guard =
    (method: "tool" | "registerTool") =>
    (...args: unknown[]): unknown => {
      const name = args[0];
      if (typeof name === "string" && !policy.isEnabled(name)) {
        policy.noteSkipped(name);
        return undefined;
      }

      return (server as any)[method](...args);
    };

  return {
    tool: guard("tool"),
    registerTool: guard("registerTool"),
  } as unknown as McpServer;
}
