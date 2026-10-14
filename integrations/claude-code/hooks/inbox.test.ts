import { describe, expect, test } from 'claude-code/testing'

import { askInbox, createInbox } from './inbox'
import type { Io } from './sender'

const LINK = { base: 'http://127.0.0.1:3030/api/claude', token: 'i'.repeat(48) }

type Answer = { status: number; ok: boolean; text: string }

function fakeIo(answer: () => Promise<Answer>) {
  const calls: { url: string; body: Record<string, unknown>; token: string }[] = []
  let links = 0
  const io: Io = {
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body || '{}'), token: init.headers['X-Xenon-Bridge'] })
      return answer()
    },
    sleep: () => new Promise(() => {}),
    readLink: async () => { links += 1; return LINK },
  }
  return { io, calls, links: () => links }
}

const reply = (status: number, text: string) => async () => ({ status, ok: status >= 200 && status < 300, text })

describe('askInbox', () => {
  test('reads a message, and asks for this session only', async () => {
    const { io, calls } = fakeIo(reply(200, '{"text":"write the tests"}'))
    expect(await askInbox(io.fetch, LINK, 's1')).toEqual({ result: 'message', text: 'write the tests' })
    expect(calls[0].url).toBe('http://127.0.0.1:3030/api/claude/mod/inbox')
    expect(calls[0].body).toEqual({ v: 1, sessionId: 's1' })
    expect(calls[0].token).toBe(LINK.token)
  })

  test('an empty answer or a blank text is no message', async () => {
    expect(await askInbox(fakeIo(reply(200, '{}')).io.fetch, LINK, 's1')).toEqual({ result: 'empty' })
    expect(await askInbox(fakeIo(reply(200, '{"text":"  "}')).io.fetch, LINK, 's1')).toEqual({ result: 'empty' })
  })

  test('a rejected token, an error or an answer that is not Xenon is no message', async () => {
    expect(await askInbox(fakeIo(reply(403, 'Forbidden')).io.fetch, LINK, 's1')).toEqual({ result: 'rejected' })
    expect(await askInbox(fakeIo(reply(429, 'Busy')).io.fetch, LINK, 's1')).toEqual({ result: 'unreachable' })
    expect(await askInbox(fakeIo(reply(200, '<!doctype html>')).io.fetch, LINK, 's1')).toEqual({ result: 'unreachable' })
    const off = fakeIo(async () => { throw new Error('ECONNREFUSED') })
    expect(await askInbox(off.io.fetch, LINK, 's1')).toEqual({ result: 'unreachable' })
  })
})

describe('inbox', () => {
  test('hands a message over and keeps asking', async () => {
    const { io, calls } = fakeIo(reply(200, '{"text":"run it"}'))
    const inbox = createInbox()
    const got: string[] = []
    await inbox.poll(io, 's1', text => { got.push(text) })
    await inbox.poll(io, 's1', text => { got.push(text) })
    expect(got).toEqual(['run it', 'run it'])
    expect(calls.length).toBe(2)
  })

  test('one ask at a time while the hub holds the first', async () => {
    let release: (a: Answer) => void = () => {}
    const { io, calls } = fakeIo(() => new Promise<Answer>(r => { release = r }))
    const inbox = createInbox()
    const first = inbox.poll(io, 's1', () => {})
    await inbox.poll(io, 's1', () => {})
    release({ status: 200, ok: true, text: '{}' })
    await first
    expect(calls.length).toBe(1)
  })

  test('nothing is asked before the session id is known or without a link', async () => {
    const { io, calls } = fakeIo(reply(200, '{}'))
    const inbox = createInbox()
    await inbox.poll(io, '', () => {})
    await inbox.poll({ ...io, readLink: async () => null }, 's1', () => {})
    expect(calls.length).toBe(0)
  })

  test('a hub that is off is asked again only after a backoff', async () => {
    let now = 1_000
    const { io, calls } = fakeIo(async () => { throw new Error('ECONNREFUSED') })
    const inbox = createInbox(() => now)
    await inbox.poll(io, 's1', () => {})
    now += 1_000
    await inbox.poll(io, 's1', () => {})
    expect(calls.length).toBe(1)
    now += 5_000
    await inbox.poll(io, 's1', () => {})
    expect(calls.length).toBe(2)
  })

  test('a rejected token reads the link again', async () => {
    let now = 1_000
    const { io, links } = fakeIo(reply(403, 'Forbidden'))
    const inbox = createInbox(() => now)
    await inbox.poll(io, 's1', () => {})
    now += 10_000
    await inbox.poll(io, 's1', () => {})
    expect(links()).toBe(2)
  })
})
