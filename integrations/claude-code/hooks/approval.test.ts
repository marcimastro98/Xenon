import { describe, expect, test } from 'claude-code/testing'

import { approvalInput, asDecision, askXenon } from './approval'
import { EMPTY_BAND, statusLine } from './band'

const LINK = { base: 'http://127.0.0.1:3030/api/claude', token: 'a'.repeat(48) }
const ASK = { sessionId: 's1', tool: 'Write', toolInput: { file_path: '/a.txt', content: 'secret' }, cwd: '/w', waitSec: 30 }

describe('approvalInput', () => {
  test('keeps only the field the card shows, never file content', async () => {
    expect(approvalInput({ file_path: '/a.txt', content: 'secret' })).toEqual({ file_path: '/a.txt' })
    expect(approvalInput({ description: 'Run tests', prompt: 'the whole prompt' })).toEqual({ description: 'Run tests' })
    expect(approvalInput(null)).toEqual({})
  })

  test('nothing to approve that the card cannot show in full', async () => {
    expect(approvalInput({ command: 'x'.repeat(801) })).toBe(null)
    expect(approvalInput({ query_id: 7, body: 'mcp args' })).toBe(null)
  })
})

describe('asDecision', () => {
  test('only an explicit allow or deny is a decision', async () => {
    expect(asDecision('{"decision":{"behavior":"allow"}}')).toEqual({ behavior: 'allow' })
    expect(asDecision('{"decision":{"behavior":"deny","message":"no"}}')).toEqual({ behavior: 'deny', message: 'no' })
    expect(asDecision('{"decision":null}')).toBe(null)
    expect(asDecision('{"decision":{"behavior":"ask"}}')).toBe(null)
    expect(asDecision('not json')).toBe(null)
  })
})

describe('askXenon', () => {
  test('a command longer than the card is never sent, the terminal asks', async () => {
    let called = false
    const fetch = async () => { called = true; return { status: 200, ok: true, text: '{"decision":{"behavior":"allow"}}' } }
    expect(await askXenon(fetch, LINK, { ...ASK, tool: 'Bash', toolInput: { command: 'x'.repeat(900) } })).toBe(null)
    expect(called).toBe(false)
  })

  test('an unreachable Xenon is no decision', async () => {
    const fetch = async () => { throw new Error('refused') }
    expect(await askXenon(fetch, LINK, ASK)).toBe(null)
  })

  test('a rejected token is no decision', async () => {
    const fetch = async () => ({ status: 403, ok: false, text: '{"decision":{"behavior":"allow"}}' })
    expect(await askXenon(fetch, LINK, ASK)).toBe(null)
  })

  test('sends the trimmed input and reads the tap', async () => {
    let sent = ''
    const fetch = async (_url: string, init: { body?: string }) => {
      sent = init.body || ''
      return { status: 200, ok: true, text: '{"decision":{"behavior":"allow"}}' }
    }
    expect(await askXenon(fetch, LINK, ASK)).toEqual({ behavior: 'allow' })
    expect(sent.includes('secret')).toBe(false)
  })
})

describe('statusLine', () => {
  test('is silent while all is well, speaks when something needs attention', async () => {
    expect(statusLine(EMPTY_BAND)).toBe(undefined)
    expect(statusLine({ ...EMPTY_BAND, result: 'ok', okAt: 1 })).toBe(undefined)
    expect(statusLine({ ...EMPTY_BAND, result: 'unreachable' })).toBe('Xenon is not reachable, retrying')
    expect(statusLine({ ...EMPTY_BAND, result: 'ok', waitingTool: 'Bash' }))
      .toBe('Bash is waiting for your answer on the dashboard')
  })
})
