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

const UUID_RE_SRC = "^[0-9a-fA-F-]{36}$";
const GENERATE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const RETRY_CREDIT_DESC = "Optional retry credit: the retry_credit value (a job id) from a failed job's status. Redeems one free retry of the same route (single use, 72 hours, bound to the paying wallet, no new payment). Only issued for failures on the service's side (infrastructure or model host).";
const WAIT_DESC = "Poll the job until it finishes and return the final image_url (default true, up to ~90s). Set false to get the job_id and status_url immediately.";
const promptSchema = (subject, job) => ({
  type: "object",
  properties: {
    prompt: { type: "string", maxLength: MAX_PROMPT_CHARS, description: subject },
    aspect: { type: "string", enum: VALID_ASPECTS, description: "Aspect ratio — 1:1 (default), 16:9, 9:16, 4:3" },
    ...(job ? { wait: { type: "boolean", description: WAIT_DESC }, retry_credit: { type: "string", pattern: UUID_RE_SRC, description: RETRY_CREDIT_DESC } } : {}),
  },
  required: ["prompt"],
});

const TOOLS = [
  {
    name: "generate_image",
    annotations: GENERATE_ANNOTATIONS,
    description: "Image generation: text prompt to image (text-to-image) with FLUX Schnell. Pass prompt and optional aspect (1:1, 16:9, 9:16 or 4:3). Returns JSON in one synchronous call with image_url (stored 7 days on the service), expires_at, prompt, aspect, model and generated_at. Prompt is required. Use it for illustrations, thumbnails, mockups, concept art and social images. A render not finished within 85 seconds is a 504 and is not charged. Costs $0.05 USDC on Base mainnet, paid automatically.",
    inputSchema: promptSchema("Text description of the image to generate"),
  },
  {
    name: "generate_clean",
    annotations: GENERATE_ANNOTATIONS,
    description: "Image generation with transparent background: text prompt to image with FLUX Schnell, then automatic background removal. Returns image_url (transparent PNG cutout, stored 7 days) with expires_at, prompt, aspect, tier, model and generated_at. Prompt is required. Use it for product cutouts, stickers and logo marks. Costs $0.35 USDC on Base mainnet.",
    inputSchema: promptSchema("Text description of the subject (background will be removed)"),
  },
  {
    name: "generate_hd",
    annotations: GENERATE_ANNOTATIONS,
    description: "High-resolution image generation: text prompt to image with FLUX 1.1 Pro plus a 4x Real-ESRGAN upscale, run as an async job. The paid call returns an async job (job_id, status, status_url); this tool polls the free status_url until it succeeds and returns image_url (stored 7 days) with expires_at (wait=false returns the job immediately). If the job fails on the service's side (infrastructure or model host), the result carries a retry_credit: pass it as retry_credit to redo the same request once for free (72 hours, single use, same wallet). Failures without a retry_credit (e.g. a safety rejection or an unclear failure after payment) get no automatic retry and are logged for manual review (hello@forgemesh.io, quote the job id). Costs $0.10 USDC on Base mainnet.",
    inputSchema: promptSchema("Text description of the image to generate", true),
  },
  {
    name: "generate_pro",
    annotations: GENERATE_ANNOTATIONS,
    description: "Premium image generation: text prompt to image with FLUX Kontext Max, background removal and a 4x upscale, run as an async job. The paid call returns an async job (job_id, status, status_url); this tool polls the free status_url until it succeeds and returns image_url (transparent, high-resolution, stored 7 days) with expires_at (wait=false returns the job immediately). If the job fails on the service's side (infrastructure or model host), the result carries a retry_credit: pass it as retry_credit to redo the same request once for free (72 hours, single use, same wallet). Failures without a retry_credit (e.g. a safety rejection or an unclear failure after payment) get no automatic retry and are logged for manual review (hello@forgemesh.io, quote the job id). Costs $0.75 USDC on Base mainnet.",
    inputSchema: promptSchema("Text description of the subject (background removed, then upscaled)", true),
  },
  {
    name: "list_presets",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Photo transform presets: list the 58 identity-preserving image-to-image styles for transform_image (action figure, pet royalty, CEO portrait, cartoon villain, fantasy poster, pet astronaut, ...). Returns id, title, tagline and whether each expects a person or a pet photo. Costs $0.005 USDC on Base mainnet.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "transform_image",
    annotations: GENERATE_ANNOTATIONS,
    description: "Photo transform (image-to-image): restyle a photo with a named preset while keeping the subject's identity, using FLUX Kontext Max. Pass a public https image URL and a preset id from list_presets. An unreachable or non-image URL (or an unknown preset or aspect) is refused before payment and is not charged. Returns a job with a free status_url, polled until the PNG is ready (usually 15-30s), then image_url (stored 7 days) with expires_at. If the render fails on the service's side (infrastructure or model host), the result carries a retry_credit: pass it as retry_credit to redo the same request once for free (72 hours, single use, same wallet). An image the safety filter declines after payment, or any other unclear failure, earns no automatic retry; it is logged for manual review (hello@forgemesh.io, quote the job id). Costs $0.75 USDC on Base mainnet. Submit only images you have rights to; no minors; provider safety filter applies.",
    inputSchema: {
      type: "object",
      properties: {
        image_url: { type: "string", format: "uri", maxLength: 2048, description: "Public https URL of the source photo (JPEG, PNG or WebP)" },
        preset: { type: "string", pattern: "^[a-z0-9-]{1,64}$", description: "Preset id from list_presets, e.g. action-figure, pet-royal, ceo-portrait" },
        aspect: { type: "string", enum: TRANSFORM_ASPECTS, description: "Output aspect (default match_input_image)" },
        wait: { type: "boolean", description: WAIT_DESC },
        retry_credit: { type: "string", pattern: UUID_RE_SRC, description: RETRY_CREDIT_DESC },
      },
      required: ["image_url", "preset"],
    },
  },
];

const ASYNC_TOOLS = new Set(["generate_hd", "generate_pro"]);
const TOOL_ENDPOINTS = {
  generate_image:  { path: "/generate", price: "$0.05" },
  generate_clean:  { path: "/generate/clean", price: "$0.35" },
  generate_hd:     { path: "/generate/hd",    price: "$0.10" },
  generate_pro:    { path: "/generate/pro",   price: "$0.75" },
  list_presets:    { path: "/presets",        price: "$0.005" },
  transform_image: { path: "/transform",      price: "$0.75" },
};

function buildHttpClient() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "WALLET_PRIVATE_KEY required — set a dedicated, low-balance Base wallet private key funded with USDC.\n" +
      "  generate_image = $0.05 | generate_clean = $0.35 | generate_hd = $0.10 | generate_pro = $0.75 | transform_image = $0.75"
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
  if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, v); });

  const res = await fetchBounded(url);
  if (res.status === 402) {
    let body;
    try { body = JSON.parse(res.text); } catch { body = undefined; }
    const paymentRequired = httpClient.getPaymentRequiredResponse((name) => res.headers.get(name), body);
    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    const paid = await fetchBounded(url, { headers: httpClient.encodePaymentSignatureHeader(paymentPayload) });
    if (!paid.ok) throw refusalError(paid, true);
    return parseJson(paid.text, paid.status);
  }
  if (!res.ok) throw refusalError(res, false);
  return parseJson(res.text, res.status);
}

// Surface the service's own refusal: HTTP status, charged flag, reason text, Retry-After.
function refusalError(res, paidAttempt) {
  let body; try { body = JSON.parse(res.text); } catch { body = undefined; }
  let charged;
  if (body && typeof body === "object" && typeof body.charged === "boolean") charged = body.charged;
  else if (!paidAttempt) charged = false;
  else charged = res.headers.get("payment-response") || res.headers.get("x-payment-response") ? true : "unknown (no settlement receipt)";
  const reason = body && typeof body === "object" ? (body.error || body.reason || body.message || body.invalidReason) : undefined;
  const retryAfter = res.headers.get("retry-after");
  // Fixed message (status, charged, optional short error code); the service body travels only as capped data.
  const code = typeof reason === "string" && /^[a-z0-9_.:-]{1,64}$/i.test(reason) ? `: ${reason}` : "";
  const err = new Error(`HTTP ${res.status} (charged:${charged})${retryAfter ? ` retry-after:${retryAfter}s` : ""}${code}`);
  err.status = res.status;
  err.charged = charged;
  const raw = body && typeof body === "object" ? JSON.stringify(body) : res.text;
  err.upstream = body && typeof body === "object" && raw.length <= 1500 ? body : raw.slice(0, body && typeof body === "object" ? 1500 : 500);
  return err;
}

// Poll a job's free status_url until it succeeds or fails (up to ~90s).
async function pollJob(job) {
  let result = job;
  for (let i = 0; i < 30 && !["succeeded", "failed"].includes(result.status); i++) {
    await sleep(3000);
    const poll = await fetchBounded(job.status_url);
    if (poll.ok) result = { ...job, ...parseJson(poll.text, poll.status) };
  }
  return result;
}

// Shape an async job for the tool result, with the service's retry/manual-review guidance on failure.
function jobResult(job, result) {
  const out = {
    job_id: result.job_id, status: result.status, tier: result.tier || job.tier, preset: job.preset,
    image_url: result.image_url || null, expires_at: result.expires_at || null,
    error: result.error || null, status_url: job.status_url,
  };
  if (result.retry_credit) out.retry_credit = result.retry_credit;
  if (result.status === "failed") {
    out.note = result.retry_credit
      ? "Failed on the service's side. Call this tool again with the same arguments plus retry_credit set to the value above for one free retry (single use, 72 hours, same wallet, no new payment)."
      : "Failed with no retry_credit: no automatic retry. Safety rejections and unclear failures after payment are logged for manual review (hello@forgemesh.io, quote the job_id).";
  } else if (!["succeeded"].includes(result.status)) {
    out.note = "Job not finished yet; poll status_url (free) until status is succeeded or failed.";
  }
  return out;
}

function parseRetryCredit(args, account) {
  if (args.retry_credit === undefined) return {};
  if (typeof args.retry_credit !== "string" || !/^[0-9a-fA-F-]{36}$/.test(args.retry_credit)) throw new Error("retry_credit must be the job id (uuid) from a failed job's retry_credit");
  return { retry_credit: args.retry_credit, wallet: account.address };
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
        const job = await callPaid(ctx, endpoint.path, { image_url: args.image_url, preset: args.preset, aspect: taspect, ...parseRetryCredit(args, ctx.account) });
        const result = args.wait !== false && typeof job.status_url === "string" ? await pollJob(job) : job;
        return {
          content: [{ type: "text", text: JSON.stringify(jobResult(job, result), null, 2) }],
          isError: result.status === "failed",
        };
      }

      const { prompt, aspect } = requirePrompt(args);
      if (ASYNC_TOOLS.has(name)) {
        const job = await callPaid(ctx, endpoint.path, { prompt, aspect, ...parseRetryCredit(args, ctx.account) });
        const result = args.wait !== false && typeof job.status_url === "string" ? await pollJob(job) : job;
        return {
          content: [{ type: "text", text: JSON.stringify(jobResult(job, result), null, 2) }],
          isError: result.status === "failed",
        };
      }
      const data = await callPaid(ctx, endpoint.path, { prompt, aspect });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            image_url: data.image_url,
            expires_at: data.expires_at || null,
            model: data.model,
            prompt: data.prompt,
            aspect: data.aspect,
            tier: name.replace("generate_", "") || "base",
            generated_at: data.generated_at || new Date().toISOString(),
          }, null, 2),
        }],
      };
    } catch (e) {
      if (e && e.status !== undefined) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e.message, status: e.status, charged: e.charged, upstream: e.upstream, untrusted: true }) }], isError: true };
      }
      return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
