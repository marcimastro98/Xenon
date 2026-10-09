import { describe, expect, test } from 'claude-code/testing'

import { findLink, settingsFile } from './link'

const TOKEN = 'a'.repeat(48)
const ours = (url: string, token = TOKEN) => ({ type: 'http', url, headers: { 'X-Xenon-Bridge': token } })

describe('findLink', () => {
  test('reads port and token from a hook Xenon wrote', async () => {
    const settings = { hooks: { SessionStart: [{ hooks: [ours('http://127.0.0.1:3031/api/claude/event')] }] } }
    expect(findLink(JSON.stringify(settings))).toEqual({ base: 'http://127.0.0.1:3031/api/claude', token: TOKEN })
  })

  test('skips foreign hooks and finds ours behind them', async () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'echo hi' }, ours('http://example.com/api/claude/event')] },
          { matcher: 'Bash', hooks: [ours('http://127.0.0.1:3030/api/claude/question')] },
        ],
      },
    }
    expect(findLink(JSON.stringify(settings))?.base).toBe('http://127.0.0.1:3030/api/claude')
  })

  test('refuses a short token, a non-loopback host and broken JSON', async () => {
    const short = { hooks: { Stop: [{ hooks: [ours('http://127.0.0.1:3030/api/claude/turn-end', 'abc')] }] } }
    const remote = { hooks: { Stop: [{ hooks: [ours('http://192.168.1.4:3030/api/claude/turn-end')] }] } }
    expect(findLink(JSON.stringify(short))).toBeNull()
    expect(findLink(JSON.stringify(remote))).toBeNull()
    expect(findLink('{ not json')).toBeNull()
    expect(findLink('{}')).toBeNull()
  })
})

describe('settingsFile', () => {
  test('follows CLAUDE_CONFIG_DIR, else the home folder', async () => {
    expect(settingsFile({ configDir: '/cfg', home: '/home/u' })).toBe('/cfg/settings.json')
    expect(settingsFile({ home: 'C:/Users/u' })).toBe('C:/Users/u/.claude/settings.json')
    expect(settingsFile({})).toBeNull()
  })
})
