# v0.3.0-beta.1 — Freebuff for magpie and DeepSeek Harness

Freebuff's free models in magpie and DeepSeek Harness, through the account's own
browser sign-in — with a multi-account pool that rotates when a daily quota runs
out, and streaming tool calls.

Unofficial. Not affiliated with Codebuff or Freebuff.

## Install

Published to npm as `@beta`, and attached below as tarballs.

### From npm

```sh
# magpie / OpenCode
magpie plugin add magpie-freebuff-provider@beta
magpie plugin login freebuff
```

```sh
# DeepSeek Harness
dsh plugin --profile desktop add dsh-freebuff-provider@beta
npx freebuff-gateway
```

`freebuff-core` is the shared protocol layer. It is **inlined inside both
packages**, so you do not install it separately — see "Why core is inlined".

### From the tarballs below

Same packages, for when npm is unreachable:

```sh
# magpie
magpie plugin add ./magpie-freebuff-provider-0.3.0-beta.1.tgz

# DSH
dsh plugin --profile desktop add ./dsh-freebuff-provider-0.3.0-beta.1.tgz
```

Verify them first:

```sh
sha256sum -c SHA256SUMS.txt
```

### From source

```sh
git clone https://github.com/MYCF711/freebuff-auth
cd freebuff-auth && npm install && npm test
```

## Point DSH at the gateway

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
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
export FREEBUFF_LOCAL_KEY=local-freebuff
```

Or generate the block:

```js
import { patchEntry } from 'dsh-freebuff-provider'
console.log(JSON.stringify(patchEntry(8937), null, 2))
```

## What works

- **Browser sign-in** and **token sign-in** (paste an existing `authToken`)
- **Multi-account pool** with automatic rotation when a daily quota runs out
- **Live model catalog** captured from the account, paid-plan rows filtered out
- **Streaming tool calls** — `tools`, `tool_choice` and `parallel_tool_calls` are
  passed through; `tool_calls` come back as standard OpenAI deltas
- **Quota guard** — a session is never opened for a model the balance cannot pay
  for, and `0fb` models stay openable at zero balance

## Models

| id | Price | Notes |
|---|---|---|
| `solar-pro4` | 0fb | Unlimited tier, 1M context, images |
| `solar-mini-4` | 0fb | Unlimited tier |
| `nemotron-3.5-lightning` | 0fb | Unlimited tier |
| `glyph-cluster` | 0fb | Unlimited tier, **can take minutes per reply** |
| `mimo-v2.6-flash-slow` | 5fb | |
| `mimo-v2.6-flash-fast` | 10fb | |
| `deepseek-v4.1-flash` | 15fb | Recommended by Freebuff |
| `glm-5.3-flash` | 20fb | |

`0fb` models cost no freebucks but still consume one of the day's session
windows.

## Quota

1. **5 freebucks = one hour**, fixed and non-refundable.
2. **25 freebucks a day**, resetting at Pacific midnight (≈15:00 Beijing) — at
   most 5 sessions per account per day.
3. **One premium session per account at a time.**

## Two warnings worth reading

**Do not run both hosts on one Freebuff account.** Freebuff allows a single
session per account, so magpie and the DSH gateway will take each other's session
away and you will see a stream of `409`s. Use one, or sign a different account
into each.

**Each shell generates its own Ed25519 device key**, so one account talking
through both looks like two machines — one of the patterns that gets an account
flagged.

## Why core is inlined

`magpie-freebuff-provider` and `dsh-freebuff-provider` each carry a copy of
`freebuff-core` under their own `core/` directory rather than depending on it.

Reason: magpie's `plugin add` installs a tarball **without resolving its
dependencies**. A package that imports `freebuff-core` at load time fails with
`exports no OpenCode plugin function` when core is absent. Inlining costs about
30 KB of duplication and buys a single self-contained tarball.

`packages/core` in the repo stays the single source; `scripts/inline-core.mjs`
copies it in before packing.

## Not yet verified on a live account

The tool-calling path is implemented and covered by 38 assertions (26 in-repo,
12 after installing the tarballs into a scratch directory), and the wire format
was checked against Freebuff's own client — its `openai-compatible` adapter emits
`role:"tool"` with an underscore `tool_call_id`, exactly what this writes.

What has **not** been exercised is a real end-to-end tool call against a live
Freebuff account: the account available during development is suspended. Treat
tool calling as implemented-and-tested-in-isolation rather than proven.

## Tests

```
scripts/test.mjs            26 assertions   workspace
scripts/test-installed.mjs  12 assertions   after tgz install
scripts/verify-final.mjs    12 assertions   final
```

```sh
npm test
node scripts/verify-final.mjs
```

## License

MIT.
