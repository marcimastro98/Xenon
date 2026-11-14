'use strict';
// Turns an event Streamer.bot reports (a follow, a subscription, a donation, a raid) into the
// short activity line the dashboard shows.

// Curated Streamer.bot events surfaced in the dashboard activity feed (phase 3):
// alerts, not chat — low-volume and meaningful. Subscribed alongside the Misc
// global-variable events. Event/source names verified against the official client.
const ACTIVITY_EVENTS = {
  Twitch: ['Follow', 'Sub', 'ReSub', 'GiftSub', 'GiftBomb', 'Cheer', 'Raid', 'RewardRedemption', 'StreamOnline', 'StreamOffline', 'Announcement', 'HypeTrainStart', 'HypeTrainEnd'],
  YouTube: ['NewSubscriber', 'SuperChat', 'SuperSticker', 'NewSponsor', 'MembershipGift', 'GiftMembershipReceived', 'MemberMileStone'],
};

// Event data shapes vary wildly per platform/type, so pull the common fields
// defensively. Returns '' / undefined when absent (the feed then shows just the type).
function sbEventUser(d) {
  if (!d || typeof d !== 'object') return '';
  if (typeof d.user === 'string') return d.user.trim();
  const u = (d.user && typeof d.user === 'object') ? d.user : {};
  return String(u.display_name || u.displayName || u.name || d.displayName || d.userName || d.user_name || d.from_name || d.gifterName || '').trim();
}
function sbEventText(d) {
  if (!d || typeof d !== 'object') return '';
  const m = d.message;
  if (typeof m === 'string') return m.trim();
  if (m && typeof m === 'object') return String(m.message || m.text || '').trim();
  return String(d.text || '').trim();
}
function sbEventAmount(d) {
  if (!d || typeof d !== 'object') return undefined;
  return [d.amount, d.bits, d.viewers, d.viewerCount, d.months, d.cumulativeMonths, d.total, d.count]
    .find((x) => typeof x === 'number' && Number.isFinite(x));
}
// Project a raw event into the compact activity item the feed renders.
function projectActivity(source, type, data) {
  const item = { source: String(source || ''), type: String(type || '') };
  const user = sbEventUser(data); if (user) item.user = user.slice(0, 80);
  const text = sbEventText(data); if (text) item.text = text.slice(0, 200);
  const amount = sbEventAmount(data); if (amount != null) item.amount = amount;
  return item;
}

module.exports = { ACTIVITY_EVENTS, sbEventUser, sbEventText, sbEventAmount, projectActivity };
