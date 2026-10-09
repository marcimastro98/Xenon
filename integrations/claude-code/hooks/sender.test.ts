import { describe, expect, test } from 'claude-code/testing'

import { createSender } from './sender'
import type { Io } from './sender'

const LINK = { base: 'http://127.0.0.1:3030/api/claude', token: 't'.repeat(48) }

function fakeIo(answer: () => Promise<{ status: number; ok: boolean; text: string }>) {
  const bodies: Record<string, unknown>[] = []
  const io: Io = {
    fetch: async (_url, init) => {
      if (init.body) bodies.push(JSON.parse(init.body))
      return answer()
    },
    sleep: () => new Promise(() => {}),
    readLink: async () => LINK,
  }
  return { io, bodies }
}

const OK = async () => ({ status: 200, ok: true, text: '{"ok":true}' })

describe('sender', () => {
  test('sends nothing before the session id is known', async () => {
    const { io, bodies } = fakeIo(OK)
    const s = createSender('0.1.0')
    s.enqueue({ kind: 'hello' })
    await s.flush(io)
    expect(bodies.length).toBe(0)
  })

  test('stamps every message and keeps only the newest measure', async () => {
    const { io, bodies } = fakeIo(OK)
    const s = createSender('0.1.0')
    s.setSession('abc')
    s.enqueue({ kind: 'measure', contextPct: 10, rateLimits: [] })
    s.enqueue({ kind: 'agent', agentId: 'a1', type: 'Explore', model: 'claude-haiku-5-5' })
    s.enqueue({ kind: 'measure', contextPct: 12, rateLimits: [] })
    await s.flush(io)
    expect(bodies.map(b => b.kind)).toEqual(['agent', 'measure'])
    expect(bodies[1]).toEqual({ v: 1, version: '0.1.0', sessionId: 'abc', kind: 'measure', contextPct: 12, rateLimits: [] })
    expect(s.status().queued).toBe(0)
  })

  test('a hub that is off keeps the queue and backs off', async () => {
    let now = 1_000
    const { io, bodies } = fakeIo(async () => { throw new Error('ECONNREFUSED') })
    const s = createSender('0.1.0', () => now)
    s.setSession('abc')
    s.enqueue({ kind: 'hello' })
    await s.flush(io)
    expect(s.status().result).toBe('unreachable')
    expect(s.status().queued).toBe(1)
    now += 1_000
    await s.flush(io)
    expect(bodies.length).toBe(1)
  })

  test('without a link nothing is sent', async () => {
    const { io, bodies } = fakeIo(OK)
    const s = createSender('0.1.0')
    s.setSession('abc')
    s.enqueue({ kind: 'hello' })
    await s.flush({ ...io, readLink: async () => null })
    expect(s.status().result).toBe('unpaired')
    expect(bodies.length).toBe(0)
  })
})
