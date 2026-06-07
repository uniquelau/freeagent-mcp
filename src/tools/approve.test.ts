import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FreeAgentClient } from "../client.js";
import { registerApprovalTools } from "./approve.js";

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

function createMockClient() {
  return {
    putJson: vi.fn().mockResolvedValue({
      bank_transaction_explanation: { url: "https://api.freeagent.com/v2/bank_transaction_explanations/5" },
    }),
  } as unknown as FreeAgentClient;
}

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
let pngPath: string;
beforeAll(() => {
  pngPath = join(tmpdir(), "fa-test-receipt.png");
  writeFileSync(pngPath, PNG);
});
afterAll(() => {
  try {
    rmSync(pngPath);
  } catch {
    /* ignore */
  }
});

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe("registerApprovalTools", () => {
  it("registers one tool", () => {
    const { server, tools } = createMockServer();
    registerApprovalTools(server, createMockClient());
    expect(tools.size).toBe(1);
    expect(tools.has("freeagent_approve_explanation")).toBe(true);
  });

  it("approves + corrects VAT via PUT to the explanation", async () => {
    const { server, tools } = createMockServer();
    const client = createMockClient();
    registerApprovalTools(server, client);
    const handler = tools.get("freeagent_approve_explanation")!;

    await handler({
      explanation_id: "5",
      marked_for_review: false,
      category: "269",
      sales_tax_rate: "20.0",
    });

    expect(client.putJson).toHaveBeenCalledWith("/bank_transaction_explanations/5", {
      bank_transaction_explanation: {
        marked_for_review: false,
        sales_tax_rate: "20.0",
        category: "/categories/269",
      },
    });
  });

  it("attaches a receipt file as base64 with the right content type", async () => {
    const { server, tools } = createMockServer();
    const client = createMockClient();
    registerApprovalTools(server, client);
    const handler = tools.get("freeagent_approve_explanation")!;

    await handler({ explanation_id: "5", marked_for_review: false, attachment_path: pngPath });

    const body = (client.putJson as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .bank_transaction_explanation;
    expect(body.marked_for_review).toBe(false);
    expect(body.attachment.content_type).toBe("image/png");
    expect(body.attachment.file_name).toBe("fa-test-receipt.png");
    expect(body.attachment.data).toBe(PNG.toString("base64"));
  });

  it("reduces a full explanation URL to a relative path", async () => {
    const { server, tools } = createMockServer();
    const client = createMockClient();
    registerApprovalTools(server, client);
    const handler = tools.get("freeagent_approve_explanation")!;

    await handler({
      explanation_id: "https://api.freeagent.com/v2/bank_transaction_explanations/9",
      marked_for_review: false,
    });

    expect(client.putJson).toHaveBeenCalledWith(
      "/bank_transaction_explanations/9",
      expect.anything()
    );
  });

  it("errors when there is nothing to update", async () => {
    const { server, tools } = createMockServer();
    const client = createMockClient();
    registerApprovalTools(server, client);
    const handler = tools.get("freeagent_approve_explanation")!;

    const result = await handler({ explanation_id: "5" });
    expect(result.isError).toBe(true);
    expect(client.putJson).not.toHaveBeenCalled();
  });
});
