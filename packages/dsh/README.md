# dsh-freebuff-provider

Freebuff in [DeepSeek Harness](https://github.com/yetone) — a local
OpenAI-compatible endpoint that serves Freebuff's free models with a
multi-account pool and streaming tool calls.

Unofficial. Not affiliated with Codebuff or Freebuff.

## Install

```sh
dsh plugin --profile desktop add dsh-freebuff-provider
```

## Run the gateway

```sh
npx freebuff-gateway
```

It listens on `127.0.0.1:8937` and exposes:

```
GET  /v1/models
POST /v1/chat/completions     tools / tool_choice / stream supported
GET  /healthz
GET  /freebuff/usage          freebucks balance and daily allowance
```

Needs credentials from a Freebuff sign-in. The gateway reads
`~/.config/manicode/device-key.json` and `credentials.json`, written by the
official CLI after one sign-in.

```sh
set FREEBUFF_HOME=D:\path\to\freebuff-mac   # optional
set FREEBUFF_GATEWAY_PORT=8937              # optional
```

## Point DSH at it

Add to `~/.dsh/profiles/<name>/cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      freebuff:
        displayName: Freebuff
        apiKeyEnv: FREEBUFF_LOCAL_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:8937/v1
        models:
          - id: freebuff/solar-pro4
            name: Solar Pro 4 · 0fb
            contextWindow: 1048576
            maxTokens: 32768
            input: [text, image]
```

```sh
set FREEBUFF_LOCAL_KEY=local-freebuff
```

Generate that block instead of writing it by hand:

```js
import { patchEntry } from 'dsh-freebuff-provider'
console.log(JSON.stringify(patchEntry(8937), null, 2))
```

## Which models

| id | Price | Notes |
|---|---|---|
| `freebuff/solar-pro4` | 0fb | Unlimited tier, 1M context, images |
| `freebuff/solar-mini-4` | 0fb | Unlimited tier |
| `freebuff/nemotron-3.5-lightning` | 0fb | Unlimited tier |
| `freebuff/glyph-cluster` | 0fb | Unlimited tier, **can take minutes per reply** |
| `freebuff/mimo-v2.6-flash-slow` | 5fb | |
| `freebuff/mimo-v2.6-flash-fast` | 10fb | |
| `freebuff/deepseek-v4.1-flash` | 15fb | Recommended by Freebuff |
| `freebuff/glm-5.3-flash` | 20fb | |

`0fb` models cost no freebucks but still consume one of the day's session
windows. `glyph-cluster` is not suitable for interactive use.

## Don't share an account with magpie

Freebuff allows one session per account. Running this gateway and
`magpie-freebuff-provider` on the same Freebuff account makes them take each
other's session away. Use one, or use two accounts.

## License

MIT.
