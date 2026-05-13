#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { x402Client, x402HTTPClient } = require("@x402/core/client");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { toClientEvmSigner } = require("@x402/evm");
const { privateKeyToAccount } = require("viem/accounts");

const BASE_URL = "https://imagegen.coinopai.com";

const TOOLS = [
  {
    name: "generate_image",
    description: "Generate an AI image from a text prompt. Costs $0.10 USDC per image, paid automatically via x402 on Base mainnet. Returns a PNG image URL.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Natural language description of the image to generate"
        },
        aspect: {
          type: "string",
          description: "Aspect ratio: 1:1 (default, 1024x1024), 16:9 (1024x576), 9:16 (576x1024), 4:3 (1024x768)",
          enum: ["1:1", "16:9", "9:16", "4:3"]
        }
      },
      required: ["prompt"]
    }
  }
];

function loadPrivateKey() {
  // Prefer explicit env var (required for published/distributed use)
  if (process.env.WALLET_PRIVATE_KEY) return process.env.WALLET_PRIVATE_KEY;

  // Fall back to REDACTED_ENV_VAR from the local imagegen .env (local dev convenience)
  try {
    const envPath = path.join(os.homedir(), "dev", "x402-imagegen", ".env");
    const content = fs.readFileSync(envPath, "utf-8");
    const match = content.match(/^REDACTED_ENV_VAR=(.+)$/m);
    if (match) return match[1].trim();
  } catch (_) {}

  return null;
}

function buildHttpClient() {
  const key = loadPrivateKey();
  if (!key) {
    throw new Error(
      "WALLET_PRIVATE_KEY required — set a Base wallet private key funded with USDC. " +
      "Each generate_image call costs $0.10 USDC on Base mainnet."
    );
  }

  const pk = key.startsWith("0x") ? key : "0x" + key;
  const account = privateKeyToAccount(pk);
  const signer = toClientEvmSigner(account);
  const coreClient = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
  return new x402HTTPClient(coreClient);
}

async function callPaid(httpClient, url) {
  const res = await fetch(url);

  if (res.status === 402) {
    let body;
    try { body = await res.clone().json(); } catch (_) {}
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => res.headers.get(name),
      body
    );
    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    const paidRes = await fetch(url, {
      headers: httpClient.encodePaymentSignatureHeader(paymentPayload),
    });
    if (!paidRes.ok) {
      const errBody = await paidRes.text().catch(() => paidRes.statusText);
      throw new Error(`HTTP ${paidRes.status}: ${errBody.slice(0, 200)}`);
    }
    return paidRes.json();
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  let httpClient;
  try {
    httpClient = buildHttpClient();
  } catch (e) {
    process.stderr.write("[imagegen-mcp] " + e.message + "\n");
    process.exit(1);
  }

  const server = new Server(
    { name: "imagegen-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      if (name !== "generate_image") throw new Error("Unknown tool: " + name);

      if (!args.prompt || typeof args.prompt !== "string" || !args.prompt.trim()) {
        throw new Error("prompt is required and must be a non-empty string");
      }

      const aspect = args.aspect || "1:1";
      const validAspects = ["1:1", "16:9", "9:16", "4:3"];
      if (!validAspects.includes(aspect)) {
        throw new Error(`Invalid aspect ratio '${aspect}'. Valid values: ${validAspects.join(", ")}`);
      }

      const url = `${BASE_URL}/generate?prompt=${encodeURIComponent(args.prompt.trim())}&aspect=${encodeURIComponent(aspect)}`;
      const data = await callPaid(httpClient, url);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            image_url: data.image_url,
            prompt: data.prompt,
            aspect: data.aspect,
            generated_at: data.generated_at || new Date().toISOString()
          }, null, 2)
        }]
      };
    } catch (e) {
      return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
