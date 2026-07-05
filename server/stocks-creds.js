'use strict';

// twelveDataKey / finnhubKey are the OPTIONAL stock-data provider API keys. They
// are SERVER-ONLY secrets: the server's stocks.js uses them to call the provider
// and they must never reach the browser. Same preserve-on-save + redact-on-wire
// contract as stream-creds.js (OBS / Streamer.bot passwords).
//
// Both halves are REQUIRED together. Redact without preserve and the next normal
// client save (which never carries the real key) wipes it; preserve without
// redact and the secret keeps leaking to the browser. Do not add just one.

const STOCK_SECRET_KEYS = ['twelveDataKey', 'finnhubKey'];

// preserveStockCreds: when an incoming client payload omits (or empties) a stock
// API key, carry the persisted one over so a client save can never wipe a key
// the client never received. Mutates and returns `incoming`.
function preserveStockCreds(incoming, prev) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (!prev || typeof prev !== 'object') return incoming;
  for (const key of STOCK_SECRET_KEYS) {
    if (!incoming[key] && prev[key]) incoming[key] = prev[key];
  }
  return incoming;
}

// redactStockCreds: blank the stock API keys before settings reach the browser
// and expose only a `*Set` boolean so the UI can show a "saved" placeholder.
// Returns a shallow copy (persisted/in-memory settings keep the real values).
function redactStockCreds(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  return {
    ...settings,
    twelveDataKey: '',
    twelveDataKeySet: !!settings.twelveDataKey,
    finnhubKey: '',
    finnhubKeySet: !!settings.finnhubKey,
  };
}

module.exports = { preserveStockCreds, redactStockCreds };
