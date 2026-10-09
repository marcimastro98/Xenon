import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { askXenon } from './approval'
import { EMPTY_BAND, statusLine } from './band'
import { findLink, settingsFile } from './link'
import { createSender, request } from './sender'
import type { Io } from './sender'

// Xenon for Claude Code: sends the Xenon dashboard what the HTTP hooks cannot
// (each subagent's model, the live context and quota) and adds /xenon. Never
// sends prompt text or file content; an approval sends the tool's name and
// the one field the dashboard card shows (the command, the path, the URL).
const VERSION = '0.2.3'
const FLUSH_MS = 1_000
const HELLO_MS = 60_000
// These two have their own dialogs that the dashboard answers through the
// HTTP hooks, not through a plain allow.
const OWN_DIALOG = new Set(['AskUserQuestion', 'ExitPlanMode'])

const band = atom({ plugin: 'xenon', key: 'band' } as const, EMPTY_BAND)

const sender = createSender(VERSION)
// Bound once the session is ready; /xenon and the timers use it.
let io: Io | null = null

function ago(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

async function connectionReport(bound: Io): Promise<string> {
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
    okAt ? `Last update sent ${ago(Date.now() - okAt)}.` : 'Nothing sent yet in this session.',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const showBand = options.band !== false
  const approvals = options.approvals === true
  const waitSec = typeof options.approvalWaitSec === 'number' ? options.approvalWaitSec : 30

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
      sender.enqueue({ kind: 'hello', model: await $.session.model() })
    }
    await $.command.register({ name: 'xenon', description: 'Show whether the Xenon dashboard hears this session' })
    await hello()
    $.clock.every(FLUSH_MS, async () => {
      if (!io) return
      await sender.flush(io)
      const { result, okAt } = sender.status()
      await update($, band, b => (b.result === result && b.okAt === okAt ? b : { ...b, result, okAt }))
      if (showBand) $.ui.status(statusLine(await read($, band)))
    })
    $.clock.every(HELLO_MS, () => { void hello() })
    return next(e)
  })

  on('command.run', { command: 'xenon' }, async () => ({
    text: io ? await connectionReport(io) : 'Xenon: the mod is still starting. Try again in a moment.',
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

  on('agent.spawn', async (_$, e, next) => {
    const spawned = await next(e)
    if (!spawned.deny && spawned.agentId) {
      sender.enqueue({ kind: 'agent', agentId: spawned.agentId, type: e.subagentType, model: spawned.model })
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
