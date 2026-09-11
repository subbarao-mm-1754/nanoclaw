---
name: agent-browser
description: Browse the web for any task — research topics, read articles, interact with web apps, fill forms, take screenshots, extract data, and test web pages. Use whenever a browser would be useful, not just when the user explicitly asks.
allowed-tools: Bash(agent-browser:*)
---

# Browser Automation with agent-browser

Run every `agent-browser` command via **Bash** (not Skill `args`). After `state load`, always `open <url>` (load alone leaves a blank page). Prefer `open`/`reload` over `close --all` — closing blanks Live browser until the next `open`. Stream pin after `open` is automatic when live browser is enabled. Saved sessions: absolute `/workspace/agent/browser-sessions/<id>.json`.

## Quick start

```bash
agent-browser open <url>
agent-browser snapshot -i
agent-browser click @e1
agent-browser fill @e2 "text"
agent-browser close
```

## Core workflow

1. `agent-browser open <url>`
2. `agent-browser snapshot -i` (refs like `@e1`)
3. Interact with refs; re-snapshot after navigation

## Commands

### Navigation

```bash
agent-browser open <url>
agent-browser back | forward | reload | close
```

### Snapshot

```bash
agent-browser snapshot            # full tree
agent-browser snapshot -i         # interactive (recommended)
agent-browser snapshot -c         # compact
agent-browser snapshot -d 3       # depth limit
agent-browser snapshot -s "#main" # CSS scope
```

### Interactions

```bash
agent-browser click @e1
agent-browser dblclick @e1
agent-browser fill @e2 "text"
agent-browser type @e2 "text"
agent-browser press Enter
agent-browser hover @e1
agent-browser check @e1 | uncheck @e1
agent-browser select @e1 "value"
agent-browser scroll down 500
agent-browser upload @e1 file.pdf
```

### Get / capture / wait

```bash
agent-browser get text|html|value @e1
agent-browser get attr @e1 href
agent-browser get title | get url | get count ".item"
agent-browser screenshot [path.png] [--full]
agent-browser pdf output.pdf
agent-browser wait @e1 | 2000 | --text "…" | --url "**/…" | --load networkidle
```

### Find / auth / misc

```bash
agent-browser find role button click --name "Submit"
agent-browser state load /workspace/agent/browser-sessions/<id>.json
agent-browser state save /workspace/agent/browser-sessions/<id>.json
agent-browser cookies | cookies set name value | cookies clear
agent-browser storage local | storage local set k v
agent-browser eval "document.title"
```

Do not ask for passwords; use `request_browser_session` when login is needed or the session expired — even if `browser-sessions/index.json` already has an entry. Do not print `browser-sessions/*.json` into chat.
