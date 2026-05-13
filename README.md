# imagegen-mcp

MCP server for AI image generation, powered by [imagegen.coinopai.com](https://imagegen.coinopai.com). Payments are handled automatically via x402 micropayments on Base mainnet — no API keys, no subscriptions, just a funded wallet.

**Cost: $0.10 USDC per image** (Base mainnet)

## What it does

Exposes a single `generate_image` tool that any MCP-compatible client (Claude Desktop, Cursor, Windsurf, etc.) can call. When invoked, the server automatically pays the $0.10 USDC gate and returns a PNG image URL.

## Requirements

- Node.js 18+
- A Base wallet private key funded with USDC

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "imagegen": {
      "command": "npx",
      "args": ["-y", "imagegen-mcp"],
      "env": {
        "WALLET_PRIVATE_KEY": "0x<your-base-wallet-private-key>"
      }
    }
  }
}
```

## npx usage

```bash
WALLET_PRIVATE_KEY=0x<your-key> npx imagegen-mcp
```

## Tool reference

### `generate_image`

Generate an AI image from a text prompt.

**Inputs:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Natural language image description |
| `aspect` | string | No | `1:1` (default), `16:9`, `9:16`, `4:3` |

**Output:**

```json
{
  "image_url": "https://...",
  "prompt": "your prompt",
  "aspect": "1:1",
  "generated_at": "2026-05-13T00:00:00.000Z"
}
```

**Example prompts:**
- `"a cyberpunk wolf in neon rain"`
- `"a peaceful mountain lake at sunrise, photorealistic"`
- `"abstract geometric art, vibrant colors, 4K"`

## Cost disclosure

Each `generate_image` call costs **$0.10 USDC** deducted from your `WALLET_PRIVATE_KEY` wallet on Base mainnet. Use a purpose-built low-balance wallet, not your primary wallet.

$1 USDC ≈ 10 images.

## Smithery

Available on [Smithery](https://smithery.ai) — search for `imagegen-mcp`.

## License

MIT
