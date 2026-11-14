'use strict';
// The waits of the living index: before its process is started again, for an answer, and for
// the overview of a whole drive.

const RETRY_MS = 15 * 1000;
const REQ_TIMEOUT_MS = 30000;
const OVERVIEW_TIMEOUT_MS = 120000; // one consistent pass over as many as 2M entries

module.exports = { RETRY_MS, REQ_TIMEOUT_MS, OVERVIEW_TIMEOUT_MS };
