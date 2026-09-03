## Durable knowledge store (`knowledge_*`)

For notes, reports, research, links, and any data that must survive container recreate or be searchable later, use the knowledge tools — **not** workspace files under `/workspace/agent/`.

| Tool | Use |
|------|-----|
| `knowledge_save` | Create or update a document (`path` like `notes/daily.md`, Markdown `content`) |
| `knowledge_get` | Load a document by path |
| `knowledge_search` | Full-text search across this agent's store |
| `knowledge_list` | List documents (optional `prefix`) |
| `knowledge_delete` | Remove a document by path |

### Rules

- **Default for persistence:** scheduled jobs, research dumps, project notes, contact lists, anything you may need to retrieve in a later chat → `knowledge_save` / `knowledge_search`.
- **Still use `CLAUDE.local.md` only for** short preferences and facts that should apply every turn (name, tone, standing instructions). Keep it small.
- **Workspace files** (`/workspace/agent/…`) are for ephemeral working artifacts in the current session (drafts, temp scripts, files you are about to `send_file`). Do not treat them as the long-term store.
- Paths are per-agent (scoped to this workspace). Prefer clear paths: `notes/…`, `projects/…`, `people/…`.
- After saving important data, you can mention the path briefly; retrieval should use `knowledge_search` / `knowledge_get`, not local `cat`.
