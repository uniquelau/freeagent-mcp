import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FreeAgentClient } from "../client.js";
import { jsonResponse, errorResponse, logToolCall } from "../utils.js";

/**
 * Reconciliation tool: create a bank transaction explanation that links a bank
 * transaction to a category, a paid invoice, or a paid bill. This is the write
 * action FreeAgent uses to actually reconcile/explain a transaction.
 */

// Accept either a bare FreeAgent resource id (alphanumerics, dash, underscore)
// or a fully-qualified https://api(.sandbox).freeagent.com/v2/... URL. Any other
// host, scheme, or path-traversal attempt is rejected up front as defence in
// depth on top of the client's own origin checks.
const FREEAGENT_URL =
  /^https:\/\/api(\.sandbox)?\.freeagent\.com\/v2\/[A-Za-z0-9._~\-/]+$/;
const BARE_ID = /^[A-Za-z0-9_-]+$/;

const idOrUrl = (label: string) =>
  z
    .string()
    .trim()
    .min(1)
    .refine(
      (v) => BARE_ID.test(v) || FREEAGENT_URL.test(v),
      `${label} must be a FreeAgent id or a https://api.freeagent.com/v2/... URL`
    );

/**
 * Convert an id-or-URL into a base-relative API path (e.g. `/bank_transactions/1`).
 * The client deliberately rejects absolute URLs, so any FreeAgent URL must be
 * reduced to a path under the configured base before it can be fetched.
 */
function toRelativePath(collection: string, value: string): string {
  if (!value.startsWith("http")) return `/${collection}/${value}`;
  return new URL(value).pathname.replace(/^\/v2/, "");
}

async function resolveResourceUrl(
  client: FreeAgentClient,
  collection: "categories" | "invoices" | "bills",
  singular: "category" | "invoice" | "bill",
  value: string
): Promise<string> {
  // Linked-resource fields in the payload expect a full FreeAgent URL, so a
  // passed-in URL is used as-is; a bare id is fetched to obtain its canonical URL.
  if (value.startsWith("http")) return value;
  // Fetch by id to obtain the canonical URL and confirm the resource exists.
  const data = (await client.get(`/${collection}/${value}`)) as Record<
    string,
    { url?: string } | undefined
  >;
  // Standard single-resource GETs nest under the singular name (invoice, bill),
  // but GET /categories/:code nests the category under its *group* key
  // (e.g. income_categories), so fall back to the first object exposing a url.
  const url =
    data?.[singular]?.url ??
    Object.values(data ?? {}).find((v) => typeof v?.url === "string")?.url;
  if (!url) {
    throw new Error(`Could not resolve ${singular} "${value}" to a FreeAgent URL`);
  }
  return url;
}

export function registerReconcileTools(server: McpServer, client: FreeAgentClient): void {
  server.tool(
    "freeagent_reconcile_bank_transaction",
    "Reconcile a bank transaction by creating a bank transaction explanation " +
      "that links it to a category, a paid invoice, or a paid bill. Provide " +
      "exactly one of `category`, `paid_invoice`, or `paid_bill`. Optionally set " +
      "VAT explicitly via `sales_tax_rate` / `sales_tax_value` / `ec_status` " +
      "(e.g. Reverse Charge for overseas B2B services); omit to use the " +
      "category's default VAT treatment.",
    {
      bank_transaction_id: idOrUrl("bank_transaction_id").describe(
        "ID or URL of the bank transaction to reconcile"
      ),
      category: idOrUrl("category")
        .optional()
        .describe("Category nominal code or URL to explain the transaction against"),
      paid_invoice: idOrUrl("paid_invoice")
        .optional()
        .describe("Invoice ID or URL this transaction pays"),
      paid_bill: idOrUrl("paid_bill")
        .optional()
        .describe("Bill ID or URL this transaction pays"),
      description: z
        .string()
        .optional()
        .describe("Free-text description for the explanation"),
      gross_value: z
        .string()
        .optional()
        .describe(
          "Override the explained amount (defaults to the transaction's unexplained amount)"
        ),
      dated_on: z
        .string()
        .optional()
        .describe(
          "Override the explanation date YYYY-MM-DD (defaults to the transaction date)"
        ),
      marked_for_review: z
        .boolean()
        .optional()
        .describe(
          "Set true to flag the explanation for review instead of fully reconciling"
        ),
      sales_tax_rate: z
        .string()
        .optional()
        .describe(
          "VAT/sales-tax rate as a percentage, e.g. \"20.0\" or \"0.0\". Omit to inherit the category's default rate."
        ),
      sales_tax_value: z
        .string()
        .optional()
        .describe(
          "Explicit VAT amount in the account currency (overrides the computed value). Use when the invoice VAT differs from rate × net."
        ),
      ec_status: z
        .enum([
          "UK/Non-EC",
          "EC Goods",
          "EC Services",
          "Reverse Charge",
          "EC VAT MOSS",
        ])
        .optional()
        .describe(
          "VAT treatment. Use \"Reverse Charge\" for overseas B2B services (e.g. Microsoft/Azure/AWS billed from outside the UK). EC Goods/Services are invalid for GB companies on/after 2021-01-01."
        ),
      place_of_supply: z
        .string()
        .optional()
        .describe("Place of supply — only used when ec_status is \"EC VAT MOSS\""),
    },
    async ({
      bank_transaction_id,
      category,
      paid_invoice,
      paid_bill,
      description,
      gross_value,
      dated_on,
      marked_for_review,
      sales_tax_rate,
      sales_tax_value,
      ec_status,
      place_of_supply,
    }) => {
      logToolCall("freeagent_reconcile_bank_transaction", {
        bank_transaction_id,
        category,
        paid_invoice,
        paid_bill,
      });
      try {
        const links = [category, paid_invoice, paid_bill].filter(Boolean);
        if (links.length !== 1) {
          throw new Error(
            "Provide exactly one of `category`, `paid_invoice`, or `paid_bill`."
          );
        }

        const txPath = toRelativePath("bank_transactions", bank_transaction_id);
        const txData = (await client.get(txPath)) as {
          bank_transaction?: {
            url?: string;
            dated_on?: string;
            amount?: string;
            unexplained_amount?: string;
            description?: string;
          };
        };
        const tx = txData.bank_transaction;
        if (!tx?.url) {
          throw new Error(`Bank transaction "${bank_transaction_id}" was not found`);
        }

        // A bank transaction exposes `amount` (total) and `unexplained_amount`
        // (the portion still to reconcile); the explanation itself takes
        // `gross_value`. Default to the unexplained remainder so that partially
        // explained transactions reconcile correctly.
        const explanation: Record<string, unknown> = {
          bank_transaction: tx.url,
          dated_on: dated_on ?? tx.dated_on,
          gross_value: gross_value ?? tx.unexplained_amount ?? tx.amount,
        };
        // FreeAgent requires a non-blank description for some explanations
        // (e.g. reverse charge); default to the bank memo when none is given.
        const finalDescription = description ?? tx.description;
        if (finalDescription) explanation.description = finalDescription;
        if (marked_for_review !== undefined) {
          explanation.marked_for_review = marked_for_review;
        }
        // VAT / sales-tax handling (optional). Omitted fields let FreeAgent apply
        // the category's default treatment.
        if (sales_tax_rate !== undefined) explanation.sales_tax_rate = sales_tax_rate;
        if (sales_tax_value !== undefined) explanation.sales_tax_value = sales_tax_value;
        if (ec_status !== undefined) explanation.ec_status = ec_status;
        if (place_of_supply !== undefined) explanation.place_of_supply = place_of_supply;

        if (category) {
          explanation.category = await resolveResourceUrl(
            client,
            "categories",
            "category",
            category
          );
        } else if (paid_invoice) {
          explanation.paid_invoice = await resolveResourceUrl(
            client,
            "invoices",
            "invoice",
            paid_invoice
          );
        } else if (paid_bill) {
          explanation.paid_bill = await resolveResourceUrl(
            client,
            "bills",
            "bill",
            paid_bill
          );
        }

        const data = await client.postJson("/bank_transaction_explanations", {
          bank_transaction_explanation: explanation,
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(error);
      }
    }
  );
}
