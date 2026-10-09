import type { XenonLink } from './link'
import type { Io } from './sender'

// Approvals from the Xenon dashboard. Xenon gets the tool's name and the one
// field its card shows (the command, the path, the URL…), never file content,
// an edit's text or a prompt. Only an explicit tap there becomes a decision;
// every other outcome is null, and Claude Code asks in the terminal as usual.
export type Decision = { behavior: 'allow' } | { behavior: 'deny'; message?: string }

const SHOWN_FIELDS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description'] as const
// Xenon's card shows up to this many characters (MAX_INPUT_CHARS in claude-bridge.js).
const MAX_FIELD_CHARS = 800

// The one field the card shows, or null when the card could not show what is
// being approved: a field longer than the card, or arguments with none of the
// known fields (an MCP tool). A null is never sent: the terminal asks, so an
// Allow on the dashboard never covers input the user did not see.
export function approvalInput(toolInput: unknown): Record<string, string> | null {
  const input = toolInput && typeof toolInput === 'object' ? toolInput as Record<string, unknown> : {}
  for (const key of SHOWN_FIELDS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.length <= MAX_FIELD_CHARS ? { [key]: value } : null
  }
  return Object.keys(input).length ? null : {}
}

export function asDecision(text: string): Decision | null {
  try {
    const d = (JSON.parse(text) as { decision?: { behavior?: unknown; message?: unknown } | null }).decision
    if (d?.behavior === 'allow') return { behavior: 'allow' }
    if (d?.behavior === 'deny') return typeof d.message === 'string' ? { behavior: 'deny', message: d.message } : { behavior: 'deny' }
  } catch { /* not an answer */ }
  return null
}

export type Ask = { sessionId: string; tool: string; toolInput: unknown; cwd: string; waitSec: number }

// No timeout of our own: Xenon answers within waitSec by itself, and an
// unreachable Xenon fails at once. `fetch` must be the asking hook's own
// `$.http.fetch`: the hook's 10 s budget pauses only while ITS calls are in
// flight, and the wait on the dashboard is longer than that.
export async function askXenon(fetch: Io['fetch'], link: XenonLink, ask: Ask): Promise<Decision | null> {
  const input = approvalInput(ask.toolInput)
  if (!input) return null
  const res = await fetch(`${link.base}/mod/permission`, {
    method: 'POST',
    headers: { 'X-Xenon-Bridge': link.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      sessionId: ask.sessionId,
      tool: ask.tool,
      input,
      cwd: ask.cwd,
      waitSec: ask.waitSec,
    }),
  }).catch(() => null)
  return res?.ok ? asDecision(res.text) : null
}
