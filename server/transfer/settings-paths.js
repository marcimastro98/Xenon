// The folder files from a phone are saved in: kept out of the settings sent to a browser, and
// kept on disk when the browser saves.

// The transfer inbox is a folder on THIS PC. It is not a secret, but it is a
// fact about this machine that no browser needs and that every paired phone
// would otherwise receive and mirror into its own localStorage — so it travels
// exactly like one does not. The PC's own Settings pane reads the real value
// back from GET /api/transfer/settings, which is loopback-only; the wire
// carries a boolean instead, the `xKeySet` shape the credentials already use.
//
// Redacted unconditionally rather than only when `isRemote`, because a
// conditional has to be remembered at every exit point and this does not.
function redactTransferPaths(settings) {
  if (!settings || !settings.fileTransfer || typeof settings.fileTransfer !== 'object') return settings;
  const ft = settings.fileTransfer;
  return { ...settings, fileTransfer: { ...ft, inboxDir: '', inboxDirSet: !!ft.inboxDir } };
}
// …and the other half, or the round trip wipes the folder the user chose. The
// keep-prev guard in POST /settings covers the normal save; this covers the
// wholesale writers that deliberately bypass it (the backup import).
//
// THIS MACHINE's folder always wins, and an incoming one is dropped rather than
// preferred. It used to be `incoming || prev`, which made the sentence "its only
// writer is POST /api/transfer/settings" false: a backup bundle carries the key,
// /backup/import is reachable from a paired device, and that route performs none
// of the validation the settings route does — so the one door deliberately left
// in REMOTE_DENY had a second one beside it. It is also wrong on its own terms,
// with nothing to do with security: a backup taken on another PC names a folder
// that need not exist here, and importing it pointed every future arrival at a
// path on someone else's disk.
function preserveTransferPaths(incoming, prev) {
  if (!incoming || !incoming.fileTransfer || typeof incoming.fileTransfer !== 'object') return incoming;
  const prevDir = (prev && prev.fileTransfer && prev.fileTransfer.inboxDir) || '';
  return {
    ...incoming,
    fileTransfer: { ...incoming.fileTransfer, inboxDir: prevDir },
  };
}

module.exports = { redactTransferPaths, preserveTransferPaths };
