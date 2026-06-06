#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FreeAgentClient } from "./client.js";
import { runAuthFlow, getValidAccessToken, getApiBase } from "./auth.js";
import type { OAuthConfig } from "./auth.js";
import { registerCompanyTools } from "./tools/company.js";
import { registerUserTools } from "./tools/users.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerTimeslipTools } from "./tools/timeslips.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerEstimateTools } from "./tools/estimates.js";
import { registerBillTools } from "./tools/bills.js";
import { registerCreditNoteTools } from "./tools/credit-notes.js";
import { registerExpenseTools } from "./tools/expenses.js";
import { registerBankingTools } from "./tools/banking.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerAccountingTools } from "./tools/accounting.js";
import { registerReconcileTools } from "./tools/reconcile.js";
import { loadToolPolicy, createGatedRegistrar } from "./tool-policy.js";

const FREEAGENT_ACCESS_TOKEN = process.env.FREEAGENT_ACCESS_TOKEN;
const FREEAGENT_CLIENT_ID = process.env.FREEAGENT_CLIENT_ID;
const FREEAGENT_CLIENT_SECRET = process.env.FREEAGENT_CLIENT_SECRET;
const FREEAGENT_SANDBOX = process.env.FREEAGENT_SANDBOX === "true";
const FREEAGENT_BASE_URL = process.env.FREEAGENT_BASE_URL;

function buildOAuthConfig(): OAuthConfig | null {
  if (FREEAGENT_CLIENT_ID && FREEAGENT_CLIENT_SECRET) {
    return {
      clientId: FREEAGENT_CLIENT_ID,
      clientSecret: FREEAGENT_CLIENT_SECRET,
      sandbox: FREEAGENT_SANDBOX,
    };
  }
  return null;
}

/**
 * Refuse to send bearer tokens over a non-HTTPS base URL. The access token is
 * attached to every request, so an http:// override (other than localhost, for
 * testing against a local mock) would leak credentials in cleartext.
 */
function assertHttpsBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error(`Invalid FREEAGENT_BASE_URL: ${url}`);
    process.exit(1);
  }
  const isLocalhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !isLocalhost) {
    console.error(
      `Refusing non-HTTPS FREEAGENT_BASE_URL (${url}): bearer tokens must only ` +
        `be sent over HTTPS.`
    );
    process.exit(1);
  }
}

// Handle `npx freeagent-mcp-server auth` subcommand
if (process.argv[2] === "auth") {
  const config = buildOAuthConfig();
  if (!config) {
    console.error(
      "Missing FREEAGENT_CLIENT_ID and FREEAGENT_CLIENT_SECRET environment variables.\n" +
        "Set these from your FreeAgent Developer Dashboard app credentials."
    );
    process.exit(1);
  }
  runAuthFlow(config)
    .then(() => {
      console.log("Authentication complete! Tokens saved.");
      console.log("You can now start the MCP server.");
    })
    .catch((err) => {
      console.error("Authentication failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => {
      // Don't call process.exit() here: on Windows it races the teardown of
      // undici's (global fetch) async handle and aborts with a libuv assertion
      // (async.c). The auth flow has closed its callback server and released
      // stdin, so the loop drains and the process exits on its own. The unref'd
      // timer is a safety net (it doesn't keep the loop alive) for the rare case
      // something lingers past 1.5s, by which point undici has settled.
      setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
    });
} else {
  // Normal server mode
  let client: FreeAgentClient;

  if (FREEAGENT_BASE_URL) {
    assertHttpsBaseUrl(FREEAGENT_BASE_URL);
  }

  if (FREEAGENT_ACCESS_TOKEN) {
    // Legacy: direct access token
    client = new FreeAgentClient(
      FREEAGENT_ACCESS_TOKEN,
      FREEAGENT_BASE_URL
    );
  } else {
    const config = buildOAuthConfig();
    if (!config) {
      console.error(
        "Missing credentials. Provide one of:\n" +
          "  1. FREEAGENT_CLIENT_ID + FREEAGENT_CLIENT_SECRET (recommended)\n" +
          "  2. FREEAGENT_ACCESS_TOKEN (legacy)\n\n" +
          "For option 1, run `npx freeagent-mcp-server auth` first to authenticate."
      );
      process.exit(1);
    }
    const baseUrl = FREEAGENT_BASE_URL || getApiBase(config.sandbox);
    client = new FreeAgentClient(
      () => getValidAccessToken(config),
      baseUrl
    );
  }

  const server = new McpServer({
    name: "freeagent-mcp",
    version: "1.0.0",
  });

  // Locked-down by default: only read tools + reconcile are registered unless
  // writes are explicitly enabled. See tool-policy.ts for the env controls.
  const policy = loadToolPolicy();
  const reg = createGatedRegistrar(server, policy);

  registerCompanyTools(reg, client);
  registerUserTools(reg, client);
  registerContactTools(reg, client);
  registerProjectTools(reg, client);
  registerTaskTools(reg, client);
  registerTimeslipTools(reg, client);
  registerInvoiceTools(reg, client);
  registerEstimateTools(reg, client);
  registerBillTools(reg, client);
  registerCreditNoteTools(reg, client);
  registerExpenseTools(reg, client);
  registerBankingTools(reg, client);
  registerCategoryTools(reg, client);
  registerAccountingTools(reg, client);
  registerReconcileTools(reg, client);

  async function main() {
    console.error(`FreeAgent MCP tool policy: ${policy.describe()}`);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("FreeAgent MCP Server running on stdio");
  }

  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
