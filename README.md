<picture>
  <img src="https://cdn.wolffi.sh/general/ogimage.jpg" alt="wolffish" />
</picture>

# wolffish-extension

**Browser capability for the Wolffish AI agent.**

A Chrome/Brave extension that gives [Wolffish](https://wolffi.sh) direct control of your real browser — navigate pages, click elements, fill forms, read content, take screenshots, manage tabs, and execute JavaScript. All in your actual browser session with your cookies, logins, and extensions.

---

## Watch

<table>
  <tr>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=MA6KkeZyFF4"><img src="https://cdn.wolffi.sh/general/Demo%20walkthrough.png" width="360" alt="Demo walkthrough" /></a>
      <br /><b>Demo walkthrough</b>
    </td>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=XZdBttn-99E"><img src="https://cdn.wolffi.sh/general/wolffish.jpg" width="360" alt="Cinematic launch" /></a>
      <br /><b>Cinematic launch</b>
    </td>
    <td align="center">
      <a href="https://www.youtube.com/watch?v=TKdTWd6BXR8"><img src="https://cdn.wolffi.sh/general/Cinematic%20reveal.png" width="360" alt="Cinematic reveal" /></a>
      <br /><b>Cinematic reveal</b>
    </td>
  </tr>
</table>

---

## How It Works

The extension connects to the Wolffish desktop app over a local WebSocket (port 23151 by default). When the agent needs to do something in the browser, it sends a command through the WebSocket. The extension executes it and sends back the result.

```
Wolffish App ←→ WebSocket (localhost:23151) ←→ Extension Service Worker ←→ Content Script / Chrome APIs
```

### Architecture

| Layer | What It Does |
| --- | --- |
| **Service Worker** (`chrome-extension/src/background/`) | Receives commands over WebSocket, dispatches to handlers or content scripts, sends responses back |
| **Content Script** (`pages/content/`) | Injected into every page. Handles DOM interaction — clicks, typing, reading, scrolling, waiting |
| **Side Panel** (`pages/side-panel/`) | Shows connection status, live event feed per conversation, conversation history |
| **Shared** (`packages/shared/`) | Wire protocol types, constants, command definitions, bridge utilities |
| **Storage** (`packages/storage/`) | Chrome storage wrappers for connection config (port) |
| **i18n** (`packages/i18n/`) | Localization — English, Arabic, Korean |

### Command Flow

1. Agent calls `ext_navigate` → plugin maps to `browser_navigate` → sends over WebSocket
2. Service worker receives → checks if it's a service-worker command or content-script command
3. Service-worker commands (navigate, tabs, cookies, screenshots) execute via Chrome APIs directly
4. Content-script commands (click, type, scroll, read) are relayed to the injected content script
5. Result flows back: content script → service worker → WebSocket → plugin → agent

---

## Where It Goes with wolffish-app

The extension is bundled inside wolffish-app at `src/defaults/workspace/extension/`. On every app launch, it's copied to `~/.wolffish/workspace/extension/`. Users load it from there into Chrome.

### Core Code (wolffish-app, not editable)

| File | Purpose |
| --- | --- |
| `src/main/channels/extension/server.ts` | WebSocket server, connection management, heartbeat, command routing |
| `src/main/channels/extension/log.ts` | Per-conversation event logging to `logs/extension/{id}.jsonl` |

### Plugin Code (editable by users)

| File | Purpose |
| --- | --- |
| `brain/cerebellum/browser-extension/SKILL.md` | Tool definitions, triggers, safety patterns, agent instructions |
| `brain/cerebellum/browser-extension/plugin/index.mjs` | Tool execution — reads bridge from `globalThis`, sends commands, processes screenshots with sharp |

The separation is intentional. Connection management is core infrastructure. Tool definitions and execution logic are a cerebellum plugin that power users can customize.

---

## Installation

### For Users

1. Open Wolffish → Settings → Services → Browser Extension
2. Click "Reveal in Finder" to find the extension folder
3. Open Chrome/Brave → `chrome://extensions`
4. Enable Developer Mode → Load Unpacked → Select the extension folder
5. The extension connects automatically

### For Developers

```bash
# Install dependencies
pnpm install

# Development (with hot reload)
pnpm dev

# Production build
pnpm build

# Build + copy to wolffish-app + bump version
pnpm release
```

---

## 44 Commands

### Navigation
`browser_navigate` · `browser_back` · `browser_forward` · `browser_reload`

### Page Interaction
`browser_click` · `browser_type` · `browser_select` · `browser_hover` · `browser_scroll` · `browser_focus` · `browser_keypress` · `browser_drag_drop` · `browser_file_upload`

### Page Reading
`browser_read_page` · `browser_query_selector` · `browser_get_attribute` · `browser_get_value` · `browser_get_url` · `browser_get_page_info`

### Tab Management
`browser_tabs_list` · `browser_tab_open` · `browser_tab_close` · `browser_tab_switch` · `browser_tab_duplicate` · `browser_tab_move`

### Window Management
`browser_windows_list` · `browser_window_open` · `browser_window_close` · `browser_window_resize`

### Screenshots & Visual
`browser_screenshot` · `browser_pdf`

### Cookies & Storage
`browser_cookies_get` · `browser_cookies_set` · `browser_cookies_remove` · `browser_storage_get` · `browser_storage_set`

### Clipboard
`browser_clipboard_read` · `browser_clipboard_write`

### Downloads
`browser_download`

### JavaScript Execution
`browser_execute_js`

### Wait & Polling
`browser_wait_for` · `browser_wait_for_navigation` · `browser_wait_for_network_idle`

### Notifications
`browser_notify`

---

## Extending

### Adding a New Command

1. **Extension side** — Add a handler in the service worker (`chrome-extension/src/background/index.ts`) or content script (`pages/content/src/matches/all/index.ts`)
2. **Register it** — Add to `SERVICE_WORKER_COMMANDS` or `CONTENT_SCRIPT_COMMANDS` in `packages/shared/lib/wolffish/commands.ts`
3. **Plugin side** — Add the tool to `SKILL.md` frontmatter and the execute switch in `plugin/index.mjs`
4. **Release** — Run `pnpm release` to build and copy to wolffish-app

### Customizing Agent Behavior

Edit `~/.wolffish/workspace/brain/cerebellum/.browser-extension/SKILL.md`:
- Change tool descriptions to guide the agent differently
- Add trigger keywords
- Add or modify safety patterns (danger_patterns, confirm_patterns)
- Edit the body text for custom procedures

### Building a Custom Extension

The core WebSocket server in wolffish-app is command-agnostic. It pipes `{ id, type, params }` to the extension and resolves when a `{ id, success, data }` response comes back. You can:

1. Fork this extension
2. Add entirely new commands
3. Update the plugin to match
4. The core plumbing works without changes

---

## Supported Browsers

| Browser | Status |
| --- | --- |
| Chromium | Supported |
| Chrome | Supported |
| Brave | Supported |
| Edge | Supported |
| Safari | Not supported |
| Firefox | Not supported |

---

## Wire Protocol

### Server → Extension

| Message | Purpose |
| --- | --- |
| `{ id, type, params }` | Execute a command |
| `{ type: 'pong' }` | Heartbeat response |
| `{ type: 'event', event: 'extension_reload' }` | Trigger `chrome.runtime.reload()` |
| `{ type: 'event', event: 'events_sync', data }` | Push conversation events to side panel |
| `{ type: 'event', event: 'event_logged', data }` | Push single new event |
| `{ type: 'event', event: 'port_update', data: { port } }` | Port changed, reconnect |

### Extension → Server

| Message | Purpose |
| --- | --- |
| `{ type: 'ping' }` | Heartbeat (every 15s) |
| `{ type: 'extension_info', version }` | Sent on connect |
| `{ id, success, data?, error? }` | Command response |
| `{ type: 'get_conversations' }` | Request conversation list |
| `{ type: 'get_conversation_events', conversationId }` | Request events for a conversation |

---

## Project Structure

```
wolffish-extension/
├── chrome-extension/          Manifest, service worker, public assets
│   ├── manifest.ts            Manifest V3 config
│   └── src/background/        Service worker — WebSocket, command dispatch
├── pages/
│   ├── content/               Content script — DOM interaction
│   └── side-panel/            Side panel UI — events, conversations
├── packages/
│   ├── shared/                Types, constants, commands, bridge
│   ├── storage/               Chrome storage wrappers
│   ├── i18n/                  Localization (en, ar, ko)
│   └── ui/                    Shared UI components
├── dist/                      Built extension (load this in Chrome)
└── package.json               Scripts: dev, build, release
```

---

## Links

- **Wolffish App** — [github.com/thewolffish](https://github.com/thewolffish)
- **Website** — [wolffi.sh](https://wolffi.sh)
- **Docs** — [docs.wolffi.sh](https://docs.wolffi.sh)
- **Discord** — [Join](https://discord.com/invite/F5Ue36PzQ)
- **X** — [@younesbites](https://x.com/younesbites)

---

## License

MIT License — Copyright (c) 2026 [Younes Alturkey](mailto:younes@wolffi.sh)
