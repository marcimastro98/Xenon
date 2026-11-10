// Buying Sparks is not supporting: the wall leaves it out. BMC lists a shop purchase
// twice, under /extras and again as a one-off "support" in /supporters (same buyer,
// same moment, same money). The extras list only serves to recognise those mirrors;
// it is never added to the wall itself, since /supporters already holds every purchase.
// The hub applies the same rule to supporter passes (xenon-supporter-hub
// src/sync-supporters.js, mirrorsCreditExtra): when one changes, change both.

const SPARKS_TITLE = /\b(credits?|scintill[ae]|sparks?)\b/i;
const MIRROR_SEC = 15 * 60;

const emailOf = (r) => String(r.support_email || r.payer_email || r.supporter_email || r.email || '').trim().toLowerCase();

// 'YYYY-MM-DD HH:MM:SS' (BMC, UTC) or ISO -> unix seconds, null when unknown.
function seconds(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? t.replace(' ', 'T') + 'Z' : t);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Is this BMC extra a Sparks pack? The title says so (as the hub reads it). */
export function isSparksExtra(rec) {
  const e = rec && typeof rec.extra === 'object' && rec.extra ? rec.extra : {};
  return SPARKS_TITLE.test(String(e.reward_title || e.title || rec.reward_title || rec.extra_title || rec.title || ''));
}

/** The one-off supports that are not the mirror of a Sparks pack. */
export function withoutSparks(supports, extras) {
  const packs = (extras || []).filter(isSparksExtra).map((x) => ({
    email: emailOf(x),
    at: seconds(x.purchased_on || x.purchase_created_on || x.purchase_updated_on),
    cents: Math.round(Number(x.purchase_amount) * 100),
    currency: String(x.purchase_currency || '').toUpperCase(),
  })).filter((x) => x.email);
  return (supports || []).filter((s) => {
    const email = emailOf(s);
    const at = seconds(s.support_created_on);
    const cents = Math.round((Number(s.support_coffees) || 1) * (Number(s.support_coffee_price) || 0) * 100);
    const currency = String(s.support_currency || '').toUpperCase();
    return !packs.some((x) => x.email === email
      && (x.at == null || at == null || Math.abs(x.at - at) <= MIRROR_SEC)
      && (!Number.isFinite(x.cents) || x.currency !== currency || Math.abs(x.cents - cents) <= Math.max(50, Math.round(x.cents * 0.1))));
  });
}
