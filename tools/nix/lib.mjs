// What tools/nix/bump.mjs writes into nix/source.json: the release's .deb and its
// checksum, read from the SHA256SUMS file the release pipeline publishes.

export const REPO = 'marcimastro98/Xenon';
export const DEB_ASSET = 'Xenon-Linux-x86_64.deb';

/** "5.3.0" or "v5.3.0" -> "5.3.0"; anything else throws. */
export function releaseVersion(raw) {
  const v = String(raw || '').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`not a release version: "${raw}"`);
  return v;
}

export function releaseUrl(version, asset) {
  return `https://github.com/${REPO}/releases/download/v${version}/${asset}`;
}

/** The checksum of `asset` in a SHA256SUMS text ("<hex>  <name>" or "<hex> *<name>" lines). */
export function checksumOf(sums, asset) {
  for (const line of String(sums).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (m && m[2] === asset) return m[1].toLowerCase();
  }
  throw new Error(`${asset} is not in SHA256SUMS`);
}

export function sourceJson(version, sums) {
  const v = releaseVersion(version);
  const source = { version: v, url: releaseUrl(v, DEB_ASSET), sha256: checksumOf(sums, DEB_ASSET) };
  return `${JSON.stringify(source, null, 2)}\n`;
}
