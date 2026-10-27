# Agent schedules

A schedule is a recurring job attached to one agent. The gateway keeps the clock and the job definition. When a run is due, it wakes that agent with a normal `task` message. The worker runs the container. The reply is delivered to the chat that the schedule was created from.

One agent can have many schedules. Each schedule has its own prompt, cron, timezone, delivery chat, and session. A morning summary and a Friday report do not share a transcript.

Chat creates and edits schedules. Agent Studio lists them and turns them on or off. Both sides use the same rows in `gateway.db`.

## What a schedule is

| Field | Meaning |
|-------|---------|
| Agent | The gateway workspace that will do the work |
| Prompt | Instructions for one run |
| Cron | Five fields, for example `0 9 * * 1-5` (weekdays at 09:00) |
| Timezone | IANA name, for example `Asia/Kolkata`. The cron is evaluated in this zone |
| Delivery | Channel, platform id, and optional thread where the result is posted |
| Enabled | `false` skips the schedule until it is turned back on |
| Next run | UTC timestamp of the next firing |

The schedule does not copy the agent's tools, secrets, or container config. Those stay on the workspace.

## Where the code lives

| Piece | Role |
|-------|------|
| `src/gateway/scheduling/executor.ts` | Gateway timer. Claims due schedules and enqueues `task` messages. Replaceable if another scheduler should own the clock later |
| `src/gateway/scheduling/store.ts` | `gateway_schedules` and `gateway_schedule_runs` |
| `src/gateway/scheduling/actions.ts` | Create, list, update, pause, resume, and cancel. Used by chat |
| `src/gateway/scheduling/cron.ts` | Five-field cron plus IANA timezone |
| `src/worker/schedule-actions.ts` | Forwards a container schedule request to the gateway |
| `src/worker/job-runner.ts` | Clears the previous schedule session before a new firing |
| `container/agent-runner/src/mcp-tools/scheduling.ts` | Tools the agent calls from chat |
| `container/agent-runner/src/formatter.ts` | Renders `kind: "task"` as a `<task>` block |

The classic host scheduler is not on this path. Session columns `process_after` and `recurrence` are not the schedule registry.

## Creating and changing a schedule from chat

The user talks to the agent in the normal channel (Cliq, Studio chat, or any other connected channel). The gateway does not parse the sentence. The agent calls a tool.

| User intent | Tool |
|-------------|------|
| Create | `schedule_task` with `prompt` and `recurrence` |
| Show the agent's schedules | `list_tasks` |
| Change the prompt or cron | `update_task` with the schedule id |
| Turn off / on | `pause_task` / `resume_task` |
| Delete | `cancel_task` |

The container cannot write `gateway.db`. Each tool writes a `messages_out` row with `kind: "system"` and `action: "schedule_request"`, then waits for a `schedule_response`. The worker outbound collector sees that system row and `POST`s `/v1/internal/schedules` on the gateway. The gateway applies the change and the worker writes the result back into the session's `inbound.db` for the tool to read.

On create, the gateway:

1. Checks the cron and timezone.
2. Opens a conversation with `channel_type = "schedule"` and `platform_id` set to the new schedule id. That conversation is the private session for this job.
3. Stores the prompt, cron, timezone, and the **current chat** as the delivery address. The agent does not choose another workspace or another chat.
4. Sets `next_run_at` to the next cron minute after now.

`list_tasks` returns one line per schedule: id, enabled or disabled, cron, timezone, next run, and the start of the prompt. Later edits use that id. If the user says "pause the morning summary", the agent lists first, matches the prompt and time, and passes that id. A call with an unknown id, or an id that belongs to another agent, returns "Schedule not found" and does not change anything.

Pause and resume set the same `enabled` flag that Studio uses.

## Agent Studio

Open an agent in Agent Studio. The Schedules section loads `GET /v1/agents/:workspaceId/schedules` and shows the prompt, cron, timezone, and next run. Enable and Disable call `PATCH /v1/agents/:workspaceId/schedules/:scheduleId` with `{ "enabled": true }` or `{ "enabled": false }`.

Studio does not create, edit, or delete schedules. Do that in chat.

## How a run fires

`src/gateway/index.ts` starts the schedule executor next to the message processor. The default interval is 30 seconds (`GATEWAY_SCHEDULER_INTERVAL_MS`).

Each tick does two things.

**Close finished runs.** For a run still marked `enqueued`:

- If its inbound message is `failed`, the run becomes `failed`.
- If its inbound message is gone, the run becomes `completed`. The processor deletes a message after a successful delivery.
- Either result clears `active_run_id`, which is the lock that blocks the next firing of that schedule.

**Fire what is due.** The tick asks SQLite for one row that is enabled, has no active run, and whose `next_run_at` is already due. It does not load every schedule. The claim is one transaction:

- Insert a `gateway_schedule_runs` row with status `claimed`.
- Set `active_run_id` on the schedule.
- Move `next_run_at` to the following cron slot, computed from now.

The next slot moves before the agent runs, so a slow run does not make the cron drift, and a second tick cannot send the same occurrence twice.

The executor then inserts a normal inbound message:

- `kind: "task"`
- content `{ prompt, scheduleId, runId }`
- conversation: the schedule's own session
- channel, platform, and thread: the delivery chat stored on the schedule

The run status becomes `enqueued`. The tick repeats until no due, unlocked schedule remains. If the insert fails, the run is marked `failed`, the lock is cleared, and the cron is left on the next slot.

If the gateway was down past a slot, that overdue row fires once on the next tick. `next_run_at` then jumps to the next future match. Missed hours in between are not replayed.

While a run's message is still `pending` or `processing`, `active_run_id` stays set. A later cron minute for that same schedule does not enqueue another run. A different schedule on the same agent has its own lock and can still fire.

## Gateway message processor

From the queue onward, a schedule firing is a normal inbound message. The processor claims it and calls the worker `process-message` API. Because `kind` is `task`, conversational auto-routing is skipped. The wake stays on the schedule's agent.

The worker request carries:

- `session.id` — the schedule conversation's session, not the user's live chat session
- `delivery` — the chat that should receive the reply
- `inbound.kind` — `task`
- `inbound.content.prompt` — the instructions for this run

## Worker and container

The worker writes that payload into the session's `inbound.db`. The session folder is:

```
data/v2-sessions/<agent_group_id>/<session_id>/inbound.db
data/v2-sessions/<agent_group_id>/<session_id>/outbound.db
```

Two schedules on one agent have two session folders. A live chat with that agent is a third session. They share the agent workspace, tools, and knowledge store. They do not share `inbound.db`.

Before writing a **new** schedule message, the worker clears that schedule's previous session: it stops a container still open for the session, deletes the session folder, and deletes that run's saved transcript. The new `task` row is the only message in the session, so earlier firings are not sent to the model again. A retry of the same message id does not clear the session. A `chat` message never clears a session, even if its JSON happens to contain a `scheduleId`.

The container poll loop reads pending `messages_in` rows. The formatter turns `kind: "task"` into:

```xml
<task time="...">
Instructions:
Check overnight errors and post a short summary.
</task>
```

`scheduleId` and `runId` stay in the JSON and are not shown to the model. The model uses the same tools and workspace as a chat turn. It replies with a normal `messages_out` chat row. Routing copied from the task sends that reply to the delivery chat.

The worker collector pushes the reply to the gateway. The gateway delivers it on the stored channel. When that callback deletes the inbound message, the scheduler's next reconcile marks the run `completed` and releases `active_run_id`.

The container is started with `--rm` and exits after the idle timeout (`IDLE_TIMEOUT`, default 30 minutes). A schedule that is waiting for tomorrow does not hold an agent process in memory.

## Several schedules on one agent

Each `schedule_task` call inserts another `gateway_schedules` row for the same workspace. There is no limit of one schedule per agent.

If two are due in the same tick, the executor claims one, enqueues its `task`, then claims the other. The message processor wakes the worker once per message. Each wake uses that schedule's session.

Overlap is per schedule. A digest that is still running does not block an hourly check on the same agent.

## HTTP API

Authenticated user session, same as other `/v1/agents` routes:

| Method | Path | Use |
|--------|------|-----|
| `GET` | `/v1/agents/:workspaceId/schedules` | List |
| `POST` | `/v1/agents/:workspaceId/schedules` | Create. Body: `prompt`, `cron_expression`, `timezone`, `delivery.channel_type`, `delivery.platform_id`, optional `delivery.thread_id` |
| `GET` | `/v1/agents/:workspaceId/schedules/:scheduleId` | Schedule plus run history |
| `PATCH` | `/v1/agents/:workspaceId/schedules/:scheduleId` | `{ "enabled": true \| false }` |
| `DELETE` | `/v1/agents/:workspaceId/schedules/:scheduleId` | Delete |

Chat does not call these directly. The worker calls `POST /v1/internal/schedules` with the worker auth token. The body is `{ workspaceId, op, ... }` where `op` is `create`, `list`, `update`, `cancel`, `pause`, or `resume`. `workspaceId` is the agent that is running, not a value supplied by the model.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `GATEWAY_SCHEDULER_INTERVAL_MS` | `30000` | How often the gateway looks for due schedules. Minimum 1000 |
| `TZ` | Process timezone, else `UTC` | Timezone the agent sees in chat context. Cron on a schedule uses the timezone stored on that schedule |
