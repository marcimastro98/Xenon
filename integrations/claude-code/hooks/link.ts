// Where the mod reaches Xenon, read from the link Xenon's "Connect Claude Code"
// button already wrote into the user's settings.json: the hook URLs carry the
// port, their X-Xenon-Bridge header the token. No second pairing step, no
// secret in this code, and unlinking in Xenon unpairs the mod too.
export type XenonLink = { base: string; token: string }

const OUR_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/api\/claude\//
const MIN_TOKEN = 32

type Handler = { type?: unknown; url?: unknown; headers?: unknown }

function linkFromHandler(h: Handler): XenonLink | null {
  if (!h || h.type !== 'http' || typeof h.url !== 'string') return null
  const m = OUR_URL.exec(h.url)
  const headers = h.headers && typeof h.headers === 'object' ? (h.headers as Record<string, unknown>) : {}
  const token = headers['X-Xenon-Bridge']
  if (!m || typeof token !== 'string' || token.length < MIN_TOKEN) return null
  return { base: `http://127.0.0.1:${m[1]}/api/claude`, token }
}

export function findLink(settingsText: string): XenonLink | null {
  let settings: unknown
  try { settings = JSON.parse(settingsText) } catch { return null }
  const hooks = settings && typeof settings === 'object' ? (settings as { hooks?: unknown }).hooks : null
  if (!hooks || typeof hooks !== 'object') return null
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const handlers: Handler[] = group && Array.isArray(group.hooks) ? group.hooks : []
      for (const h of handlers) {
        const link = linkFromHandler(h)
        if (link) return link
      }
    }
  }
  return null
}

// Claude Code's own rule: CLAUDE_CONFIG_DIR, else ~/.claude (USERPROFILE on
// Windows, where HOME is often unset).
export function settingsFile(env: { configDir?: string; home?: string }): string | null {
  if (env.configDir) return `${env.configDir}/settings.json`
  return env.home ? `${env.home}/.claude/settings.json` : null
}
