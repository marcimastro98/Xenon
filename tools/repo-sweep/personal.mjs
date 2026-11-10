// Personal data and secrets that must never reach the public repo: phone
// numbers, e-mail addresses, MAC and Bluetooth addresses, this PC's user and
// machine name, private keys and tokens, and pictures that carry camera
// metadata. Fixtures may use only the invented values allowed here, so anything
// else that looks real is a finding. A name cannot be told apart from a word:
// the ones known to matter go in a private list (`words`), never in the repo.

// Invented series, compared after the country code (39 for Italy) is dropped.
const INVENTED_PHONES = [
  /^333123\d{4}$/, // mobile, 333 123 xxxx
  /^3331012345$/,
  /^06123456\d{0,2}$/, // Rome landline, 06 123456xx
  /^1?\d{3}55501\d{2}$/, // North America 555-01xx, set aside for fiction
  /^(?:44|0)?7700900\d{3}$/, // UK drama numbers
];
const UP = '01234567890123456789';
const DOWN = '98765432109876543210';

export function isInventedPhone(digits, international = false) {
  const d = digits.startsWith('39') && (international || digits.length >= 11) ? digits.slice(2) : digits;
  return new Set(d).size < 4 || UP.includes(d) || DOWN.includes(d) || /012345|123456|234567|345678|456789/.test(d)
    || INVENTED_PHONES.some((re) => re.test(d));
}

// Without a + the shape alone is not enough in code (an exit code, a byte
// count), so there a number must sit inside a string to count.
const CODE_FILE = /\.(?:[cm]?js|ts|rs|cs|swift|py|ps1|sh)$/;
const PHONE_PATTERNS = [
  { re: /(?<![\w+])\+[1-9][\d ().-]{6,18}\d(?!\w)/g, min: 9, max: 15, international: true },
  { re: /(?<![\w.+-])3\d{2}[ .-]?\d{3}[ .-]?\d{3,4}(?![\w-]|\.\d)/g, min: 10, max: 10, inString: true },
  { re: /(?<![\w.+-])0[1-9]\d{0,2}[ .-]?\d{5,8}(?![\w-]|\.\d)/g, min: 9, max: 11, inString: true },
  { re: /(?:\btel:|\bTEL[;:][^\n:]*:)\s*([+\d][\d ().-]{5,}\d)/g, min: 6, max: 15, international: true, group: 1 },
];

// Odd quotes before it on its line: the number is inside a string literal.
function insideString(text, index) {
  const before = text.slice(text.lastIndexOf('\n', index - 1) + 1, index).replace(/\\./g, '');
  return ['\'', '"', '`'].some((q) => before.split(q).length % 2 === 0);
}

// `user:pw@host` in a URL is a login, not an address; mailto: is.
const EMAIL = /(?<![\w.%+-])(?<!(?<!mailto):)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![\w-])/g;
// file@2x.png, getty@tty1.service: names with an @, not addresses.
const NOT_A_TLD = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'js', 'mjs', 'cjs', 'ts', 'css', 'html',
  'json', 'md', 'txt', 'mp4', 'webm', 'woff', 'woff2', 'ttf', 'map', 'service', 'socket', 'target', 'timer', 'mount', 'slice', 'scope']);
const EXAMPLE_DOMAIN = /(^|\.)((example|esempio)(\.[a-z]{2,6}){1,2}|example|test|invalid|localhost|local)$/i;
const ROLE_ADDRESS = /^(noreply|no-reply|donotreply|support|security|privacy|hello|info|contact|admin|team|help|feedback|bugs|abuse|postmaster|webmaster|press|legal|billing|notifications|git)$/i;
// Twitch chat writes every sender as nick!nick@nick.tmi.twitch.tv.
const NOT_MAIL_HOST = /\.tmi\.twitch\.tv$/i;

export function isAllowedEmail(address) {
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (NOT_A_TLD.has(domain.split('.').pop().toLowerCase()) || NOT_MAIL_HOST.test(domain)) return true;
  // a@b.com: a one-letter host is a stand-in, not somebody's mailbox.
  return EXAMPLE_DOMAIN.test(domain) || ROLE_ADDRESS.test(local) || domain.split('.')[0].length === 1;
}

// Third-party files shipped as they came (their authors' own public contacts).
export const isVendored = (rel) => /(^|\/)(node_modules|vendor)\//.test(rel) || rel.startsWith('server/soundvolumeview-x64/');

const MAC = /(?<![0-9A-Fa-f])(?<![0-9A-Fa-f]{2}[:_-])[0-9A-Fa-f]{2}([:_-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}(?![0-9A-Fa-f]|[:_-][0-9A-Fa-f])/g;
// Windows device ids write the Bluetooth address as 12 bare hex digits.
const MAC_BARE = /(?:\bDev_|&0&)([0-9A-Fa-f]{12})(?![0-9A-Fa-f])/g;

// Group (multicast) and locally administered addresses are never a device's own,
// and RFC 7042 sets 00-00-5E-00-53-xx aside for documentation.
export function isAllowedMac(mac) {
  const hex = mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const first = parseInt(hex.slice(0, 2), 16);
  return (first & 0x03) !== 0 || hex.startsWith('00005E0053') || /^0+$/.test(hex);
}

// The account in a home folder path: C:\Users\NAME, C:/Users/NAME, \\Users\\NAME,
// /Users/NAME, /home/NAME. Invented ones are fine in tests; this PC's is not.
const HOME = /(?:[A-Za-z]:(?:\\{1,2}|\/)[Uu]sers(?:\\{1,2}|\/)|\\{1,2}[Uu]sers\\{1,2}|(?<![\w.-])\/(?:Users|home)\/)([^\\/\s"'`<>:*?|,;()[\]{}]+)/g;
// Accounts that are nobody's name: on a CI runner or in a container the sweep must not flag them.
const GENERIC_USERS = new Set(['user', 'username', 'runner', 'admin', 'administrator', 'root', 'guest', 'public', 'default',
  'test', 'dev', 'developer', 'ci', 'vagrant', 'ubuntu', 'node', 'docker', 'app', 'pi']);

// Windows keeps a short 8.3 form too: GIOVANNA.BIANCHI -> GIOVAN~1.
export function isThisUser(name, user) {
  if (!user || GENERIC_USERS.has(user.toLowerCase())) return false;
  const a = name.toLowerCase();
  const b = user.toLowerCase();
  if (a === b) return true;
  const short = /^([^~]{1,6})~\d$/.exec(a);
  return Boolean(short) && b.replace(/[\s.]/g, '').startsWith(short[1]);
}

const SECRETS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,38}\b/g,
  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/g,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g,
];
const FAKE_SECRET = /example|x{4}|dummy|fake|placeholder|your|0{8}|test/i;

function lineFinder(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = (word) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(word)}(?![\\p{L}\\p{N}_])`, 'giu');

// This PC's name, when it looks like one (DESKTOP-4F2K9QH), not like a word.
export const machineName = (hostname) => (hostname.length >= 6 && /[\d-]/.test(hostname) && !/^localhost$/i.test(hostname) ? hostname : null);

// [{ line, kind, value }] for one text file. `words`: private names, numbers or
// nicknames to find as whole words; `user` and `machine`: this PC's account and name.
export function scanText(rel, text, { words = [], user = null, machine = null } = {}) {
  const lineOf = lineFinder(text);
  const found = [];
  const add = (index, kind, value) => found.push({ line: lineOf(index), kind, value });
  if (!rel.endsWith('.svg')) {
    const code = CODE_FILE.test(rel);
    for (const { re, min, max, international, inString, group } of PHONE_PATTERNS) {
      for (const m of text.matchAll(re)) {
        const raw = group ? m[group] : m[0];
        const digits = raw.replace(/\D/g, '');
        if (digits.length < min || digits.length > max || isInventedPhone(digits, international)) continue;
        if (inString && code && !insideString(text, m.index)) continue;
        add(m.index, 'phone', raw.trim());
      }
    }
  }
  for (const m of text.matchAll(EMAIL)) if (!isAllowedEmail(m[0])) add(m.index, 'email', m[0]);
  for (const m of text.matchAll(MAC)) if (!isAllowedMac(m[0])) add(m.index, 'mac', m[0]);
  for (const m of text.matchAll(MAC_BARE)) if (!isAllowedMac(m[1])) add(m.index, 'mac', m[1]);
  for (const m of text.matchAll(HOME)) if (isThisUser(m[1], user)) add(m.index, 'home-folder', m[0]);
  for (const re of SECRETS) for (const m of text.matchAll(re)) if (!FAKE_SECRET.test(m[0])) add(m.index, 'secret', m[0]);
  for (const word of [machine, ...words].filter(Boolean)) {
    for (const m of text.matchAll(wholeWord(word))) add(m.index, word === machine ? 'machine-name' : 'listed', m[0]);
  }
  // One number can match two phone shapes: keep each place once.
  const unique = new Map(found.map((f) => [`${f.line}:${f.kind}:${f.value}`, f]));
  return [...unique.values()].sort((a, b) => a.line - b.line);
}

// Camera or editor metadata inside a picture: EXIF (place, device, owner) or XMP.
// The containers are walked chunk by chunk: a tag searched in compressed pixels
// would turn up by chance in a large file.
export function imageMetadata(rel, buf) {
  const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
  const ascii = (at, len) => buf.toString('latin1', at, at + len);
  if (ext === '.jpg' || ext === '.jpeg') {
    for (let o = 2; o + 4 <= buf.length && buf[o] === 0xff;) {
      const marker = buf[o + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { o += marker === 0xff ? 1 : 2; continue; }
      const len = buf.readUInt16BE(o + 2);
      if (marker === 0xe1 && (ascii(o + 4, 6) === 'Exif\0\0' || ascii(o + 4, 28) === 'http://ns.adobe.com/xap/1.0/')) return 'EXIF/XMP';
      o += 2 + len;
    }
  } else if (ext === '.png') {
    for (let o = 8; o + 8 <= buf.length;) {
      const len = buf.readUInt32BE(o);
      const type = ascii(o + 4, 4);
      if (type === 'eXIf' || (type === 'iTXt' && ascii(o + 8, 18) === 'XML:com.adobe.xmp\0')) return 'EXIF/XMP';
      if (type === 'IEND') break;
      o += 12 + len;
    }
  } else if (ext === '.webp' && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    for (let o = 12; o + 8 <= buf.length;) {
      const type = ascii(o, 4);
      if (type === 'EXIF' || type === 'XMP ') return 'EXIF/XMP';
      const len = buf.readUInt32LE(o + 4);
      o += 8 + len + (len % 2);
    }
  }
  return null;
}

// "+39 3•• ••• ••67": enough to find it in the file, not enough to spread it.
export function mask(value) {
  const keep = value.length > 8 ? 2 : 1;
  return value.slice(0, keep) + value.slice(keep, -keep).replace(/[A-Za-z0-9]/g, '•') + value.slice(-keep);
}
