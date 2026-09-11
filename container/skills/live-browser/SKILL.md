---
name: live-browser
description: When LIVE_BROWSER_ENABLED, the owner can watch and take over your Chromium via the Gateway Live browser UI. Honor live_browser_control system messages.
---

# Live browser handoff

The owner may open **Live browser** in Agent Studio and share your `agent-browser` session (same cookies and page).

## Keep the stream reachable

When live browser is enabled, `agent-browser open` **auto-pins** the screencast stream (wrapper on PATH). You do not need to run `stream enable` yourself.

Still required:

- After `state load`, always `open <url>` — load alone does not navigate and leaves Live browser white/`about:blank`.
- Avoid `close --all` unless Chromium is dead; it blanks the owner's Live browser until the next successful `open`.
- Use the **same** session for browsing (default unless you already use a named `--session`).

## System messages

You may receive inbound system JSON:

```json
{ "type": "live_browser_control", "state": "human" | "agent", "text": "..." }
```

- **`state: "human"`** — Stop using `agent-browser` until you get `state: "agent"`. Do not close the browser. Wait.
- **`state: "agent"`** — Human finished. Run `agent-browser snapshot -i` on the current page and continue the task. Do not re-login unless the page shows logged-out.

Never ask for passwords; use `request_browser_session` for first-time site login as usual.
