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
const TRANSFORM_ASPECTS = ["match_input_image", "1:1", "16:9", "9:16", "4:3", "3:4"];
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_PROMPT_CHARS = 2_000;

const GENERATE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const promptSchema = (subject) => ({
  type: "object",
  properties: {
    prompt: { type: "string", maxLength: MAX_PROMPT_CHARS, description: subject },
    aspect: { type: "string", enum: VALID_ASPECTS, description: "Aspect ratio — 1:1 (default), 16:9, 9:16, 4:3" },
  },
  required: ["prompt"],
});

const TOOLS = [
  {
    name: "generate_image",
    annotations: GENERATE_ANNOTATIONS,
    description: "Generate a standard AI image from a text prompt. Returns a PNG image URL. Costs $0.25 USDC on Base mainnet — paid automatically.",
    inputSchema: promptSchema("Text description of the image to generate"),
  },
  {
    name: "generate_clean",
    annotations: GENERATE_ANNOTATIONS,
    description: "Generate an AI image with background removed. Returns a transparent PNG URL. Costs $0.35 USDC on Base mainnet.",
    inputSchema: promptSchema("Text description of the subject (background will be removed)"),
  },
  {
    name: "generate_hd",
    annotations: GENERATE_ANNOTATIONS,
    description: "Generate a premium AI image upscaled 4x HD. Returns a high-resolution image URL. Costs $0.50 USDC on Base mainnet.",
    inputSchema: promptSchema("Text description of the image to generate"),
  },
  {
    name: "generate_pro",
    annotations: GENERATE_ANNOTATIONS,
    description: "Generate a top-tier AI image with background removal and 4x HD upscale. Costs $0.75 USDC on Base mainnet.",
    inputSchema: promptSchema("Text description of the subject (background removed, then upscaled)"),
  },
  {
    name: "list_presets",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "List the 58 identity-preserving transform presets for transform_image (action figure, pet royalty, CEO portrait, cartoon villain, fantasy poster, pet astronaut, ...). Returns id, title, tagline and whether each expects a person or a pet photo. Costs $0.005 USDC on Base mainnet.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "transform_image",
    annotations: GENERATE_ANNOTATIONS,
    description: "Transform a photo with a named preset while keeping the subject's identity (FLUX Kontext Max image-to-image). Pass a public https image URL and a preset id from list_presets. Returns a job with a free status_url to poll until the PNG is ready (usually 15-30s). Costs $0.75 USDC on Base mainnet. Submit only images you have rights to; no minors; provider safety filter applies.",
    inputSchema: {
      type: "object",
      properties: {
        image_url: { type: "string", format: "uri", maxLength: 2048, description: "Public https URL of the source photo (JPEG, PNG or WebP)" },
        preset: { type: "string", pattern: "^[a-z0-9-]{1,64}$", description: "Preset id from list_presets, e.g. action-figure, pet-royal, ceo-portrait" },
        aspect: { type: "string", enum: TRANSFORM_ASPECTS, description: "Output aspect (default match_input_image)" },
        wait: { type: "boolean", description: "Poll the job until it finishes and return the final image_url (default true, up to ~90s)" },
      },
      required: ["image_url", "preset"],
    },
  },
];

const TOOL_ENDPOINTS = {
  generate_image:  { path: "/generate", price: "$0.25" },
  generate_clean:  { path: "/generate/clean", price: "$0.35" },
  generate_hd:     { path: "/generate/hd",    price: "$0.50" },
  generate_pro:    { path: "/generate/pro",   price: "$0.75" },
  list_presets:    { path: "/presets",        price: "$0.005" },
  transform_image: { path: "/transform",      price: "$0.75" },
};

function buildHttpClient() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "WALLET_PRIVATE_KEY required — set a dedicated, low-balance Base wallet private key funded with USDC.\n" +
      "  generate_image = $0.25 | generate_clean = $0.35 | generate_hd = $0.50 | generate_pro = $0.75 | transform_image = $0.75"
    );
  }
  const pk = key.startsWith("0x") ? key : "0x" + key;
  const account = privateKeyToAccount(pk);
  const signer = toClientEvmSigner(account);
  const coreClient = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
  return { httpClient: new x402HTTPClient(coreClient), account };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every outbound request: bounded time, bounded body, same-origin only.
async function fetchBounded(url, init = {}) {
  const target = new URL(String(url));
  if (target.origin !== BASE_URL) throw new Error(`Refusing to call ${target.origin}; this server only talks to ${BASE_URL}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(target.toString(), { ...init, signal: ctrl.signal, redirect: "error" });
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_RESPONSE_BYTES) throw new Error(`Response too large (${declared} bytes)`);
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("Response too large");
    return { status: res.status, ok: res.ok, headers: res.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text, status) {
  try { return JSON.parse(text); } catch { throw new Error(`HTTP ${status}: non-JSON response`); }
}

async function callPaid(ctx, path, params) {
  const { httpClient } = ctx;
  const url = new URL(BASE_URL + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetchBounded(url);
  if (res.status === 402) {
    let body;
    try { body = JSON.parse(res.text); } catch { body = undefined; }
    const paymentRequired = httpClient.getPaymentRequiredResponse((name) => res.headers.get(name), body);
    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    const paid = await fetchBounded(url, { headers: httpClient.encodePaymentSignatureHeader(paymentPayload) });
    if (!paid.ok) throw new Error(`Payment failed — HTTP ${paid.status}: ${paid.text.slice(0, 200)}`);
    return parseJson(paid.text, paid.status);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  return parseJson(res.text, res.status);
}

function requirePrompt(args) {
  if (!args || typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt is required and must be a non-empty string");
  if (args.prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt must be at most ${MAX_PROMPT_CHARS} characters`);
  const aspect = args.aspect || "1:1";
  if (!VALID_ASPECTS.includes(aspect)) throw new Error(`Invalid aspect ratio '${aspect}'. Valid: ${VALID_ASPECTS.join(", ")}`);
  return { prompt: args.prompt.trim(), aspect };
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
    { name: "forgemesh-imagegen", version: require("./package.json").version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const endpoint = TOOL_ENDPOINTS[name];
      if (!endpoint) throw new Error("Unknown tool: " + name);

      if (name === "list_presets") {
        const data = await callPaid(ctx, endpoint.path, null);
        return { content: [{ type: "text", text: JSON.stringify({ count: data.count, presets: data.presets, usage: data.usage, terms: data.terms }, null, 2) }] };
      }

      if (name === "transform_image") {
        if (typeof args.image_url !== "string" || !/^https:\/\/[^\s]{1,2040}$/.test(args.image_url)) throw new Error("image_url must be a public https URL");
        if (typeof args.preset !== "string" || !/^[a-z0-9-]{1,64}$/.test(args.preset)) throw new Error("preset must be a preset id from list_presets");
        const taspect = args.aspect || "match_input_image";
        if (!TRANSFORM_ASPECTS.includes(taspect)) throw new Error(`Invalid aspect '${taspect}'. Valid: ${TRANSFORM_ASPECTS.join(", ")}`);
        const job = await callPaid(ctx, endpoint.path, { image_url: args.image_url, preset: args.preset, aspect: taspect });
        let result = job;
        if (args.wait !== false && typeof job.status_url === "string") {
          for (let i = 0; i < 30 && !["succeeded", "failed"].includes(result.status); i++) {
            await sleep(3000);
            const poll = await fetchBounded(job.status_url);
            if (poll.ok) result = { ...job, ...parseJson(poll.text, poll.status) };
          }
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ job_id: result.job_id, status: result.status, preset: job.preset, image_url: result.image_url || null, error: result.error || null, status_url: job.status_url }, null, 2) }],
          isError: result.status === "failed",
        };
      }

      const { prompt, aspect } = requirePrompt(args);
      const data = await callPaid(ctx, endpoint.path, { prompt, aspect });
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
