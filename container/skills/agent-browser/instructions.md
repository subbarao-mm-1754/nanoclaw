# Browser (public + authenticated)

You have `agent-browser` (Chromium) in this container.

## Before any login-required browsing

1. **Always** read `browser-sessions/index.json` if it exists (or call `list_browser_sessions`).
2. If a matching `origin` is listed, the login is **already done**:

```bash
agent-browser state load browser-sessions/<id>.json
agent-browser open <url>
agent-browser snapshot -i
```

3. **Never** reuse connect URLs from earlier chat messages.
4. Only call `request_browser_session` when index.json is missing / has no matching origin, or after a fresh `state load` + `open` the site still shows a login page.

## Browser dies between turns (common)

The gateway-saved cookies stay on disk. The **in-container** Chromium/daemon often stops between user messages (container recycle, idle timeout, crash, or an earlier `close`).

If **any** `agent-browser` command fails (connection error, daemon error, “browser not running”, timeouts):

```bash
agent-browser close --all 2>/dev/null || true
agent-browser state load browser-sessions/<id>.json
agent-browser open <the-page-you-need>
agent-browser snapshot -i
```

Then retry the action (reply, click, fill). **Do not** tell the user the Zoho/Desk login is “completely down” unless `state load` + `open` still lands on a login page — in that case call `request_browser_session`.

## While working

- Prefer **not** calling `agent-browser close` until the user’s request is fully done.
- Re-snapshot after navigation (`snapshot -i`) before clicking.
- After posting/important actions, optionally: `agent-browser state save browser-sessions/<id>.json`

## Public sites

```bash
agent-browser open https://example.com
agent-browser snapshot -i
```

## Rules

- Never ask for passwords or OTP.
- Prefer MCP/API tools when an integration exists.
- Do not print `browser-sessions/*.json` into chat.
