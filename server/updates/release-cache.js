// What the last check for a new release found, kept so the check is not made again on every
// ask.

const releaseCache = {
  found: { at: 0, ok: false, latest: '', tag: '', url: '', notes: '', name: '', publishedAt: '', noAuto: false, mediaTypes: {} },
};

module.exports = { releaseCache };
