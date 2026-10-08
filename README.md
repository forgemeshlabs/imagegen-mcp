# forgemesh-imagegen

[![M8ven Verified](https://m8ven.ai/badge/mcp/forgemeshlabs-imagegen-mcp-5nc38d?variant=verified)](https://m8ven.ai/mcp/forgemeshlabs-imagegen-mcp-5nc38d)
[![mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/forgemeshlabs/imagegen-mcp)

**MCP server for AI image generation.** Generate images, remove backgrounds, upscale to 4x HD — all from a single MCP tool call. Payments handled automatically in USDC on Base mainnet via x402. No API key. No subscription. Pay per image.

Part of the [ForgeMesh](https://github.com/forgemeshlabs/forgemesh) ecosystem — infrastructure for autonomous agents.

---

## Tools

| Tool | What it does | Price |
|---|---|---|
| `generate_image` | Standard text-to-image generation | $0.25 USDC |
| `generate_clean` | Generate + background removal | $0.35 USDC |
| `generate_hd` | Premium generate + 4x upscale (HD) | $0.50 USDC |
| `generate_pro` | Top-tier generate + bg removal + 4x upscale | $0.75 USDC |
| `list_presets` | List the 58 identity-preserving transform presets (person or pet) | $0.005 USDC |
| `transform_image` | Transform a photo with a preset while keeping the subject's identity (FLUX Kontext Max) | $0.75 USDC |

The four `generate_*` tools accept `prompt` (required) and `aspect` (optional: `1:1`, `16:9`, `9:16`, `4:3`).
`transform_image` takes a public `image_url`, a `preset` id from `list_presets`, an optional `aspect` (`match_input_image` default, or `1:1`, `16:9`, `9:16`, `4:3`, `3:4`) and `wait` (default true: polls the free status URL until the PNG is ready, usually 15-30s). Submit only images you have rights to; no minors; the provider safety filter applies.

---

## Install

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "forgemesh-imagegen": {
      "command": "npx",
      "args": ["-y", "forgemesh-imagegen"],
      "env": {
        "WALLET_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add forgemesh-imagegen -- npx -y forgemesh-imagegen
```

Then set the env var:
```bash
export WALLET_PRIVATE_KEY=0x...
```

---

## Requirements

- A **dedicated, low-balance** Base mainnet wallet private key with USDC (never your primary wallet: the server signs USDC transfers autonomously)
- $1 USDC ≈ 4 base images, 2 clean, 2 HD, or 1 pro, or 1 transform
- No other API keys needed

Get USDC on Base: [Coinbase](https://coinbase.com) → Bridge to Base, or buy directly on Base.

---

## Example usage

```
generate_image(prompt="a red panda in a spacesuit", aspect="1:1")
→ { image_url: "https://...", prompt: "...", aspect: "1:1", tier: "image" }

generate_clean(prompt="a product photo of a ceramic mug")
→ { image_url: "https://...", tier: "clean" }   // transparent PNG

generate_hd(prompt="a futuristic city at night, cyberpunk style")
→ { image_url: "https://...", tier: "hd" }       // 4096x4096

generate_pro(prompt="a logo mark, geometric eagle")
→ { image_url: "https://...", tier: "pro" }      // transparent + HD

list_presets()
→ { count: 58, presets: [{ id: "pet-royal", title: "Pet Royalty", subject: "pet", ... }, ...] }

transform_image(image_url="https://example.com/my-dog.jpg", preset="pet-royal")
→ { job_id: "...", status: "succeeded", preset: "pet-royal", image_url: "https://..." }
```

---

## How it works

Each tool call makes an HTTP request to the ForgeMesh imagegen service gated by the [x402 protocol](https://x402.org). If payment is required, the MCP automatically signs and broadcasts a USDC transfer from your wallet on Base mainnet — then retries the request. You see the result, your wallet is charged, no manual steps.

- Network: Base mainnet (eip155:8453)
- Token: USDC
- Protocol: [x402](https://x402.org)
- The server only ever connects to `https://imagegen.coinopai.com`; every request has a 60s timeout and a 1 MB response cap; no third-party payment routers or affiliate hops.

---

## Links

- [ForgeMesh](https://github.com/forgemeshlabs/forgemesh) — ecosystem overview
- [npm](https://www.npmjs.com/package/forgemesh-imagegen)
- [x402 Protocol](https://x402.org)

---

## License

MIT © ForgeMesh Labs
