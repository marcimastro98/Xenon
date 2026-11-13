// What a new install starts with, eighth part: which screen it shows on, the language, and what
// the install remembers about itself.

const HUB_DEFAULTS_INSTALL = Object.freeze({
  // Which screen the user chose for Xenon (asked once at first run): 'auto',
  // 'screen' (named in `monitor`), or 'phone'. Client-owned and client-sent —
  // see normalizeSurface in js/settings.js, which must stay in step with the
  // normalizer below or the settings-server-owned-keys test fails.
  //
  // This is NOT the authority for where the native window opens: the shell keeps
  // that in its own display.json, because it has to read it at launch, before
  // the backend is necessarily running. This copy exists so Settings can show
  // the choice on every surface, and so a paired phone — which has no way to
  // speak to the shell — can still ask for it.
  // NOT `surface`: that key is the theme's panel colour. See surfaceChoiceFrom().
  surfaceChoice: Object.freeze({ kind: 'auto', asked: false, monitor: '', label: '' }),
  language: '', // '' = follow the browser; a WEATHER_LANGS code persists the user's chosen UI language across browser-storage resets
  // Identity of this settings store, minted on the first write (see
  // SETTINGS_STORE_ID_RE). Empty here because a default blob has not been
  // persisted yet; server-owned, so POST /settings keeps the stored value.
  storeId: '',
  // How long this install has actually been USED, which is the only honest basis
  // for asking anything of the person using it. All three are server-owned like
  // storeId above — the browser never writes them, and POST /settings keeps the
  // stored values, or clearing site data would reset the clock and the ask could
  // come round again.
  //
  // `usageDays` counts DAYS the dashboard was opened, not launches and not hours:
  // an engine that runs at logon on a PC nobody looks at must not accumulate
  // credit. See noteUsageDay().
  firstRunDay: '',          // YYYY-MM-DD, stamped the first time a dashboard connects
  lastUsageDay: '',         // the last day counted, so a day counts exactly once
  usageDays: 0,
  // The one-time supporter ask (js/support-card.js). Shown once in the life of an
  // install and never again — on disk, not in localStorage, because a browser set
  // to clear its site data would otherwise bring it back for good.
  supportAskSeen: false,
  // The day that ask went away, so the December appeal (js/support-appeal.js)
  // keeps a month between the two; '' on installs that saw it before the field.
  supportAskSeenDay: '',
  // The last calendar year the December appeal was shown. Once a year, at most.
  supportAppealYear: 0,
  // The one-time "show off your setup" invitation (js/share-nudge.js). Same
  // rules as the ask above, same reason it is here and not in localStorage.
  shareNudgeSeen: false,
});

module.exports = { HUB_DEFAULTS_INSTALL };
