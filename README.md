# pi-telegram-tool-status

Companion extension for [`pi-telegram`](https://github.com/llblab/pi-telegram) that posts a compact service message to Telegram listing tools used by the agent.

## How it works

- **One service message per Telegram prompt** — created **lazily on the first tool call**.
- The message is edited in-place as new tools are executed (`tool_execution_start`).
- Ordinary agent replies are sent separately and never mixed with the service message.
- After `agent_end` the final message stays in chat for review.
- If the agent answers without tools, **no message is sent at all**.
- Only activates for **Telegram-originated turns** — console work is not mirrored.

## Demo

```
🛠 Tools used:

1. 📖 read — …/telegram/tool-status.ts
2. 📖 read — …/telegram/status.ts
3. ✏️ edit — …/telegram/tool-status.ts
4. 💻 bash — docker compose exec backend python manage.py migra…
5. ✏️ edit — …/telegram/tool-status.ts
6. ⚙️ mcp — gitlab-platform-2/list_merge…
```

## Install

### From npm (when published)

```bash
pi install npm:pi-telegram-tool-status
```

### From git

```bash
pi install git:github.com/Timur00Kh/pi-telegram-tool-status
```

### Manual (global)

Copy `index.ts` to `~/.pi/agent/extensions/pi-telegram-tool-status.ts`.

## Requirements

- [`pi-telegram`](https://github.com/llblab/pi-telegram) configured and connected (`/telegram-setup` + `/telegram-connect`).
- The extension activates **only** when:
  1. The current pi session owns the Telegram lock (`locks.json`).
  2. The current turn originated from Telegram (prompt prefixed with `[telegram]`).

## Features

| Feature | Description |
|---------|-------------|
| **Lazy creation** | Message appears only when the first tool is actually called. No empty messages for text-only replies. |
| **Telegram-only** | Does nothing for local console prompts. Only mirrors tool usage for Telegram-originated turns. |
| **In-place edits** | One message per prompt, continuously updated. No spam. |
| **Emoji icons** | 📖 read, 📝 write, ✏️ edit, 💻 bash, ⚙️ everything else. |
| **Smart truncation** | Paths truncated from the start (filename preserved), bash from the end (command start preserved), others minimal 50 chars. |
| **Bash path compression** | Long file paths inside bash commands are middle-truncated to keep both root and filename visible. |
| **Secret masking** | `Authorization`, `Bearer`, `token=`, env vars with `TOKEN`/`KEY`/`SECRET` are hidden. |
| **Hidden overflow** | If more than 15 tools — shows last 15 + `… N more actions hidden`. |
| **Auto-deactivation** | Extension does nothing if Telegram is not connected, the lock belongs to another process, or the turn is local. |

## License

MIT
