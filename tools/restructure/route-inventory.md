# Route inventory

Written by `node tools/restructure/route-inventory.mjs --write` from the engine's code; never edit it by hand.
`server/test/restructure-route-inventory.test.mjs` fails when this file and the code disagree.

- Asked by: `chain` a test of `handleRequest` in server/server.js; `table` and `feature` the Map of
  server/feature-routes.js (TABLE_FILES, FEATURES); `socket` the `upgrade` handler (WS = a WebSocket).
- Paired device: what `remotePathAllowed` (server/paired/remote-access.js) says, with `CSRF_MUTATION_PATHS`
  as server.js hands it at boot, and the list that refuses. A beginning (`/x/*`) is judged on the beginning;
  listed addresses under it that are judged differently are named in the note.
- Cross-site guard: the list or rule of `handleRequest` that refuses a cross-site request or a navigation.
- JSONP: may answer `?cb=` (`JSONP_PATHS`).

535 routes.
- Asked by: 1 before the chain, 56 chain, 8 feature, 4 socket, 466 table.
- Paired device: 21 no: REMOTE_ADMIN, 73 no: REMOTE_DENY, 1 no: REMOTE_DENY_PREFIXES, 12 no: a GET that changes something, 4 no: sockets take the loopback door only, 408 yes, 14 yes (GET_READ_EXCEPTIONS), 2 yes, before pairing.
- Cross-site guard: 354 (none), 172 CSRF_MUTATION_PATHS, 2 isPackMutation, 7 isSdkSensitive.
- JSONP: GET /status.

| Method | Address | Asked by | Body in | Paired device | Cross-site guard | JSONP | Note |
|---|---|---|---|---|---|---|---|
| OPTIONS | `*` | before the chain | server/server.js | yes |  |  | answered 204 before any route |
| GET | `/` | chain | server/engine/routes.js | yes |  |  |  |
| GET | `/actions/catalog` | table | server/deck/routes-keys.js | yes |  |  |  |
| POST | `/actions/perf` | table | server/performance/routes-mode.js | yes |  |  |  |
| POST | `/actions/run` | table | server/deck/routes-keys.js | yes |  |  |  |
| POST | `/ai/deck-cancel` | table | server/ai/routes-memory.js | yes |  |  |  |
| POST | `/ai/deck-run` | table | server/ai/routes-memory.js | yes |  |  |  |
| POST | `/ai/pc-cancel` | table | server/ai/routes.js | yes |  |  |  |
| POST | `/ai/pc-run` | table | server/ai/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/api/ai` | chain | server/server.js | yes |  |  |  |
| GET | `/api/ai-local/capabilities` | table | server/ai/routes.js | yes |  |  |  |
| GET | `/api/ai-local/models` | table | server/ai/routes.js | yes |  |  |  |
| GET | `/api/ai-local/ollama-autostart` | table | server/ai/routes.js | yes |  |  |  |
| POST | `/api/ai-local/ollama-autostart` | table | server/ai/routes.js | yes |  |  |  |
| POST | `/api/ai-local/ollama-start` | table | server/ai/routes.js | yes |  |  |  |
| POST | `/api/ai-local/pull` | table | server/ai/routes-local.js | yes |  |  |  |
| GET | `/api/ai-local/scan` | table | server/ai/routes.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/ai-local/status` | table | server/ai/routes-local.js | yes |  |  |  |
| POST | `/api/ai-local/whisper-install` | table | server/ai/routes-local.js | no: REMOTE_DENY |  |  |  |
| GET | `/api/ai/actions` | table | server/ai/routes-memory.js | yes |  |  |  |
| POST | `/api/ai/actions/undo` | table | server/ai/routes-memory.js | yes |  |  |  |
| POST | `/api/ai/cli/mcp` | table | server/ai/routes.js | yes |  |  |  |
| GET | `/api/ai/cli/models` | table | server/ai/routes.js | yes |  |  |  |
| GET | `/api/ai/cli/status` | table | server/ai/routes.js | yes |  |  |  |
| WS | `/api/ai/live` | socket | server/server.js | no: sockets take the loopback door only |  |  | upgrade handler |
| DELETE | `/api/ai/memory` | table | server/ai/routes-memory.js | yes |  |  |  |
| GET | `/api/ai/memory` | table | server/ai/routes-memory.js | yes |  |  |  |
| POST | `/api/ai/memory` | table | server/ai/routes-memory.js | yes |  |  |  |
| GET | `/api/ai/models` | table | server/ai/routes-voice.js | yes |  |  |  |
| POST | `/api/ai/summarize` | table | server/ai/routes-memory.js | yes |  |  |  |
| GET | `/api/ai/turn` | table | server/ai/routes.js | yes |  |  |  |
| POST | `/api/ai/turn/stop` | table | server/ai/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/ai/xenon/balance` | table | server/ai/routes.js | yes |  |  |  |
| GET | `/api/battery` | table | server/system/routes-info.js | yes |  |  |  |
| GET | `/api/calls` | table | server/transfer/routes-phone.js | yes |  |  |  |
| POST | `/api/calls/act` | table | server/transfer/routes-phone.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/calls/test` | table | server/transfer/routes-phone.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/chatgpt` | table | server/codex/routes.js | yes |  |  |  |
| POST | `/api/chatgpt/ask` | table | server/codex/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/chatgpt/cancel` | table | server/codex/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/chatgpt/conversation` | table | server/codex/routes.js | yes |  |  |  |
| POST | `/api/chatgpt/delete` | table | server/codex/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/chime` | table | server/ai/routes.js | yes |  |  |  |
| GET | `/api/chroma/status` | table | server/lights/routes-control.js | yes |  |  |  |
| POST | `/api/chroma/test` | table | server/lights/routes-control.js | yes |  |  |  |
| GET | `/api/claude` | table | server/claude-code/routes.js | yes |  |  |  |
| GET | `/api/claude/agent` | table | server/claude-code/routes.js | yes |  |  |  |
| POST | `/api/claude/answer` | table | server/claude-code/routes-session.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/attach` | table | server/claude-code/routes-run.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/budget` | table | server/claude-code/routes-run.js | yes |  |  |  |
| GET | `/api/claude/commands` | table | server/claude-code/routes-run.js | yes |  |  |  |
| POST | `/api/claude/decide` | table | server/claude-code/routes-session.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/event` | table | server/claude-code/routes-session.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/folder` | table | server/claude-code/routes-run.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/claude/history` | table | server/claude-code/routes-run.js | yes |  |  |  |
| POST | `/api/claude/history/delete` | table | server/claude-code/routes-run.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/claude/link` | table | server/claude-code/routes-run.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/link` | table | server/claude-code/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/claude/mod` | table | server/claude-code/routes-session.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/mod` | table | server/claude-code/routes-session.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/mod/inbox` | table | server/claude-code/routes-session.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/mod/permission` | table | server/claude-code/routes-session.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/permission` | table | server/claude-code/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/claude/plan` | table | server/claude-code/routes.js | yes |  |  |  |
| GET | `/api/claude/projects` | table | server/claude-code/routes-run.js | yes |  |  |  |
| POST | `/api/claude/question` | table | server/claude-code/routes-session.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/reply` | table | server/claude-code/routes-session.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/run` | table | server/claude-code/routes-run.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/run/stop` | table | server/claude-code/routes-run.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/claude/session-commands` | table | server/claude-code/routes-session.js | yes |  |  |  |
| GET | `/api/claude/transcript` | table | server/claude-code/routes.js | yes |  |  |  |
| GET | `/api/claude/transcript-image` | table | server/claude-code/routes.js | yes |  |  |  |
| POST | `/api/claude/turn-end` | table | server/claude-code/routes-session.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/claude/unlink` | table | server/claude-code/routes-run.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/codex` | table | server/codex/routes.js | yes |  |  |  |
| POST | `/api/codex/decide` | table | server/codex/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/codex/event` | table | server/codex/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/codex/link` | table | server/codex/routes.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/codex/link` | table | server/codex/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/codex/permission` | table | server/codex/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/codex/thread` | table | server/codex/routes.js | yes |  |  |  |
| POST | `/api/codex/unlink` | table | server/codex/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/community/buy` | table | server/store-supporters/routes.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/community/catalog` | table | server/store-catalog/routes.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/community/code` | table | server/store-catalog/routes.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/community/installed` | table | server/store-catalog/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/community/installs` | table | server/store-catalog/routes.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/community/limited-status` | table | server/store-catalog/routes.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/community/messages` | table | server/store-catalog/routes.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/community/poll` | table | server/store-catalog/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/community/rate` | table | server/store-catalog/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/community/rating-close` | table | server/store-catalog/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/community/rating-state` | table | server/store-catalog/routes.js | yes |  |  |  |
| GET | `/api/community/ratings` | table | server/store-catalog/routes.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/community/redeem` | table | server/store-supporters/routes-unlock.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/community/sparks` | table | server/store-supporters/routes.js | yes |  |  |  |
| POST | `/api/community/sparks/forget` | table | server/store-supporters/routes.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/community/sparks/owned` | table | server/store-supporters/routes.js | yes |  |  |  |
| POST | `/api/community/sparks/save` | table | server/store-supporters/routes.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/community/support-goal` | table | server/store-catalog/routes.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/community/supporter` | table | server/store-supporters/routes.js | yes |  |  |  |
| POST | `/api/community/supporter/forget` | table | server/store-supporters/routes.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/community/supporter/save` | table | server/store-supporters/routes.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/community/trial` | table | server/store-supporters/routes-unlock.js | yes |  |  |  |
| POST | `/api/community/trial/check` | table | server/store-supporters/routes-unlock.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/community/trial/tried` | table | server/store-supporters/routes-unlock.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/community/update` | table | server/store-supporters/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/companion/cost` | table | server/ai/routes-voice.js | yes |  |  |  |
| POST | `/api/companion/insight` | table | server/ai/routes-memory.js | yes |  |  |  |
| * | `/api/devclean/*` | chain | server/server.js | yes |  |  | answers "locked" until the devclean feature is unlocked, before the routes under it; under it: /api/devclean/compact (no: REMOTE_ADMIN, CSRF_MUTATION_PATHS), /api/devclean/run (GET: no: a GET that changes something; POST: yes, CSRF_MUTATION_PATHS) |
| POST | `/api/devclean/compact` | chain | server/disk/routes.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/devclean/overview` | chain | server/disk/routes.js | yes |  |  |  |
| POST | `/api/devclean/run` | chain | server/disk/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/devstorage` | chain | server/disk/routes.js | yes |  |  |  |
| POST | `/api/disk/advisor` | chain | server/disk/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/disks/io` | chain | server/disk/routes.js | yes |  |  |  |
| GET | `/api/energy` | feature | server/sensor-history/routes.js | yes |  |  |  |
| GET | `/api/features/devclean` | table | server/store-supporters/routes-unlock.js | yes |  |  |  |
| GET | `/api/features/devclean/preview` | table | server/store-supporters/routes-unlock.js | yes |  |  |  |
| POST | `/api/features/devclean/unlock` | table | server/store-supporters/routes-unlock.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/features/lyrics` | table | server/store-supporters/routes-unlock.js | yes |  |  |  |
| POST | `/api/features/lyrics/trial` | table | server/store-supporters/routes-unlock.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/features/lyrics/unlock` | table | server/store-supporters/routes-unlock.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/ffmpeg/install` | feature | server/ffmpeg-install/routes.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/ffmpeg/status` | feature | server/ffmpeg-install/routes.js | yes |  |  |  |
| GET | `/api/football` | table | server/ticker/routes-lists.js | yes |  |  |  |
| GET | `/api/football/news` | table | server/ticker/routes.js | yes |  |  |  |
| GET | `/api/football/search` | table | server/ticker/routes.js | yes |  |  |  |
| GET | `/api/football/standings` | table | server/ticker/routes.js | yes |  |  |  |
| POST | `/api/football/teams` | table | server/ticker/routes-lists.js | yes |  |  |  |
| POST | `/api/gamemode/install-presentmon` | table | server/performance/routes.js | no: REMOTE_DENY |  |  |  |
| GET | `/api/gamemode/status` | table | server/performance/routes.js | yes |  |  |  |
| GET | `/api/guardian/history` | table | server/system/routes-info.js | yes |  |  |  |
| GET | `/api/ha/camera/snapshot/*` | chain | server/smart-home/routes-cameras.js | yes |  |  |  |
| GET | `/api/ha/cameras` | table | server/smart-home/routes.js | yes |  |  |  |
| GET | `/api/homeassistant/dashboards` | table | server/smart-home/routes.js | yes |  |  |  |
| GET | `/api/homeassistant/entities` | table | server/smart-home/routes.js | yes |  |  |  |
| POST | `/api/homeassistant/service` | table | server/smart-home/routes.js | yes |  |  |  |
| GET | `/api/homeassistant/state` | table | server/smart-home/routes.js | yes |  |  |  |
| POST | `/api/homeassistant/test` | table | server/smart-home/routes.js | yes |  |  |  |
| POST | `/api/icue/sharpen` | table | server/lights/routes.js | yes |  |  |  |
| POST | `/api/lighting/album` | table | server/lights/routes.js | yes |  |  |  |
| POST | `/api/lighting/animation` | table | server/lights/routes-control.js | yes |  |  |  |
| POST | `/api/lighting/device` | table | server/lights/routes-control.js | yes |  |  |  |
| POST | `/api/lighting/device-mode` | table | server/lights/routes-control.js | yes |  |  |  |
| GET | `/api/lighting/devices` | table | server/lights/routes.js | yes |  |  |  |
| POST | `/api/lighting/effects` | table | server/lights/routes-control.js | yes |  |  |  |
| POST | `/api/lighting/event` | table | server/lights/routes.js | yes |  |  |  |
| POST | `/api/lighting/manual` | table | server/lights/routes-control.js | yes |  |  |  |
| POST | `/api/lighting/native` | table | server/lights/routes-control.js | yes |  |  |  |
| POST | `/api/lighting/native/layout` | table | server/lights/routes-control.js | yes |  |  |  |
| POST | `/api/lighting/native/preview` | table | server/lights/routes-control.js | yes |  |  |  |
| POST | `/api/lighting/native/scan` | table | server/lights/routes-control.js | yes |  |  |  |
| POST | `/api/lighting/open-download` | table | server/lights/routes.js | yes |  |  |  |
| POST | `/api/lighting/scan` | table | server/lights/routes-control.js | yes |  |  |  |
| POST | `/api/lighting/sdk-install` | table | server/lights/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/lighting/status` | table | server/lights/routes.js | yes |  |  |  |
| POST | `/api/log` | chain | server/engine/routes.js | yes |  |  |  |
| GET | `/api/lyrics` | table | server/media/routes.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/lyrics/offset` | table | server/media/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/lyrics/translate` | table | server/media/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/lyrics/translate/usage` | table | server/media/routes.js | yes |  |  |  |
| * | `/api/mcp/dev/*` | chain | server/mcp/routes-dev.js | no: REMOTE_DENY_PREFIXES |  |  | under it: /api/mcp/dev/call (no: REMOTE_DENY_PREFIXES, CSRF_MUTATION_PATHS), /api/mcp/dev/connect (no: REMOTE_DENY_PREFIXES, CSRF_MUTATION_PATHS), /api/mcp/dev/pair (no: REMOTE_DENY_PREFIXES, CSRF_MUTATION_PATHS), /api/mcp/dev/pair/answer (no: REMOTE_DENY_PREFIXES, CSRF_MUTATION_PATHS), /api/mcp/dev/pair/poll (no: REMOTE_DENY_PREFIXES, CSRF_MUTATION_PATHS), /api/mcp/dev/report (no: REMOTE_DENY_PREFIXES, CSRF_MUTATION_PATHS), /api/mcp/dev/revoke (no: REMOTE_DENY_PREFIXES, CSRF_MUTATION_PATHS) |
| POST | `/api/native/install` | chain | server/install/routes.js | no: REMOTE_DENY |  |  |  |
| GET | `/api/native/install-status` | table | server/updates/routes.js | yes |  |  |  |
| GET | `/api/native/status` | table | server/updates/routes.js | yes |  |  |  |
| GET | `/api/net-path` | feature | server/net-path/routes.js | yes |  |  |  |
| GET | `/api/news` | table | server/ticker/routes.js | yes |  |  |  |
| POST | `/api/news/feeds` | table | server/ticker/routes-lists.js | yes |  |  |  |
| GET | `/api/news/search` | table | server/ticker/routes.js | yes |  |  |  |
| POST | `/api/performance/plan` | table | server/performance/routes-mode.js | yes |  |  |  |
| GET | `/api/performance/powerplan` | table | server/performance/routes-mode.js | yes |  |  |  |
| POST | `/api/performance/powerplan` | table | server/performance/routes-mode.js | yes |  |  |  |
| POST | `/api/performance/screen` | table | server/performance/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/performance/shield` | table | server/performance/routes-mode.js | yes |  |  |  |
| POST | `/api/performance/state` | table | server/performance/routes-mode.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/performance/stats` | table | server/performance/routes-mode.js | yes |  |  |  |
| GET | `/api/phone` | table | server/transfer/routes-phone.js | yes |  |  |  |
| GET | `/api/phone/calls` | table | server/transfer/routes-phone.js | yes |  |  |  |
| GET | `/api/phone/contacts` | table | server/transfer/routes-phone.js | yes |  |  |  |
| POST | `/api/phone/dial` | table | server/transfer/routes-phone.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/phone/message` | table | server/transfer/routes-phone.js | yes |  |  |  |
| GET | `/api/phone/messages` | table | server/transfer/routes-phone.js | yes |  |  |  |
| POST | `/api/phone/send` | table | server/transfer/routes-phone.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/processes/history` | table | server/performance/routes-mode.js | yes |  |  |  |
| POST | `/api/push/key` | table | server/paired/routes-push.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/push/status` | table | server/paired/routes-push.js | yes |  |  |  |
| POST | `/api/push/subscribe` | table | server/paired/routes-push.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/push/test` | table | server/paired/routes-push.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/push/unsubscribe` | table | server/paired/routes-push.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/remote-access/enable` | table | server/paired/routes-access.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/remote-access/https` | table | server/paired/routes-access.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/remote-access/https/setup` | table | server/paired/routes-access.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/remote-access/pair` | table | server/paired/routes-access.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/remote-access/pair/cancel` | table | server/paired/routes-access.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/remote-access/redeem` | table | server/paired/routes-access.js | yes, before pairing | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/remote-access/rename` | table | server/paired/routes-access.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/remote-access/revoke` | table | server/paired/routes-access.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/remote-access/revoke-all` | table | server/paired/routes-access.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/remote-access/status` | table | server/paired/routes-access.js | no: REMOTE_ADMIN |  |  |  |
| GET | `/api/remote-access/whoami` | table | server/paired/routes-access.js | yes |  |  |  |
| GET | `/api/screens` | table | server/screens/routes.js | yes |  |  |  |
| GET | `/api/screenshot` | table | server/screens/routes-capture.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/screenshot/monitor` | table | server/screens/routes-capture.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/sensor-service` | feature | server/sensor-service/routes.js | yes |  |  |  |
| POST | `/api/signalrgb/config` | table | server/lights/routes.js | yes |  |  |  |
| GET | `/api/signalrgb/effects` | table | server/lights/routes.js | yes |  |  |  |
| GET | `/api/signalrgb/status` | table | server/lights/routes.js | yes |  |  |  |
| POST | `/api/speak` | table | server/ai/routes-voice.js | yes |  |  |  |
| POST | `/api/speak/stop` | table | server/ai/routes-voice.js | yes |  |  |  |
| GET | `/api/startup-task` | chain | server/install/routes.js | yes |  |  |  |
| GET | `/api/stocks` | table | server/ticker/routes.js | yes |  |  |  |
| GET | `/api/stocks/chart` | table | server/ticker/routes.js | yes |  |  |  |
| GET | `/api/stocks/search` | table | server/ticker/routes.js | yes |  |  |  |
| POST | `/api/stocks/watchlist` | table | server/ticker/routes-lists.js | yes |  |  |  |
| POST | `/api/stt/start` | table | server/ai/routes-dictation.js | yes |  |  |  |
| POST | `/api/stt/stop` | table | server/ai/routes-dictation.js | yes |  |  |  |
| GET | `/api/timers` | table | server/time/routes.js | yes |  |  |  |
| POST | `/api/timers` | table | server/time/routes.js | yes |  |  |  |
| DELETE | `/api/timers/*` | chain | server/time/routes.js | yes |  |  |  |
| PATCH | `/api/timers/*` | chain | server/time/routes.js | yes |  |  |  |
| POST | `/api/transcribe` | table | server/ai/routes.js | yes |  |  |  |
| POST | `/api/transfer/delete` | table | server/transfer/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/transfer/file` | table | server/transfer/routes.js | yes |  |  |  |
| HEAD | `/api/transfer/file` | table | server/transfer/routes.js | yes |  |  |  |
| GET | `/api/transfer/list` | table | server/transfer/routes.js | yes |  |  |  |
| POST | `/api/transfer/open` | table | server/transfer/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/transfer/reveal` | table | server/transfer/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/transfer/settings` | table | server/transfer/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/transfer/settings` | table | server/transfer/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/transfer/settings/pick` | table | server/transfer/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/transfer/thumb` | table | server/transfer/routes.js | yes |  |  |  |
| POST | `/api/transfer/undo` | table | server/transfer/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/transfer/upload` | table | server/transfer/routes-phone.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/api/tts` | table | server/ai/routes-voice.js | yes |  |  |  |
| GET | `/api/unifiprotect/snapshot/*` | chain | server/smart-home/routes-cameras.js | yes |  |  |  |
| GET | `/api/unifiprotect/state` | table | server/smart-home/routes.js | yes |  |  |  |
| POST | `/api/unifiprotect/test` | table | server/smart-home/routes.js | yes |  |  |  |
| GET | `/api/vitals/caps` | table | server/vitals/routes.js | yes |  |  |  |
| POST | `/api/vitals/nag` | table | server/vitals/routes.js | yes |  |  |  |
| GET | `/api/vitals/popup` | table | server/vitals/routes.js | yes |  |  |  |
| POST | `/api/vitals/roast` | table | server/vitals/routes.js | yes |  |  |  |
| POST | `/api/vitals/state` | table | server/vitals/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/api/voicemeeter/state` | table | server/audio/routes-volume.js | yes |  |  |  |
| POST | `/api/volume/duck` | table | server/audio/routes-volume.js | yes |  |  |  |
| POST | `/api/volume/restore` | table | server/audio/routes-volume.js | yes |  |  |  |
| GET | `/api/wake/status` | table | server/ai/routes-voice.js | yes |  |  |  |
| GET | `/api/wavelink/channels` | table | server/audio/routes-volume.js | yes |  |  |  |
| GET | `/api/wavelink/icon` | table | server/audio/routes-volume.js | yes |  |  |  |
| GET | `/api/wavelink/mixes` | table | server/audio/routes-volume.js | yes |  |  |  |
| GET | `/api/wavelink/state` | table | server/audio/routes-volume.js | yes |  |  |  |
| POST | `/api/wavelink/test` | table | server/audio/routes-volume.js | yes |  |  |  |
| POST | `/api/weather/config` | table | server/weather/routes.js | yes |  |  |  |
| GET | `/api/widgets/auto-update` | table | server/store-catalog/routes-packs.js | yes |  |  |  |
| GET | `/apps/store` | table | server/deck/routes.js | yes |  |  |  |
| GET | `/assets/*` | chain | server/server.js | yes |  |  | static files; /assets itself too |
| GET | `/audio` | table | server/audio/routes-volume.js | yes |  |  |  |
| GET | `/audio/app/mute` | table | server/audio/routes.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| POST | `/audio/app/mute` | table | server/audio/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/audio/app/volume` | table | server/audio/routes.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| POST | `/audio/app/volume` | table | server/audio/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/audio/apps` | table | server/audio/routes.js | yes |  |  |  |
| POST | `/audio/levels/install-helper` | table | server/audio/routes.js | no: REMOTE_DENY |  |  |  |
| GET | `/audio/levels/status` | table | server/audio/routes.js | yes |  |  |  |
| GET | `/audio/watch` | table | server/audio/routes.js | yes |  |  |  |
| POST | `/background` | table | server/look/routes.js | yes |  |  |  |
| GET | `/backup/export` | table | server/settings/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/backup/import` | table | server/settings/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/backup/save` | table | server/settings/routes.js | yes |  |  |  |
| GET | `/bit/messages` | table | server/ai/routes-voice.js | yes |  |  |  |
| POST | `/bit/messages/file` | chain | server/server.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/bit/messages/import` | chain | server/server.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/bit/messages/read` | chain | server/server.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/bit/messages/shown` | chain | server/server.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/capture/settings` | table | server/screens/routes-capture.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/capture/settings` | table | server/screens/routes-capture.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/capture/settings/pick` | table | server/screens/routes-capture.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/captures` | table | server/screens/routes-captures.js | yes |  |  |  |
| POST | `/captures/clips` | table | server/screens/routes-capture.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/captures/copy` | table | server/screens/routes-captures.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/captures/delete` | table | server/screens/routes-captures.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/captures/export` | table | server/screens/routes-captures.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/captures/export-cancel` | table | server/screens/routes-captures.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/captures/file` | table | server/screens/routes-captures.js | yes |  |  |  |
| HEAD | `/captures/file` | table | server/screens/routes-captures.js | yes |  |  |  |
| POST | `/captures/reveal` | table | server/screens/routes-captures.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/captures/save` | table | server/screens/routes-captures.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/captures/send` | table | server/screens/routes-capture.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/captures/spots` | table | server/screens/routes-captures.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/captures/thumb` | table | server/screens/routes-captures.js | yes |  |  |  |
| POST | `/captures/transcribe` | table | server/screens/routes-captures.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/captures/transcript` | table | server/screens/routes-captures.js | yes |  |  |  |
| POST | `/captures/trim` | table | server/screens/routes-captures.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/components/*` | chain | server/server.js | yes |  |  | static files; /components itself too |
| GET | `/deck-config` | table | server/deck/routes.js | yes |  |  |  |
| POST | `/deck-config` | table | server/deck/routes-keys.js | yes |  |  |  |
| GET | `/deck-popup` | table | server/deck/routes-keys.js | yes |  |  |  |
| GET | `/deck/app-icon` | table | server/deck/routes.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| POST | `/deck/client-step` | table | server/deck/routes-keys.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/deck/popup/open` | table | server/deck/routes-keys.js | yes |  |  |  |
| GET | `/deck/press` | table | server/deck/routes-keys.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/deck/press` | table | server/deck/routes-keys.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/deck/shortcut-claim` | table | server/deck/routes-keys.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/deck/sound` | table | server/deck/routes.js | yes |  |  |  |
| GET | `/deck/sound-packs` | table | server/deck/routes.js | yes |  |  |  |
| POST | `/deck/sound-upload` | table | server/deck/routes.js | yes |  |  |  |
| GET | `/deck/sounds` | table | server/deck/routes.js | yes |  |  |  |
| DELETE | `/deck/sounds/*` | chain | server/deck/routes.js | yes |  |  |  |
| GET | `/disk/browse` | chain | server/disk/routes.js | yes |  |  |  |
| POST | `/disk/clean` | chain | server/disk/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/disk/clean/cancel` | chain | server/disk/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/disk/overview` | chain | server/disk/routes.js | yes |  |  |  |
| POST | `/disk/reveal` | chain | server/disk/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/disk/scan` | chain | server/disk/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/disk/scan/cancel` | chain | server/disk/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/disk/status` | chain | server/disk/routes.js | yes |  |  |  |
| GET | `/draw` | table | server/alerts/routes.js | no: REMOTE_DENY |  |  |  |
| GET | `/embedded-browser/adblock` | table | server/windows-tiles/routes-tiles.js | yes |  |  |  |
| POST | `/embedded-browser/adblock/install` | table | server/windows-tiles/routes.js | no: REMOTE_DENY |  |  |  |
| GET | `/embedded-browser/available` | table | server/windows-tiles/routes.js | yes |  |  |  |
| POST | `/embedded-browser/install` | table | server/windows-tiles/routes.js | yes |  |  |  |
| WS | `/embedded-browser/ws` | socket | server/server.js | no: sockets take the loopback door only |  |  | upgrade handler |
| GET | `/events` | table | server/time/routes.js | yes |  |  |  |
| POST | `/events` | table | server/time/routes.js | yes |  |  |  |
| GET | `/external-events` | table | server/time/routes.js | yes |  |  |  |
| POST | `/external-events/refresh` | table | server/time/routes.js | yes |  |  |  |
| POST | `/font` | table | server/look/routes.js | yes |  |  |  |
| DELETE | `/font/*` | chain | server/look/routes.js | yes |  |  |  |
| POST | `/ha/deck-watch` | table | server/smart-home/routes.js | yes |  |  |  |
| GET | `/i18n-langs.json` | feature | server/app-strings/routes.js | yes |  |  |  |
| POST | `/icon-pack` | table | server/store-catalog/routes-packs.js | yes | CSRF_MUTATION_PATHS |  |  |
| DELETE | `/icon-pack/*` | chain | server/store-catalog/routes-packs.js | yes | isPackMutation |  |  |
| GET | `/icon-pack/*` | chain | server/store-catalog/routes-packs.js | yes |  |  |  |
| GET | `/icon-packs` | table | server/store-catalog/routes-packs.js | yes |  |  |  |
| GET | `/index/status` | table | server/search/routes-files.js | yes |  |  |  |
| GET | `/js/*` | chain | server/server.js | yes |  |  | static files; /js itself too |
| GET | `/layer-i18n.js` | table | server/widget-options/routes.js | yes |  |  |  |
| POST | `/layers/desk` | table | server/widget-options/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/layers/edit` | table | server/widget-options/routes.js | yes |  |  |  |
| POST | `/layers/host` | table | server/widget-options/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/lock` | table | server/system/routes.js | yes |  |  |  |
| POST | `/macos/fda-settings` | table | server/system/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/manifest.webmanifest` | table | server/paired/routes.js | yes |  |  |  |
| GET | `/media` | table | server/media/routes.js | yes |  |  |  |
| GET | `/media/next` | table | server/media/routes.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| POST | `/media/next` | table | server/media/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/media/playpause` | table | server/media/routes.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| POST | `/media/playpause` | table | server/media/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/media/previous` | table | server/media/routes.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| POST | `/media/previous` | table | server/media/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/media/source` | table | server/media/routes.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| POST | `/media/source` | table | server/media/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/menu` | table | server/menu/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/mic/set` | table | server/audio/routes-volume.js | yes |  |  |  |
| GET | `/mic/volume` | table | server/audio/routes-volume.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| POST | `/mic/volume` | table | server/audio/routes-volume.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/network` | table | server/system/routes-info.js | yes |  |  |  |
| GET | `/notes` | table | server/time/routes.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| POST | `/notes` | table | server/time/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/notes/list` | table | server/time/routes.js | yes |  |  |  |
| POST | `/notes/list` | table | server/time/routes.js | yes |  |  |  |
| GET | `/notifications/windows` | table | server/notification-open/routes.js | yes |  |  |  |
| GET | `/obs/scenes` | table | server/streaming/routes.js | yes |  |  |  |
| GET | `/obs/sources` | table | server/streaming/routes.js | yes |  |  |  |
| POST | `/pages/hotkey-press` | table | server/deck/routes-keys.js | no: REMOTE_DENY |  |  |  |
| GET | `/pages/hotkey-status` | table | server/deck/routes.js | yes |  |  |  |
| GET | `/pair` | table | server/paired/routes.js | yes, before pairing |  |  |  |
| GET | `/perf` | table | server/performance/routes.js | yes |  |  |  |
| GET | `/perf/sessions` | table | server/performance/routes.js | yes |  |  |  |
| GET | `/ping` | chain | server/engine/routes.js | yes |  |  |  |
| GET | `/public/*` | chain | server/server.js | yes |  |  | static files; /public itself too |
| POST | `/remote/block` | table | server/remote-control/routes.js | yes |  |  |  |
| POST | `/remote/disable` | table | server/remote-control/routes.js | yes |  |  |  |
| POST | `/remote/enable` | table | server/remote-control/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/remote/install` | table | server/remote-control/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/remote/kill` | table | server/remote-control/routes.js | yes |  |  |  |
| POST | `/remote/ondemand` | table | server/remote-control/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/remote/pin` | table | server/remote-control/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/remote/screen` | table | server/remote-control/routes.js | yes |  |  |  |
| POST | `/remote/screen/cycle` | table | server/remote-control/routes.js | yes |  |  |  |
| GET | `/remote/screens` | table | server/remote-control/routes.js | yes |  |  |  |
| POST | `/remote/session/close` | table | server/remote-control/routes.js | yes |  |  |  |
| GET | `/remote/status` | table | server/remote-control/routes.js | yes |  |  |  |
| POST | `/remote/sunshine/configure` | table | server/remote-control/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/remote/tailscale/login` | table | server/remote-control/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/remote/unblock` | table | server/remote-control/routes.js | no: REMOTE_DENY |  |  |  |
| GET | `/scene` | table | server/ambient/routes.js | no: REMOTE_DENY |  |  |  |
| GET | `/screen-alerts` | table | server/alerts/routes.js | no: REMOTE_DENY |  |  |  |
| GET | `/screen-draw` | table | server/alerts/routes.js | no: REMOTE_DENY |  |  |  |
| GET | `/screen-menu` | table | server/menu/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/screen-menu` | table | server/menu/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/sdk-service` | table | server/widget-sdk/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/sdk/ai` | table | server/widget-sdk/routes-calls.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/sdk/asset/*` | chain | server/widget-sdk/routes-images.js | yes |  |  |  |
| GET | `/sdk/check/*` | chain | server/widget-sdk/routes-packages.js | yes |  |  |  |
| POST | `/sdk/claim` | table | server/widget-sdk/routes-packages.js | yes |  |  |  |
| POST | `/sdk/deck-states` | table | server/widget-sdk/routes.js | yes | isSdkSensitive |  |  |
| GET | `/sdk/export/*` | chain | server/widget-sdk/routes-packages.js | yes |  |  |  |
| POST | `/sdk/fetch` | table | server/widget-sdk/routes-calls.js | yes | isSdkSensitive |  |  |
| POST | `/sdk/grant` | table | server/widget-sdk/routes-packages.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/sdk/handler-ack` | table | server/widget-sdk/routes.js | yes | isSdkSensitive |  |  |
| POST | `/sdk/hook/*` | chain | server/widget-sdk/routes-calls.js | yes | isSdkSensitive |  |  |
| POST | `/sdk/install` | table | server/widget-sdk/routes-packages.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/sdk/secret` | table | server/widget-sdk/routes-calls.js | yes | isSdkSensitive |  |  |
| POST | `/sdk/store` | table | server/widget-sdk/routes-calls.js | yes | isSdkSensitive |  |  |
| GET | `/sdk/tile/*` | chain | server/widget-sdk/routes-images.js | yes |  |  |  |
| DELETE | `/sdk/widget/*` | chain | server/widget-sdk/routes-packages.js | yes |  |  |  |
| GET | `/sdk/widget/*` | chain | server/server.js | yes |  |  |  |
| GET | `/sdk/widgets` | table | server/widget-sdk/routes-packages.js | yes |  |  |  |
| POST | `/sdk/widgets/example` | table | server/widget-sdk/routes.js | yes |  |  |  |
| GET | `/sdk/wk/*` | chain | server/server.js | yes |  |  |  |
| GET | `/search` | table | server/search/routes-files.js | yes |  |  |  |
| POST | `/search/hotkey-press` | table | server/search/routes.js | no: REMOTE_DENY |  |  |  |
| GET | `/search/hotkey-status` | table | server/search/routes.js | yes |  |  |  |
| GET | `/search/icon` | table | server/search/routes-files.js | yes |  |  |  |
| POST | `/search/open` | table | server/search/routes-files.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/search/recent` | table | server/search/routes-files.js | yes |  |  |  |
| POST | `/search/reveal` | table | server/search/routes-files.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/search/thumb` | table | server/search/routes-files.js | yes |  |  |  |
| POST | `/second-screen/apply-resolution` | table | server/windows-tiles/routes-tiles.js | yes |  |  |  |
| POST | `/second-screen/create-display` | table | server/windows-tiles/routes-tiles.js | no: REMOTE_DENY |  |  |  |
| POST | `/second-screen/install` | table | server/windows-tiles/routes-tiles.js | no: REMOTE_DENY |  |  |  |
| POST | `/second-screen/remove-display` | table | server/windows-tiles/routes-tiles.js | no: REMOTE_DENY |  |  |  |
| GET | `/second-screen/requirements` | table | server/windows-tiles/routes-tiles.js | yes |  |  |  |
| WS | `/second-screen/ws` | socket | server/server.js | no: sockets take the loopback door only |  |  | upgrade handler |
| GET | `/settings` | table | server/settings/routes.js | yes |  |  |  |
| POST | `/settings` | table | server/settings/routes-save.js | yes |  |  |  |
| POST | `/settings/tile` | table | server/settings/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/shared/*` | chain | server/server.js | yes |  |  | static files; /shared itself too |
| GET | `/shell-driver` | table | server/widget-sdk/routes.js | no: REMOTE_DENY |  |  |  |
| POST | `/slideshow-asset` | table | server/windows-tiles/routes-tiles.js | yes |  |  |  |
| GET | `/slideshow/file` | table | server/windows-tiles/routes-tiles.js | yes |  |  |  |
| GET | `/slideshow/folder` | table | server/windows-tiles/routes-tiles.js | yes |  |  |  |
| POST | `/sound-pack` | table | server/store-catalog/routes-packs.js | yes | CSRF_MUTATION_PATHS |  |  |
| DELETE | `/sound-pack/*` | chain | server/store-catalog/routes-packs.js | yes | isPackMutation |  |  |
| GET | `/speaker/mute` | table | server/audio/routes-volume.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| POST | `/speaker/mute` | table | server/audio/routes-volume.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/speaker/set` | table | server/audio/routes-volume.js | yes |  |  |  |
| GET | `/spotlight` | table | server/search/routes.js | yes |  |  |  |
| POST | `/spotlight/ask` | feature | server/spotlight-ask/routes.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| POST | `/spotlight/ask/take` | feature | server/spotlight-ask/routes.js | no: REMOTE_ADMIN | CSRF_MUTATION_PATHS |  |  |
| POST | `/spotlight/claimed` | table | server/search/routes.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/sse` | chain | server/engine/routes.js | yes |  |  |  |
| WS | `/sse/socket` | socket | server/server.js | no: sockets take the loopback door only |  |  | upgrade handler |
| GET | `/startup/auto-open` | chain | server/install/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| POST | `/startup/auto-open` | chain | server/install/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/state/get` | table | server/deck/routes.js | yes |  |  |  |
| POST | `/state/set` | table | server/deck/routes.js | yes | isSdkSensitive |  |  |
| GET | `/status` | chain | server/engine/routes.js | yes |  | yes |  |
| POST | `/stream/config` | table | server/streaming/routes.js | yes |  |  |  |
| GET | `/stream/discord/channels` | table | server/discord/routes.js | yes |  |  |  |
| POST | `/stream/discord/launch` | table | server/discord/routes.js | yes |  |  |  |
| POST | `/stream/discord/login` | table | server/discord/routes.js | yes |  |  |  |
| POST | `/stream/discord/logout` | table | server/discord/routes.js | yes |  |  |  |
| GET | `/stream/discord/notifications` | table | server/discord/routes.js | yes |  |  |  |
| POST | `/stream/discord/open-chat` | table | server/discord/routes.js | yes |  |  |  |
| GET | `/stream/discord/roster` | table | server/discord/routes.js | yes |  |  |  |
| GET | `/stream/discord/sounds` | table | server/discord/routes.js | yes |  |  |  |
| GET | `/stream/discord/status` | table | server/discord/routes.js | yes |  |  |  |
| GET | `/stream/discord/voice` | table | server/discord/routes.js | yes |  |  |  |
| POST | `/stream/homeassistant/query` | table | server/smart-home/routes.js | yes |  |  |  |
| GET | `/stream/spotify/callback` | table | server/streaming/routes-spotify.js | yes |  |  |  |
| GET | `/stream/spotify/devices` | table | server/streaming/routes-spotify.js | yes |  |  |  |
| POST | `/stream/spotify/launch` | table | server/streaming/routes-spotify.js | yes |  |  |  |
| POST | `/stream/spotify/login` | table | server/streaming/routes-spotify.js | yes |  |  |  |
| POST | `/stream/spotify/logout` | table | server/streaming/routes-spotify.js | yes |  |  |  |
| GET | `/stream/spotify/player` | table | server/streaming/routes-spotify.js | yes |  |  |  |
| GET | `/stream/spotify/playlists` | table | server/streaming/routes-spotify.js | yes |  |  |  |
| GET | `/stream/spotify/query` | table | server/streaming/routes-spotify.js | yes |  |  |  |
| GET | `/stream/spotify/queue` | table | server/streaming/routes-spotify.js | yes |  |  |  |
| GET | `/stream/spotify/status` | table | server/streaming/routes-spotify.js | yes |  |  |  |
| POST | `/stream/twitch/chat/send` | table | server/streaming/routes-twitch.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/stream/twitch/emotes` | table | server/streaming/routes-twitch.js | yes |  |  |  |
| GET | `/stream/twitch/followed` | table | server/streaming/routes-twitch.js | yes |  |  |  |
| POST | `/stream/twitch/login` | table | server/streaming/routes-twitch.js | yes |  |  |  |
| POST | `/stream/twitch/login/poll` | table | server/streaming/routes-twitch.js | yes |  |  |  |
| POST | `/stream/twitch/logout` | table | server/streaming/routes-twitch.js | yes |  |  |  |
| POST | `/stream/twitch/search` | table | server/streaming/routes-twitch.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/stream/twitch/status` | table | server/streaming/routes-twitch.js | yes |  |  |  |
| GET | `/stream/twitch/stream` | table | server/streaming/routes-twitch.js | yes |  |  |  |
| GET | `/stream/twitch/top` | table | server/streaming/routes-twitch.js | yes |  |  |  |
| GET | `/stream/youtube/broadcast` | table | server/streaming/routes-youtube.js | yes |  |  |  |
| POST | `/stream/youtube/broadcast/cancel` | table | server/streaming/routes-youtube.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/stream/youtube/broadcast/create` | table | server/streaming/routes-youtube.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/stream/youtube/chat` | table | server/streaming/routes-youtube.js | yes (GET_READ_EXCEPTIONS) | CSRF_MUTATION_PATHS |  |  |
| POST | `/stream/youtube/chat/send` | table | server/streaming/routes-youtube.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/stream/youtube/liked` | table | server/streaming/routes-youtube.js | yes |  |  |  |
| POST | `/stream/youtube/login` | table | server/streaming/routes-youtube.js | yes |  |  |  |
| POST | `/stream/youtube/login/poll` | table | server/streaming/routes-youtube.js | yes |  |  |  |
| POST | `/stream/youtube/logout` | table | server/streaming/routes-youtube.js | yes |  |  |  |
| GET | `/stream/youtube/playlist/items` | table | server/streaming/routes-youtube.js | yes |  |  |  |
| POST | `/stream/youtube/playlist/resolve` | table | server/streaming/routes-youtube.js | yes |  |  |  |
| GET | `/stream/youtube/playlists` | table | server/streaming/routes-youtube.js | yes |  |  |  |
| POST | `/stream/youtube/privacy` | table | server/streaming/routes-youtube.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/stream/youtube/query` | table | server/streaming/routes-youtube.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/stream/youtube/search` | table | server/streaming/routes-youtube.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/stream/youtube/status` | table | server/streaming/routes-youtube.js | yes |  |  |  |
| GET | `/stream/youtube/streamkey` | table | server/streaming/routes-youtube.js | no: REMOTE_DENY |  |  |  |
| GET | `/stream/youtube/subscriptions` | table | server/streaming/routes-youtube.js | yes |  |  |  |
| POST | `/stream/youtube/title` | table | server/streaming/routes-youtube.js | yes |  |  |  |
| GET | `/streamerbot/actions` | table | server/streaming/routes.js | yes |  |  |  |
| GET | `/streamerbot/activity` | table | server/streaming/routes.js | yes |  |  |  |
| GET | `/streamerbot/codetriggers` | table | server/streaming/routes.js | yes |  |  |  |
| GET | `/streamerbot/globals` | table | server/streaming/routes.js | yes |  |  |  |
| GET | `/styles/*` | chain | server/server.js | yes |  |  | static files; /styles itself too |
| GET | `/sw.js` | table | server/paired/routes.js | yes |  |  |  |
| GET | `/system` | table | server/system/routes-info.js | yes |  |  |  |
| POST | `/system/enable-sensors` | table | server/system/routes.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/system/sensors` | table | server/system/routes-info.js | yes |  |  |  |
| GET | `/system/theme` | chain | server/server.js | yes |  |  |  |
| GET | `/tasks` | table | server/time/routes.js | yes |  |  |  |
| POST | `/tasks` | table | server/time/routes.js | yes |  |  |  |
| POST | `/tile-asset` | table | server/grid/routes.js | yes |  |  |  |
| POST | `/tiles/play-claim` | table | server/windows-tiles/routes-tiles.js | no: REMOTE_DENY | CSRF_MUTATION_PATHS |  |  |
| GET | `/toggle` | table | server/audio/routes-volume.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| POST | `/toggle` | table | server/audio/routes-volume.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/update/apply` | table | server/updates/routes-update.js | no: REMOTE_DENY |  |  |  |
| GET | `/update/auto-status` | table | server/updates/routes-update.js | yes |  |  |  |
| POST | `/update/auto/postpone` | table | server/updates/routes-update.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/update/check` | table | server/updates/routes-update.js | yes |  |  |  |
| POST | `/update/notice-seen` | table | server/updates/routes-update.js | yes | CSRF_MUTATION_PATHS |  |  |
| POST | `/update/prepare` | table | server/updates/routes-update.js | no: REMOTE_DENY |  |  |  |
| GET | `/update/self-status` | table | server/updates/routes-update.js | yes |  |  |  |
| GET | `/uploads/*` | chain | server/look/routes.js | yes |  |  |  |
| GET | `/vendor/*` | chain | server/server.js | yes |  |  | static files; /vendor itself too |
| GET | `/version` | table | server/updates/routes.js | yes |  |  |  |
| GET | `/volume/set` | table | server/audio/routes-volume.js | no: a GET that changes something | CSRF_MUTATION_PATHS |  |  |
| POST | `/volume/set` | table | server/audio/routes-volume.js | yes | CSRF_MUTATION_PATHS |  |  |
| GET | `/weather` | table | server/weather/routes.js | yes |  |  |  |
| GET | `/whatsnew` | table | server/updates/routes-update.js | yes |  |  |  |
| GET | `/windows` | table | server/windows-tiles/routes.js | yes |  |  |  |
| POST | `/windows/close` | table | server/windows-tiles/routes.js | yes |  |  |  |
| POST | `/windows/focus` | table | server/windows-tiles/routes.js | yes |  |  |  |
| POST | `/windows/launch` | table | server/windows-tiles/routes-tiles.js | yes |  |  |  |
| GET | `/xenon-menu` | table | server/menu/routes.js | yes |  |  |  |

## Listed, answered by no route

- CSRF_MUTATION_PATHS: none.
- REMOTE_DENY: none.
- REMOTE_ADMIN: none.
- GET_READ_EXCEPTIONS: none.
- JSONP_PATHS: none.

## Answered twice

None.
