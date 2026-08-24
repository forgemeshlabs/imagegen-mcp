#!/usr/bin/env node
"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { x402Client, x402HTTPClient } = require("@x402/core/client");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { toClientEvmSigner } = require("@x402/evm");
const { privateKeyToAccount } = require("viem/accounts");
const { createPublicClient, createWalletClient, http, parseAbi } = require("viem");
const { base } = require("viem/chains");

const BASE_URL = "https://imagegen.coinopai.com";
const VALID_ASPECTS = ["1:1", "16:9", "9:16", "4:3"];
const PYRIMID_ROUTER = "0xc949AEa380D7b7984806143ddbfE519B03ABd68B";
const PYRIMID_VENDOR_ID = "0x034604e25078e293d7b181fa23b3f2f6";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ROUTER_ABI = parseAbi([
  "function routePayment(bytes16 vendorId, uint256 productId, bytes16 affiliateId, address buyer, uint256 maxPrice) external",
]);
const USDC_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
]);
const PYRIMID_PRODUCTS = {
  "/generate": { productId: 3n, priceUsdc: 250000n },
};

const TOOLS = [
  {
    name: "generate_image",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: "Generate a standard AI image from a text prompt. Returns a PNG image URL. Costs $0.25 USDC on Base mainnet — paid automatically.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the image to generate" },
        aspect: { type: "string", enum: VALID_ASPECTS, description: "Aspect ratio — 1:1 (default), 16:9, 9:16, 4:3" },
        affiliate_id: { type: "string", description: "Optional Pyrimid affiliate ID. Affiliate earns a commission from within the listed price — no extra cost to you." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_clean",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: "Generate an AI image with background removed. Returns a transparent PNG URL. Costs $0.35 USDC on Base mainnet.",
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
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: "Generate a premium AI image upscaled 4x HD. Returns a high-resolution image URL. Costs $0.50 USDC on Base mainnet.",
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
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: "Generate a top-tier AI image with background removal and 4x HD upscale. Costs $0.75 USDC on Base mainnet.",
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
  generate_image: { path: "/generate", price: "$0.25" },
  generate_clean: { path: "/generate/clean", price: "$0.35" },
  generate_hd:    { path: "/generate/hd",    price: "$0.50" },
  generate_pro:   { path: "/generate/pro",   price: "$0.75" },
};

function buildHttpClient() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "WALLET_PRIVATE_KEY required — set a Base wallet private key funded with USDC.\n" +
      "  generate_image = $0.25 | generate_clean = $0.35 | generate_hd = $0.50 | generate_pro = $0.75"
    );
  }
  const pk = key.startsWith("0x") ? key : "0x" + key;
  const account = privateKeyToAccount(pk);
  const signer = toClientEvmSigner(account);
  const coreClient = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
  return { httpClient: new x402HTTPClient(coreClient), account };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callPyrimid(account, url, product, affiliateId) {
  const transport = http();
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ account, chain: base, transport });

  const approveHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "approve",
    args: [PYRIMID_ROUTER, product.priceUsdc],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  await sleep(3000);

  const routeHash = await walletClient.writeContract({
    address: PYRIMID_ROUTER,
    abi: ROUTER_ABI,
    functionName: "routePayment",
    args: [PYRIMID_VENDOR_ID, product.productId, "0x00000000000000000000000000000000", account.address, product.priceUsdc],
  });
  await publicClient.waitForTransactionReceipt({ hash: routeHash });
  await sleep(3000);

  const paidRes = await fetch(url.toString(), {
    headers: { "X-Affiliate-ID": affiliateId, "X-Payment": routeHash },
  });
  if (!paidRes.ok) {
    const errBody = await paidRes.text().catch(() => paidRes.statusText);
    throw new Error(`Pyrimid payment failed — HTTP ${paidRes.status}: ${errBody.slice(0, 200)}`);
  }
  return paidRes.json();
}

async function callPaid(ctx, path, params, affiliateId) {
  const { httpClient, account } = ctx;
  const url = new URL(BASE_URL + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const product = PYRIMID_PRODUCTS[path];
  if (!product) affiliateId = null;
  const extraHeaders = affiliateId ? { "X-Affiliate-ID": affiliateId } : {};

  if (affiliateId && product) {
    try {
      return await callPyrimid(account, url, product, affiliateId);
    } catch (_) {
      affiliateId = null;
    }
  }

  const directHeaders = affiliateId ? extraHeaders : {};
  const res = await fetch(url.toString(), { headers: directHeaders });

  if (res.status === 402) {
    let body;
    try { body = await res.clone().json(); } catch (_) {}
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => res.headers.get(name),
      body
    );
    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    const paidRes = await fetch(url.toString(), {
      headers: { ...httpClient.encodePaymentSignatureHeader(paymentPayload), ...directHeaders },
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
  let ctx;
  try {
    ctx = buildHttpClient();
  } catch (e) {
    process.stderr.write("[forgemesh-imagegen] " + e.message + "\n");
    process.exit(1);
  }

  const server = new Server(
    { name: "forgemesh-imagegen", version: "1.0.2" },
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

      const affiliateId = args.affiliate_id || process.env.PYRIMID_AFFILIATE_ID || null;
      const data = await callPaid(ctx, endpoint.path, {
        prompt: args.prompt.trim(),
        aspect,
      }, affiliateId);

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
