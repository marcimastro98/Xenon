// The What's New text read from disk, kept for a minute.

const whatsNewRead = {
  cache: null,   // { at, data } — re-read from disk at most once a minute
};

module.exports = { whatsNewRead };
