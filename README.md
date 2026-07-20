# frida-mcp

TypeScript **stdio MCP** for Frida iOS exploration — Playwright-style loop:

```text
device_list → app_list → session_open → wait → screen_snapshot
  → tap(ref) / swipe / type_text → screen_snapshot → … → session_close
```

Independent of `fleetcontrol` (agent JS copied under `agent/`).

## Requirements

| Component | Version |
|-----------|---------|
| Node.js | ≥ 22 |
| pnpm | 9+ |
| npm `frida` | 17.x (this repo pins `^17.16.2`) |
| iOS `frida-server` | **same major**, e.g. **17.9.1** / 17.x |
| USB | MVP: native USB only (no wecha TCP yet) |

Mismatch between host `frida` and phone `frida-server` → inject fails.

### Spawn-only (this device stack)

RootHide / TikTok / many jailbreak setups **cannot** use reliable `attach` (touch `_touchesEvent` null, or process dies).

| Policy | Behavior |
|--------|----------|
| Default | **Always `mode=spawn`** |
| `mode=attach` | Forced to spawn + warning |
| Escape hatch | `FRIDA_MCP_ALLOW_ATTACH=1` (not recommended) |

```text
kill old pid → device.spawn(bundleId) suspended → attach(pid) → inject agent → [netEnable?] → resume
```

### Dual parallel: App + SpringBoard

| Channel | Session field | Lock | How to open |
|---------|---------------|------|-------------|
| App (TikTok) | `live` | `appLock` | `session_open` |
| SpringBoard | `sbLive` | `sbLock` | `withSpringBoard:true` / `sb_ensure` / first `sb_*` |

- **Held in parallel** — two Frida scripts on two processes.
- **RPCs concurrent** — separate locks; `dual_ping` / `Promise.all([app…, sb…])` run together.
- **Not multi-app** — only one business app + SpringBoard.

```text
session_open { bundleId: TikTok, withSpringBoard: true }
dual_ping                    # both channels pong at once
# later, can issue app + sb work concurrently if client allows
```

## Install & build

```bash
cd D:\Project\tk\frida-mcp
pnpm install
pnpm build
```

## Modes

### Embedded (default, recommended for Grok/Cursor trial)

Session lives inside the MCP process. No daemon, no env:

```bash
node dist/index.js
# or
pnpm dev
```

### Daemon + thin MCP (NSSM)

1. Daemon holds Frida session on `127.0.0.1:18765`
2. stdio MCP forwards tools when `FRIDA_MCP_MODE=daemon` (or `FRIDA_MCP_DAEMON=1`)

```bash
pnpm start:daemon
# other terminal / Cursor:
set FRIDA_MCP_MODE=daemon
node dist/index.js
```

## Grok config (`~/.grok/config.toml`)

Why no `args`? MCP spawns `command` + optional `args`. We ship `bin/frida-mcp.cmd`
which already runs `node dist/index.js`, so config only needs the launcher path:

```toml
[mcp_servers.frida-ios]
command = "D:/Project/tk/frida-mcp/bin/frida-mcp.cmd"
enabled = true
```

**Optional daemon mode** (daemon must be running separately):

```toml
[mcp_servers.frida-ios]
command = "D:/Project/tk/frida-mcp/bin/frida-mcp.cmd"
enabled = true

[mcp_servers.frida-ios.env]
FRIDA_MCP_MODE = "daemon"
```

## Cursor `mcp.json`

```json
{
  "mcpServers": {
    "frida-ios": {
      "command": "D:/Project/tk/frida-mcp/bin/frida-mcp.cmd"
    }
  }
}
```

## TikTok red lines

- **Never** `dump_tree` / `find_view` / `find_buttons` / `dump_login_gate` (MCP gates these).
- Read UI only via `screen_snapshot` → `collectTextsWithFrames`.
- Prefer `session_open` `mode=spawn` for reliable touch.
- After open, **`wait` 3000–5000 ms** before first snapshot.
- Refs only valid for **last** snapshot — re-snapshot after UI changes.

## Tools

| Tool | Purpose |
|------|---------|
| `device_list` | Frida devices (default USB-only; `usbOnly=false` for all) |
| `app_list` | Apps + pid. Default `userFacing=true` filters Apple services; `runningOnly` / `query` supported |
| `session_open` | spawn \| attach + inject |
| `session_status` / `session_respawn` / `session_close` | lifecycle (`alive` flag tracks script death) |
| `ping` | agent liveness |
| `screen_window` | simplified `{width,height,x,y,cx,cy,className}` |
| `screen_snapshot` / `screen_search` | texts refs are generation-scoped (`g3t8`); tree mode does not wipe texts refs |
| `tap` / `swipe` / `press_home` / `wait` | act |
| `probe_help` | Recommended probe loop (call first) |
| `type_text` | 拟人逐字 if already focused (`resnapshot` default true) |
| `smart_type_text` | **preferred** tap→focus→拟人逐字 |
| `clear_text` / `first_responder` / `human_pause` | focus/clear/step gap |
| `double_tap` | double-tap like at ref/x,y |
| `set_otp` | TikTok OTP fill (`setOtpCode`) |
| `set_text_at_point` | coordinate setText (not humanized) |
| `dump_modal` | mid-screen modal (blocked on TikTok) |
| `rpc_call` | whitelisted agent RPC (debug) |
| `process_list` | device processes (pid/name) |
| `sb_alert_list` / `sb_alert_tap` / `sb_alert_dismiss` / `sb_close` | SpringBoard system alerts |
| `net_enable` / `net_disable` / `net_clear` / `net_status` / `net_dump` | in-process NSURLSession capture (TLS plaintext after app decrypt) |

Refs expire after `tap`/`swipe` and across snapshot generations. Off-screen / zero-size nodes are marked and rejected on `tap`.

### 逐字拟人输入（inputText）

Agent: `agent/text_input/comment.js` — same as fleetcontrol.

| MCP tool | fleetcontrol 对应 | 行为 |
|----------|-------------------|------|
| `type_text` | `TypeTextAction` / HumanTypeInField | 已获焦，逐字 `inputText` |
| `smart_type_text` | `SmartTypeTextAction` | tap → 等 firstResponder → `human_pause` → 逐字 |
| `human_pause` | `human_pause(min,max)` | 步骤间隙随机 sleep（非打字延迟） |

- 默认 `perCharDelayMs=90`，agent 内 `randomDelay(base, jitter≈base)`（jitter≥30）
- 插入路径：`insertText` → `replaceRange` → 内层 `insertText` → `setText`+通知
- **`screen_snapshot` 默认** `onScreenOnly=true` `limit=40`；可选 `search` / `showDiff`
- **`tap` / `swipe` / `smart_type_text` 默认 `resnapshot=true`**（返回 `snapshot` 字段）
- 错误返回 `{ code, recovery[] }`（如 `SCRIPT_DESTROYED` → respawn）
- 日常探测先 `probe_help`；避免 `rpc_call` / `dump_modal` / `set_text_at_point`

### Network capture

```text
# Best: capture launch traffic (hooks before resume)
session_open { bundleId, mode:"spawn", captureNet:true } → wait → net_dump

# Or enable later
session_open → net_enable({ urlFilter?: "api\\." }) → wait / use app → net_dump → net_disable
```

- **Scope:** only the injected process (not system-wide MITM).
- **Sees:** `NSURLSession` request URL/method/headers/body preview.
- **Default:** `captureResponse=false` (request-only, stable). Response wrapping can kill scripts on some apps.
- **Does not see:** pure native sockets / custom TLS that skip `NSURLSession` (some SDKs/CDNs).

## NSSM (only after device tools work)

```powershell
# Admin
cd D:\Project\tk\frida-mcp
pnpm build
.\scripts\install-nssm-service.ps1
nssm start FridaMcpDaemon
```

Uninstall: `.\scripts\uninstall-nssm-service.ps1`

Logs: `logs/daemon.stdout.log`, `logs/daemon.stderr.log`

## Typical probe

1. `device_list`
2. `app_list` → find TikTok bundle
3. `session_open` `{ "bundleId": "…", "mode": "spawn" }`
4. `wait` `{ "ms": 4000 }`
5. `ping` → `pong`
6. `screen_snapshot` → refs
7. `tap` `{ "ref": "t3" }` → `screen_snapshot` again

## Agent

- Source: `agent/agent_main.js` (+ imports), includes `ping`
- Override: `FRIDA_AGENT_ENTRY=path/to/agent_main.js`
- Compile: Frida Compiler, `projectRoot` = repo root (`frida-objc-bridge` in `node_modules`)

## License

Private / internal use.
