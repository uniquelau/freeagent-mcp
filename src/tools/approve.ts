import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { FreeAgentClient } from "../client.js";
import { jsonResponse, errorResponse, logToolCall } from "../utils.js";

/**
 * Approve / attach-receipt tool for *existing* bank transaction explanations.
 *
 * FreeAgent auto-guesses imported transactions: it creates an explanation with
 * `marked_for_review: true` awaiting approval. The manual gate is attaching the
 * VAT receipt and approving. This tool PUTs an existing explanation to attach a
 * receipt and/or approve it (set `marked_for_review: false`), optionally
 * correcting the category/VAT — without creating a new explanation.
 */

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

// FreeAgent's accepted attachment content types (see API docs); 5 MB max.
const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/x-pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function buildAttachment(path: string, description?: string) {
  const ext = extname(path).toLowerCase();
  const content_type = CONTENT_TYPES[ext];
  if (!content_type) {
    throw new Error(
      `Unsupported attachment type "${ext}". Allowed: ${Object.keys(CONTENT_TYPES).join(", ")}`
    );
  }
  const size = statSync(path).size;
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment ${basename(path)} is ${(size / 1024 / 1024).toFixed(1)}MB; FreeAgent's limit is 5MB`
    );
  }
  const attachment: Record<string, unknown> = {
    data: readFileSync(path).toString("base64"),
    file_name: basename(path),
    content_type,
  };
  if (description) attachment.description = description;
  return attachment;
}

export function registerApprovalTools(
  server: McpServer,
  client: FreeAgentClient
): void {
  server.tool(
    "freeagent_approve_explanation",
    "Update an EXISTING bank transaction explanation (one FreeAgent guessed, " +
      "`marked_for_review: true`): attach a VAT receipt from a local file and/or " +
      "approve it by setting `marked_for_review` false. Optionally correct the " +
      "category / VAT. Does not create a new explanation — use " +
      "freeagent_reconcile_bank_transaction for unexplained transactions.",
    {
      explanation_id: idOrUrl("explanation_id").describe(
        "ID or URL of the bank_transaction_explanation to update"
      ),
      marked_for_review: z
        .boolean()
        .optional()
        .describe("Set false to approve the guess; true to keep it flagged"),
      attachment_path: z
        .string()
        .optional()
        .describe(
          "Local file path to the receipt (PDF/PNG/JPG/GIF, <=5MB) to attach"
        ),
      attachment_description: z
        .string()
        .optional()
        .describe("Optional description for the attached receipt"),
      category: idOrUrl("category")
        .optional()
        .describe("Correct the category (nominal code or URL)"),
      sales_tax_rate: z
        .string()
        .optional()
        .describe('Correct the VAT rate, e.g. "20.0" or "0.0"'),
      sales_tax_value: z
        .string()
        .optional()
        .describe("Correct the VAT amount explicitly"),
      ec_status: z
        .enum([
          "UK/Non-EC",
          "EC Goods",
          "EC Services",
          "Reverse Charge",
          "EC VAT MOSS",
        ])
        .optional()
        .describe("Correct the VAT treatment (e.g. Reverse Charge)"),
      description: z.string().optional().describe("Correct the description"),
    },
    async ({
      explanation_id,
      marked_for_review,
      attachment_path,
      attachment_description,
      category,
      sales_tax_rate,
      sales_tax_value,
      ec_status,
      description,
    }) => {
      logToolCall("freeagent_approve_explanation", {
        explanation_id,
        marked_for_review,
        attachment_path,
      });
      try {
        const id = explanation_id.startsWith("http")
          ? new URL(explanation_id).pathname.replace(/^\/v2/, "")
          : `/bank_transaction_explanations/${explanation_id}`;

        const explanation: Record<string, unknown> = {};
        if (marked_for_review !== undefined)
          explanation.marked_for_review = marked_for_review;
        if (description !== undefined) explanation.description = description;
        if (sales_tax_rate !== undefined)
          explanation.sales_tax_rate = sales_tax_rate;
        if (sales_tax_value !== undefined)
          explanation.sales_tax_value = sales_tax_value;
        if (ec_status !== undefined) explanation.ec_status = ec_status;
        if (category !== undefined) {
          explanation.category = category.startsWith("http")
            ? category
            : `/categories/${category}`;
        }
        if (attachment_path) {
          explanation.attachment = buildAttachment(
            attachment_path,
            attachment_description
          );
        }

        if (Object.keys(explanation).length === 0) {
          throw new Error(
            "Nothing to update: provide at least one of marked_for_review, attachment_path, category, or a VAT field."
          );
        }

        const data = await client.putJson(id, {
          bank_transaction_explanation: explanation,
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(error);
      }
    }
  );
}
