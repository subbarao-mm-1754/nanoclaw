# Browser

Use **Bash** for every `agent-browser` command (Skill alone does not run them).

- Sessions: `/workspace/agent/browser-sessions/<id>.json` (absolute path; read `index.json` or `list_browser_sessions` first)
- Auth site: `state load` → `open <url>` → `get url` → `snapshot -i`
- Prefer **re-`open` / `reload`** over `close --all`. `close --all` blanks the Live browser view until you open again.
- Only if the browser is dead: `close --all` → `state load` → `open <url>` → `get url` → `snapshot -i`
- Stream pinning after `open` is automatic when live browser is enabled — do not skip `open` after `state load`
- If `get url` is a login/signin page or the site says session expired: call **`request_browser_session`** (even when `index.json` already lists that origin — cookies may be stale). Never ask for passwords.
- Do not print session JSON; do not reuse old connect URLs
