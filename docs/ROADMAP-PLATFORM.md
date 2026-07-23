# Xenon Platform Roadmap — from dashboard to creator platform

> **Scope note:** this document describes the multi-phase evolution of Xenon's
> *creator platform* (content kinds, marketplace, extensibility). It is **not**
> the retired app-feature `ROADMAP.md` — app features keep living in the
> changelog and GitHub issues. Phases beyond Phase 1 are direction, not
> commitment: they ship only when their security story is ready.

Xenon's goal is to become the best place for creators to build, share and — for
those who want to — sell content for a glanceable touchscreen dashboard:
richer than the Elgato Stream Deck Marketplace in creative surface, and safer
by construction. The strategy is a **ladder of trust**: every rung adds
creator power, and only adds the *minimum* trust required for it.

| Level | What creators ship | Trust required | Status |
|---|---|---|---|
| **L0 — Content** | Themes, pages, Deck profiles, backgrounds, ambient layouts, **icon packs, sound packs** | None — declarative data, validated on import | ✅ Shipping (icons/sounds: Phase 1) |
| **L1 — Sandboxed widgets** | SDK widgets & ambient scenes (HTML in a locked iframe, permission-gated action categories) | None — the sandbox CSP is a technical guarantee | ✅ Shipping (SDK v1) |
| **L2 — Connectors** | Sandboxed widgets that additionally talk to *user-approved* local endpoints (OBS-style local APIs) | Low — the user approves each endpoint explicitly | 🔮 Phase 2 |
| **L3 — Native plugins** | Real processes that extend the action registry itself | High — signed, human-reviewed, remotely revocable | 🔮 Phase 3 |

The core invariant never changes: **importing a stranger's creation must stay
as safe as importing a wallpaper** at L0/L1, and every step above that must be
opt-in, visible, and revocable.

---

## Phase 1 — Marketplace v2 *(shipped in v4.6.0 – v4.7.0)*

Closes the content-category gaps vs. the Elgato Marketplace and upgrades the
community gallery from a moderated list into a real marketplace flow — with
zero change to the security model.

1. **Icon packs** (`icons` preset kind) — installable packs of SVG/PNG key
   icons for the Deck. Packs appear as sections in the key icon picker; a
   picked icon is embedded into the key, so profiles stay self-contained and
   keep working if the pack is removed. SVGs are validated fail-closed at the
   install boundary (reject, never rewrite).
2. **Sound packs + Soundboard** (`sounds` preset kind) — installable packs of
   audio clips with a dedicated *Soundboard* action category on Deck keys and
   in the Widget SDK. Pack-relative clips survive Deck-profile export/import,
   fixing the long-standing "sounds don't travel" limitation.
3. **Creator submission portal** — a public "Publish" page on xenon-app.com:
   paste your share code, add screenshots, submit. Submissions land in a
   moderated queue on the supporter hub and are reviewed by a human before
   publishing. No GitHub account required. The GitHub issue form remains as an
   alternative channel.
4. **Versioning & updates for every kind** — installs record the catalog entry
   and version they came from; the gallery and Installed content flag updates
   for *all* kinds (previously widgets/ambient only). Updating always re-runs
   the normal import preview — an update can never silently change permissions.
5. **Anonymous star ratings** — 1–5 stars per catalog entry, keyed on the
   anonymous per-install id (no account, no text, no PII). Averages show only
   once an entry has enough votes. This is anti-abuse-*lite* by design: the
   install id raises the cost of ballot stuffing, it does not make it
   impossible; display rules and rate limits do the rest.

## Phase 2 — L2 Connectors *(future)*

Most Stream Deck plugins are, in essence, a client for a local API (OBS,
Home Assistant bridges, voice changers, printers…). Phase 2 lets a sandboxed
widget request **specific local endpoints** in its manifest (`localEndpoints`),
each shown to the user as its own permission ("talk to `127.0.0.1:4455` —
OBS WebSocket?"). The host mediates all traffic (the widget still has zero
direct network), adding a brokered WebSocket channel to the existing fetch
proxy. This unlocks the majority of "plugin-shaped" integrations while keeping
the L1 guarantee intact. Also in scope: per-device soundboard audio routing,
a `create-xenon` CLI (scaffold, dev hot-reload, validate, pack, publish),
TypeScript bridge types, and a developer portal.

## Phase 3 — L3 Native plugins *(future)*

The full-power tier, for the minority of integrations that genuinely need
native code. Design pillars, all mandatory before anything ships:

- **Signed format** (`.xenonplugin`): author-signed, maintainer-countersigned
  at publication. Sideloading requires developer mode plus a strong warning.
- **Process host**: plugins run as supervised child processes speaking a
  versioned RPC over loopback with a one-time token.
- **Registry extension** — the differentiator: a native plugin doesn't build a
  silo; it *registers new action types and streams* into the central action
  registry, so Deck keys, sandboxed widgets, ambient scenes and Xenon AI can
  all use them. One plugin enriches the whole platform.
- **Review + revocation**: human review of every submission and delta, and a
  remote revocation list served by the hub (a malicious plugin can be switched
  off ecosystem-wide). Editorial rule: *native only if impossible at L1/L2* —
  reviews reject plugins that could have been connectors.

## Phase 4 — Payments *(future)*

Creator monetization already works today via locked bundles (offline access
codes and hub-gated remote locks) driven by Buy Me a Coffee. Phase 4 layers a
real storefront on those rails: a merchant-of-record checkout (tax/VAT
handled), automatic entitlements replacing manually issued codes, and creator
payouts. Open questions (payout rails, refund policy, revenue split) are
deliberately unresolved until Phases 1–2 prove the catalog demand.

---

## Cross-cutting principles (hold across all phases)

- **Installs always flow through the import preview.** Nothing from the
  catalog, a link, a code or an update ever auto-applies or auto-grants.
- **The sandbox CSP is the kill-switch** for L1/L2; relaxing it is a security
  regression, not a feature.
- **Install id ≠ identity.** Xenon remains account-free and telemetry-free.
  The per-install UUID never leaves the machine: what reaches the hub is a
  one-way hash of it, and entitlements and vote dedup use two different hashes,
  so the codes a supporter has redeemed cannot be matched against the ratings
  they have cast. Neither value is ever treated as proof of person.
- **Hub endpoints stay minimal and fail closed.** Fixed base URLs, scoped
  CORS exceptions only where a browser must call them, mandatory abuse
  protection before any public write endpoint goes live.
- **One validation boundary.** Every action — from a Deck key, a widget, a
  macro or (later) a plugin — is validated server-side in the same registry.

## Status

| Phase | Content | Status |
|---|---|---|
| 1 | Icon packs, sound packs/soundboard, submission portal, versioning for all kinds, star ratings | ✅ Shipped (v4.6.0 – v4.7.0) |
| 2 | L2 connectors, CLI + TS types + dev portal, audio routing | 🔮 Planned |
| 3 | Native plugins: signing, process host, registry extension, review + revocation | 🔮 Planned |
| 4 | Storefront: merchant-of-record checkout, entitlements, payouts | 🔮 Planned |
