#!/usr/bin/env node
"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { x402Client, x402HTTPClient } = require("@x402/core/client");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { toClientEvmSigner } = require("@x402/evm");
const { privateKeyToAccount } = require("viem/accounts");

const BASE_URL = "https://imagegen.coinopai.com";
const VALID_ASPECTS = ["1:1", "16:9", "9:16", "4:3"];

const TOOLS = [
  {
    name: "generate_image",
    description: "Generate an AI image from a text prompt. Returns a PNG image URL. Costs $0.10 USDC on Base mainnet — paid automatically.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the image to generate" },
        aspect: { type: "string", enum: VALID_ASPECTS, description: "Aspect ratio — 1:1 (default), 16:9, 9:16, 4:3" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_clean",
    description: "Generate an AI image with the background removed. Returns a transparent PNG URL. Costs $0.15 USDC on Base mainnet.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the subject (background will be removed)" },
        aspect: { type: "string", enum: VALID_ASPECTS, description: "Aspect ratio — 1:1 (default), 16:9, 9:16, 4:3" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_hd",
    description: "Generate an AI image upscaled to 4x resolution. Returns a high-resolution image URL. Costs $0.20 USDC on Base mainnet.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the image to generate" },
        aspect: { type: "string", enum: VALID_ASPECTS, description: "Aspect ratio — 1:1 (default), 16:9, 9:16, 4:3" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_pro",
    description: "Generate an AI image with background removed AND upscaled 4x HD. The full pipeline. Costs $0.30 USDC on Base mainnet.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the subject (background removed, then upscaled)" },
        aspect: { type: "string", enum: VALID_ASPECTS, description: "Aspect ratio — 1:1 (default), 16:9, 9:16, 4:3" },
      },
      required: ["prompt"],
    },
  },
];

const TOOL_ENDPOINTS = {
  generate_image: { path: "/generate", price: "$0.10" },
  generate_clean: { path: "/generate/clean", price: "$0.15" },
  generate_hd:    { path: "/generate/hd",    price: "$0.20" },
  generate_pro:   { path: "/generate/pro",   price: "$0.30" },
};

function buildHttpClient() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "WALLET_PRIVATE_KEY required — set a Base wallet private key funded with USDC.\n" +
      "  generate_image = $0.10 | generate_clean = $0.15 | generate_hd = $0.20 | generate_pro = $0.30"
    );
  }
  const pk = key.startsWith("0x") ? key : "0x" + key;
  const account = privateKeyToAccount(pk);
  const signer = toClientEvmSigner(account);
  const coreClient = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
  return new x402HTTPClient(coreClient);
}

async function callPaid(httpClient, path, params) {
  const url = new URL(BASE_URL + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString());

  if (res.status === 402) {
    let body;
    try { body = await res.clone().json(); } catch (_) {}
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => res.headers.get(name),
      body
    );
    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    const paidRes = await fetch(url.toString(), {
      headers: httpClient.encodePaymentSignatureHeader(paymentPayload),
    });
    if (!paidRes.ok) {
      const errBody = await paidRes.text().catch(() => paidRes.statusText);
      throw new Error(`Payment failed — HTTP ${paidRes.status}: ${errBody.slice(0, 200)}`);
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
    process.stderr.write("[forgemesh-imagegen] " + e.message + "\n");
    process.exit(1);
  }

  const server = new Server(
    { name: "forgemesh-imagegen", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const endpoint = TOOL_ENDPOINTS[name];
      if (!endpoint) throw new Error("Unknown tool: " + name);

      if (!args.prompt || typeof args.prompt !== "string" || !args.prompt.trim()) {
        throw new Error("prompt is required and must be a non-empty string");
      }

      const aspect = args.aspect || "1:1";
      if (!VALID_ASPECTS.includes(aspect)) {
        throw new Error(`Invalid aspect ratio '${aspect}'. Valid: ${VALID_ASPECTS.join(", ")}`);
      }

      const data = await callPaid(httpClient, endpoint.path, {
        prompt: args.prompt.trim(),
        aspect,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            image_url: data.image_url,
            prompt: data.prompt,
            aspect: data.aspect,
            tier: name.replace("generate_", "") || "base",
            generated_at: data.generated_at || new Date().toISOString(),
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
