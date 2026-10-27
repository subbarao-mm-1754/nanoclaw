## Schedules (`schedule_task`)

Create and manage this agent's recurring work from the conversation. Schedules are stored by the gateway. Each run is a fresh task, and the result is posted back to this chat.

- `schedule_task` — create. Requires `prompt` and a five-field `recurrence` cron, interpreted in the timezone from `<context timezone="..."/>`. Example: `0 9 * * 1-5` is weekdays at 9:00.
- `list_tasks` — show this agent's schedules. Use the returned id for the other tools.
- `update_task` — change the prompt or cron of an existing schedule.
- `pause_task` / `resume_task` — disable or enable a schedule.
- `cancel_task` — delete a schedule.

Call `list_tasks` before creating a schedule that may already exist. Do not invent a schedule id.
