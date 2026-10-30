# xenon-mcp

Build widgets for [Xenon](https://xenon-app.com), the dashboard for any spare screen, from Claude Code, Codex or any
other MCP client. Your assistant reads the Widget SDK, writes the widget in a folder, installs it, puts it on your
dashboard, reads the errors it hits while it runs and looks at a picture of its tile, then fixes what is wrong.

It talks only to the Xenon running on your own computer. Nothing goes to the internet.

## Add it

Xenon 4.12.0 or newer must be running. In Xenon, **Settings, Widgets & sharing, Build widgets with Claude Code or Codex** has a
button for each that does this for you. By hand:

```sh
# Claude Code
claude mcp add --scope user xenon-widgets -- npx -y xenon-mcp

# Codex
codex mcp add xenon-widgets -- npx -y xenon-mcp
```

Any other MCP client: run `npx -y xenon-mcp` as a stdio server. It needs Node.js 18 or newer.

In Claude Code you can install it as a plugin instead, which adds a `build-widget` skill that knows the loop
(read the SDK, write, install, look, fix):

```text
/plugin install xenon-widgets --marketplace marcimastro98/Xenon
```

The first time the assistant uses a tool, Xenon asks on its dashboard: **Let this tool build widgets?** Press Allow.
The connection is remembered in `~/.xenon/mcp.json` and listed in that same Settings card, where Remove ends it.

## Then ask

> Make me a Xenon widget that shows my GPU temperature as a big number, in a folder called gpu-temp.

## Tools

| Tool | What it does |
|---|---|
| `xenon_status` | Is Xenon running, which SDK version, are community widgets on, is a dashboard open |
| `sdk_reference` | The Widget SDK reference, by section |
| `new_widget` | A working starter (manifest, HTML, CSS, JS) in a new or empty folder |
| `check_widget` | The checks an install runs, without installing: package rules, sandbox, Store review notes |
| `install_widget` | Install or update from the folder, put the widget on your dashboard and show its page |
| `widget_issues` | Errors, blocked requests, whether its permissions are approved, how heavy it is |
| `widget_screenshot` | A picture of the tile as it is on screen now |
| `my_widgets` | Your own widgets; with an id and a folder, writes one out to keep working on it |
| `share_widget` | A share code anyone can paste into Xenon, plus the Store review notes |

The folder's name is the widget id unless you pass `id` (a-z, 0-9 and dashes).

## What it can and cannot do

- It never approves a widget's permissions. A widget that reads data or runs actions waits for you to allow it on
  the dashboard, as any widget does.
- It can read, change and share only widgets you made, never ones from the Store or from someone's share code.
- It works only from this computer: a paired phone or tablet cannot reach it.
- Errors thrown in widget code arrive as "Script error." because widgets run in a sandbox on another origin. Wrap
  code in `try`/`catch` and `console.error` the message: those arrive in full.
- The screenshot is that box of the screen, so a window over the dashboard shows in it. It does not work on Linux
  under Wayland.

## Settings

| Variable | Default | |
|---|---|---|
| `XENON_URL` | `http://127.0.0.1:3030` | Another local Xenon address. Loopback only. |
| `XENON_MCP_STORE` | `~/.xenon/mcp.json` | Where the connection is remembered. |

## License

Part of Xenon, under the same custom non-commercial license: see `LICENSE`.
