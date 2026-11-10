import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { askXenon } from './approval'
import { EMPTY_BAND, statusLine } from './band'
import { createInbox, tileCommand } from './inbox'
import { findLink, settingsFile } from './link'
import { createSender, request } from './sender'
import type { Io } from './sender'

// Xenon for Claude Code: sends the Xenon dashboard what the HTTP hooks cannot
// (each subagent's model, the live context and quota), brings messages typed
// on the Claude tile into this session, and adds /xenon. Never sends prompt
// text or file content; an approval sends the tool's name and the one field
// the dashboard card shows (the command, the path, the URL).
const VERSION = '0.7.0'
const FLUSH_MS = 1_000
const HELLO_MS = 60_000
const INBOX_MS = 1_000
// These two have their own dialogs that the dashboard answers through the
// HTTP hooks, not through a plain allow.
const OWN_DIALOG = new Set(['AskUserQuestion', 'ExitPlanMode'])

const band = atom({ plugin: 'xenon', key: 'band' } as const, EMPTY_BAND)

const sender = createSender(VERSION)
const inbox = createInbox()
// Bound once the session is ready; /xenon and the timers use it.
let io: Io | null = null
let inboxStarted = false
// This session's slash commands, as /-typeahead lists them, kept for the inbox.
let knownCommands: ReadonlySet<string> = new Set()
// null until a list went out, so an empty list is still sent once.
let commandsSent: string | null = null
const MAX_COMMANDS = 300
// The effort this session thinks with. Only a model request (turn.step) states
// it, and only /effort changes it between turns, so it is kept here and told to
// Xenon with every hello: a dashboard started after the session, or restarted,
// then learns it within a minute.
let currentEffort = ''
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
// When a /model typed on the tile was handed to Claude Code, and the hello that
// tells Xenon the model, bound once the session is ready.
let tileModelAt = 0
const TILE_MODEL_WINDOW_MS = 30_000
let sayHello: (() => Promise<void>) | null = null

function ago(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

async function connectionReport(bound: Io, takesMessages: boolean): Promise<string> {
  const link = await bound.readLink()
  if (!link) {
    return 'Xenon: not linked. In Xenon, open the Claude tile, choose Connect Claude Code, then start a new session.'
  }
  const where = link.base.replace(/^http:\/\//, '').replace(/\/api\/claude$/, '')
  const { result, reply } = await request(bound, link)
  if (result === 'rejected') return 'Xenon: the link is out of date. Connect Claude Code again from the Claude tile in Xenon.'
  if (result !== 'ok') return `Xenon: not reachable at ${where}. Is it running? The mod keeps retrying on its own.`
  const { okAt } = sender.status()
  return [
    `Xenon${reply?.hub ? ' ' + reply.hub : ''}: connected at ${where}.`,
    `Claude tile on the dashboard: ${reply?.tile ? 'yes' : 'no'}.`,
    takesMessages
      ? 'Messages from the tile: they arrive here while this session is idle.'
      : 'Messages from the tile: off in the mod options, so the tile continues this session in the background.',
    okAt ? `Last update sent ${ago(Date.now() - okAt)}.` : 'Nothing sent yet in this session.',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const showBand = options.band !== false
  const approvals = options.approvals === true
  const waitSec = typeof options.approvalWaitSec === 'number' ? options.approvalWaitSec : 30
  const takeMessages = options.inbox !== false

  on('session.start', async ($, e, next) => {
    io = {
      fetch: (url, init) => $.http.fetch(url, init),
      sleep: ms => $.clock.sleep(ms),
      readLink: async () => {
        const file = settingsFile({
          configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
          home: (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')),
        })
        if (!file) return null
        try { return findLink(await $.fs.read(file)) } catch { return null }
      },
    }
    const hello = async () => {
      // Read each time: the id changes after /clear.
      sender.setSession(await $.session.id())
      sender.enqueue({ kind: 'hello', model: await $.session.model(), ...(currentEffort ? { effort: currentEffort } : {}) })
      // Only when the list changed: it is the biggest thing the mod sends.
      try {
        const list = (await $.command.list()).slice(0, MAX_COMMANDS)
        knownCommands = new Set(list.map(c => c.name))
        const key = list.map(c => c.name).join(' ')
        if (key !== commandsSent) {
          commandsSent = key
          sender.enqueue({ kind: 'commands', commands: list.map(c => ({ name: c.name, description: (c.description || '').slice(0, 140) })) })
        }
      } catch { /* no list: the tile offers only the header commands */ }
    }
    sayHello = hello
    await $.command.register({ name: 'xenon', description: 'Show whether the Xenon dashboard hears this session' })
    await hello()
    $.clock.every(FLUSH_MS, async () => {
      if (!io) return
      await sender.flush(io)
      if (sender.takeWantsCommands()) { commandsSent = null; void hello() }
      const { result, okAt } = sender.status()
      await update($, band, b => (b.result === result && b.okAt === okAt ? b : { ...b, result, okAt }))
      if (showBand) $.ui.status(statusLine(await read($, band)))
    })
    $.clock.every(HELLO_MS, () => { void hello() })
    // Tile messages (inbox.ts), only where someone sees the turn they start: a
    // -p run, like the one Xenon starts to continue a session in the
    // background, draws nowhere and never asks.
    if (takeMessages && !inboxStarted && (await $.session.surfaces()).length > 0) {
      inboxStarted = true
      $.clock.every(INBOX_MS, async () => {
        if (!io) return
        await inbox.poll(io, await $.session.id(), text => {
          // A slash command typed on the tile (the header's /model, /effort and
          // /compact too) runs as a command, queued by Claude Code until the
          // session is idle, not as a message.
          const cmd = tileCommand(text, knownCommands)
          if (cmd) {
            // A model switch in a long conversation asks "Switch model?" in the
            // terminal (the cache is lost) and only that dialog's Yes applies it.
            if (cmd.command === 'model') tileModelAt = Date.now()
            void $.command.run({ command: cmd.command, args: cmd.args })
              .then(
                () => {
                  $.ui.toast(`Xenon: /${cmd.command}${cmd.args ? ' ' + cmd.args : ''}`)
                  // The header shows the new model or effort at once, not a minute later.
                  if (cmd.command === 'effort') {
                    const level = cmd.args.trim().toLowerCase()
                    if (EFFORT_LEVELS.has(level)) currentEffort = level
                    else if (level === 'auto') currentEffort = ''
                  }
                  if (cmd.command === 'model' || cmd.command === 'effort') void hello()
                },
                () => $.ui.toast(`Xenon: could not run /${cmd.command}`),
              )
            return
          }
          // Not awaited: it resolves only once the turn starts.
          void $.prompt.submit({ text, asUser: true })
            .catch(() => $.prompt.submit({ text })) // a build without asUser
            .then(
              r => sender.enqueue(typeof r.drop === 'string'
                ? { kind: 'delivery', ok: false, reason: 'dropped' }
                : { kind: 'delivery', ok: true }),
              () => sender.enqueue({ kind: 'delivery', ok: false, reason: 'refused' }),
            )
        })
      })
    }
    return next(e)
  })

  on('command.run', { command: 'xenon' }, async () => ({
    text: io ? await connectionReport(io, takeMessages) : 'Xenon: the mod is still starting. Try again in a moment.',
  }))

  on('session.measure', (_$, e, next) => {
    sender.enqueue({
      kind: 'measure',
      contextPct: e.context.percent,
      costUsd: e.cost?.usd,
      rateLimits: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    })
    return next(e)
  })

  // A model switch chosen on the tile is the person's answer already: skip the
  // terminal's "Switch model?" question for it. A switch made in the terminal
  // (the picker, a typed /model) keeps its own dialog.
  on('classic.PreModelSwitch', async (_$, e, next) => {
    if (e.source === 'command' && Date.now() - tileModelAt < TILE_MODEL_WINDOW_MS) {
      return { permissionDecision: 'allow', permissionDecisionReason: 'Chosen on the Xenon tile' }
    }
    return next(e)
  }).catch((_$, e, next) => next(e))

  // Whoever switched the model, the tile's header follows at once.
  on('classic.PostModelSwitch', async (_$, e, next) => {
    void sayHello?.()
    return next(e)
  }).catch((_$, e, next) => next(e))

  // Only reads each model request (the main loop's effort; a subagent's effort
  // and context size) and passes it on untouched.
  on('turn.step', async function* (_$, e, next) {
    const effort = typeof e.effort === 'string' && EFFORT_LEVELS.has(e.effort) ? e.effort : ''
    if (!e.agentId) {
      if (effort) currentEffort = effort
      return yield* next(e)
    }
    const out = yield* next(e)
    const u = out && out.usage
    const tokens = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
    sender.enqueue({ kind: 'agentStat', agentId: e.agentId, ...(effort ? { effort } : {}), ...(tokens > 0 ? { tokens } : {}) })
    return out
  })

  on('turn.complete', async (_$, e, next) => {
    if (e.agentId) sender.enqueue({ kind: 'agentStat', agentId: e.agentId, done: true })
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('agent.spawn', async (_$, e, next) => {
    const spawned = await next(e)
    if (!spawned.deny && spawned.agentId) {
      const description = typeof e.description === 'string' ? e.description.slice(0, 80) : ''
      sender.enqueue({ kind: 'agent', agentId: spawned.agentId, type: e.subagentType, model: spawned.model, ...(description ? { description } : {}) })
    }
    return spawned
  }).catch((_$, e, next) => next(e)) // a report, never a gate: the subagent starts

  // Optional (off by default): Claude Code asks, the Xenon dashboard answers.
  // This hook runs before the PermissionRequest hook in settings.json, so a tap
  // on the card settles the call there; with no tap within the wait, next(e)
  // goes on to that hook, which Xenon answers with "ask in the terminal".
  // Never an approval of its own: a failure here also ends in next(e).
  on('classic.PermissionRequest', async ($, e, next) => {
    if (!approvals || !io || OWN_DIALOG.has(e.tool_name)) return next(e)
    const link = await io.readLink()
    if (!link) return next(e)
    await update($, band, b => ({ ...b, waitingTool: e.tool_name }))
    try {
      const decision = await askXenon((url, init) => $.http.fetch(url, init), link, {
        sessionId: e.session_id, tool: e.tool_name, toolInput: e.tool_input, cwd: e.cwd, waitSec,
      })
      return decision ? { decision } : next(e)
    } finally {
      await update($, band, b => ({ ...b, waitingTool: '' }))
    }
  }).catch((_$, e, next) => next(e))
}
