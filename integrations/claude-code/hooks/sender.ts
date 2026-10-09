import type { SendResult } from '../types'
import type { XenonLink } from './link'

// Everything the mod tells Xenon goes through here, and nothing here may slow
// Claude Code down: hooks only enqueue, a timer flushes, a request that takes
// longer than REQUEST_TIMEOUT_MS is given up on, and a hub that is off is
// retried on a growing backoff instead of on every event.
export type Message =
  | { kind: 'hello'; model?: string }
  | { kind: 'measure'; contextPct?: number; costUsd?: number; rateLimits: RateLimit[] }
  | { kind: 'agent'; agentId: string; type: string; model: string }

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type Reply = { hub?: string; tile?: boolean }

// The host calls the mod needs, bound by the hook that builds them.
export type Io = {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
    Promise<{ status: number; ok: boolean; text: string }>
  sleep: (ms: number) => Promise<void>
  readLink: () => Promise<XenonLink | null>
}

const PROTOCOL = 1
const REQUEST_TIMEOUT_MS = 800
const MAX_QUEUE = 40
const BACKOFF_FIRST_MS = 5_000
const BACKOFF_MAX_MS = 60_000

export async function request(io: Io, link: XenonLink, body?: object): Promise<{ result: SendResult; reply?: Reply }> {
  const call = io.fetch(`${link.base}/mod`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Xenon-Bridge': link.token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => null)
  const timeout = io.sleep(REQUEST_TIMEOUT_MS).then(() => null)
  const res = await Promise.race([call, timeout])
  if (!res) return { result: 'unreachable' }
  if (res.status === 403) return { result: 'rejected' }
  if (!res.ok) return { result: 'unreachable' }
  try { return { result: 'ok', reply: JSON.parse(res.text) as Reply } } catch { return { result: 'ok' } }
}

export function createSender(version: string, now: () => number = Date.now) {
  let sessionId = ''
  let link: XenonLink | null = null
  let queue: Message[] = []
  let sending = false
  let failures = 0
  let retryAt = 0
  let last: { result: SendResult | ''; okAt: number } = { result: '', okAt: 0 }

  function enqueue(msg: Message) {
    // Only the newest measure matters; agents and hellos are kept in order.
    if (msg.kind === 'measure') queue = queue.filter(m => m.kind !== 'measure')
    queue.push(msg)
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
  }

  function settle(result: SendResult) {
    const at = now()
    last = { result, okAt: result === 'ok' ? at : last.okAt }
    if (result === 'ok') { failures = 0; retryAt = 0; return }
    failures += 1
    retryAt = at + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failures - 1))
    // A rejected token means Xenon was relinked: read the link again next time.
    if (result !== 'unreachable') link = null
  }

  async function flush(io: Io) {
    if (sending || !sessionId || !queue.length || now() < retryAt) return
    sending = true
    try {
      link = link || await io.readLink()
      if (!link) return settle('unpaired')
      while (queue.length) {
        const { result } = await request(io, link, { v: PROTOCOL, version, sessionId, ...queue[0] })
        if (result !== 'ok') return settle(result)
        queue.shift()
      }
      settle('ok')
    } finally {
      sending = false
    }
  }

  return {
    enqueue,
    flush,
    setSession(id: string) { sessionId = id },
    status: () => ({ ...last, queued: queue.length }),
  }
}
