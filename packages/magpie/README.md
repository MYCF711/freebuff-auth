# magpie-freebuff-provider

Freebuff in [magpie](https://usemagpie.ai) and OpenCode — its free models
through the account's own browser sign-in, with a multi-account pool that
rotates when a daily quota runs out, and streaming tool calls.

Unofficial. Not affiliated with Codebuff or Freebuff.

## Install

```sh
magpie plugin add magpie-freebuff-provider
magpie plugin login freebuff
```

OpenCode, in `opencode.json`:

```json
{ "plugin": ["magpie-freebuff-provider"] }
```

then `opencode auth login`.

## Sign-in

**Browser sign-in.** Freebuff's login page opens; sign in and the account is
picked up. Repeat to add more accounts.

**Token.** Paste an existing Freebuff `authToken` (36-character UUID) from
`~/.config/manicode/credentials.json` → `default.authToken`. Sends nothing at
sign-in, so it works headless.

The sign-in is kept in magpie's credential store, one entry per account under
the `freebuff` provider. The password is never stored — the token is.

## Models

Captured from the account's catalog at call time. Locked (paid-plan) rows are
filtered out. The four `0fb` models cost no freebucks but still consume one of
the day's session windows; the `5fb`–`20fb` models spend freebucks.

Tool calls stream through: `tools`, `tool_choice` and `parallel_tool_calls` are
passed to Freebuff, and `tool_calls` come back as standard OpenAI deltas.

## Quota

1. **5 freebucks = one hour**, fixed and non-refundable.
2. **25 freebucks a day**, resetting at Pacific midnight (≈15:00 Beijing).
3. **One premium session per account at a time.**

The plugin never opens a session it cannot pay for. `0fb` models stay openable
even at zero balance.

## Troubleshooting

| What you see | What it means |
|---|---|
| `403 free_mode_cli_required` | The request did not look like the official CLI's. |
| `403 account_suspended` | Suspended, not rate-limited. Stop and appeal. |
| `402 Out of credits` | Daily freebucks gone; resets at Pacific midnight. |
| `409 session_model_mismatch` | Session opened for another model; re-opened automatically. |
| `429 rate_limited` | Per-model daily count; `retryAfterMs` says how long. |

## License

MIT.
