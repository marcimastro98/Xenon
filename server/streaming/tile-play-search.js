// Finding what a Twitch or YouTube tile should play from a few words.

const { hub } = require('../settings/current.js');
const { streams } = require('./providers.js');

async function tilePlaySearch(tile, q) {
  if (tile === 'twitch') {
    const r = await streams.twitch.searchChannels(q, { language: hub.settings && hub.settings.language });
    const ch = r && r.ok && Array.isArray(r.channels) ? r.channels.find((c) => c && c.live !== false) || r.channels[0] : null;
    return ch ? { value: ch.login, title: ch.name || ch.login } : { error: (r && r.error) || 'no_match' };
  }
  const r = await streams.youtube.searchVideos(q);
  const v = r && r.ok && Array.isArray(r.videos) ? r.videos.find((x) => x && x.embeddable !== false) : null;
  return v ? { value: v.id, title: v.title } : { error: (r && r.error) || 'no_match' };
}

module.exports = { tilePlaySearch };
