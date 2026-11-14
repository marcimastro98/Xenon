'use strict';
// The shapes a widget package's names must have: its id, the ids inside it, its entry file, a
// path segment, and the file types it may ship.

// Package ids are folder names: short, lowercase, no dots/slashes → they can
// never traverse and are safe inside a URL path segment.
const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

// Ids for hooks, deck macros and deck states share the package-id charset, so a
// composite ref like "pkg/macro" splits unambiguously on the first '/'.
const SDK_SUB_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// Entry document and asset filenames (per path segment): conservative charset,
// must carry an allowlisted extension, and '..' is impossible by construction.
const ENTRY_RE = /^[A-Za-z0-9._-]+\.html?$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

const ASSET_MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
});

module.exports = { WIDGET_ID_RE, SDK_SUB_ID_RE, ENTRY_RE, SEGMENT_RE, ASSET_MIME };
