import type { XenonLink } from './link'
import type { Io } from './sender'

// Messages typed on the Xenon Claude tile for this session while it is idle.
// The mod asks Xenon from a timer; Xenon holds the request open until a message
// is queued or about 20 s pass, so a message arrives at once and Xenon knows
// this session is listening. register.tsx starts a turn with what arrives, as
// if it were typed here. Nothing goes back to Xenon but whether it got in.
export type InboxAnswer =
  | { result: 'message'; text: string }
  | { result: 'empty' }
  | { result: 'rejected' }
  | { result: 'unreachable' }

const PROTOCOL = 1
const BACKOFF_FIRST_MS = 5_000
const BACKOFF_MAX_MS = 60_000

// No timeout of our own: Xenon answers within about 20 s by itself, under the
// 30 s the host gives one request, and an unreachable Xenon fails at once.
// Anything that is not Xenon's answer (an older Xenon without the inbox) reads
// as unreachable, so the timer backs off instead of asking every second.
export async function askInbox(fetch: Io['fetch'], link: XenonLink, sessionId: string): Promise<InboxAnswer> {
  const res = await fetch(`${link.base}/mod/inbox`, {
    method: 'POST',
    headers: { 'X-Xenon-Bridge': link.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: PROTOCOL, sessionId }),
  }).catch(() => null)
  if (!res) return { result: 'unreachable' }
  if (res.status === 403) return { result: 'rejected' }
  if (!res.ok) return { result: 'unreachable' }
  try {
    const text = (JSON.parse(res.text) as { text?: unknown }).text
    return typeof text === 'string' && text.trim() ? { result: 'message', text } : { result: 'empty' }
  } catch {
    return { result: 'unreachable' }
  }
}

export function createInbox(now: () => number = Date.now) {
  let link: XenonLink | null = null
  let asking = false
  let failures = 0
  let retryAt = 0

  function backOff(relink: boolean) {
    failures += 1
    retryAt = now() + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failures - 1))
    // A rejected token means Xenon was relinked: read the link again next time.
    if (relink) link = null
  }

  // One ask at a time: the timer ticks every second and an ask is held for up
  // to 20. `deliver` must not wait for the turn it starts.
  async function poll(io: Io, sessionId: string, deliver: (text: string) => void) {
    if (asking || !sessionId || now() < retryAt) return
    asking = true
    try {
      link = link || await io.readLink()
      if (!link) return backOff(true)
      const answer = await askInbox(io.fetch, link, sessionId)
      if (answer.result === 'rejected' || answer.result === 'unreachable') return backOff(answer.result === 'rejected')
      failures = 0
      retryAt = 0
      if (answer.result === 'message') deliver(answer.text)
    } finally {
      asking = false
    }
  }

  return { poll }
}
