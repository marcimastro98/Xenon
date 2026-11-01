// Discord widget: members of a voice channel with their avatar beside their
// name. Asked for on Discord (Nov 2026): "for the users that are active on a
// channel, show their Avatar with their name".
//
// The rule that matters most is the one a screenshot cannot show: voice pushes
// arrive several times a second while people talk, and rebuilding the chips on
// each one re-creates every <img>. That is what made the avatars in the
// notification feed blink before (paintNotifs). So the chips are built from who
// is there, and what they are doing is applied to the chips already on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const W = read('../js/discord-widget.js');
const CSS = read('../components/DiscordWidget/DiscordWidget.css');
const LIGHT = read('../styles/themes-light.css');

function fn(name) {
  const at = W.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' exists');
  return W.slice(at, W.indexOf('\n  }\n', at));
}

test('who is there decides the markup; speaking and muting do not', () => {
  const shape = fn('memberShape');
  assert.match(shape, /m\.id/);
  assert.match(shape, /m\.name/);
  assert.match(shape, /m\.avatar/);
  for (const live of ['speaking', 'mute', 'deaf', 'localMute']) {
    assert.ok(!shape.includes('m.' + live), `${live} must not rebuild the chips`);
  }
  const fill = fn('fillMembers');
  assert.match(fill, /if \(box\.dataset\.dcShape !== shape\)/);
  assert.match(fill, /syncMemberStates\(box, members\)/, 'an unchanged list only gets its state applied');
});

test('the Channels tab follows the same rule', () => {
  const at = W.indexOf('function paintChannels(');
  const body = W.slice(at, W.indexOf('const frag = document.createDocumentFragment();', at));
  assert.match(body, /membersFor\(c\)\.map\(m => memberShape\(m, false\)\)/);
  assert.doesNotMatch(body, /m\.speaking \? 's'/, 'speaking in the signature rebuilt the whole list on every push');
  assert.match(body, /syncMemberStates\(list, /);
});

test('the live state is classes on the chip, never new markup', () => {
  const apply = fn('applyMemberState');
  for (const cls of ['is-speaking', 'is-deaf', 'is-muted', 'is-local-muted']) {
    assert.match(apply, new RegExp(`classList\\.toggle\\('${cls}'`), cls);
  }
  assert.doesNotMatch(apply, /innerHTML|replaceChildren|appendChild/);
  // Deafened mutes too, but says more: one glyph, the stronger one.
  assert.match(apply, /toggle\('is-muted', !!m\.mute && !m\.deaf\)/);
});

test('an avatar that cannot load leaves the initial, never a broken image', () => {
  const av = fn('memberAvatar');
  assert.match(av, /'dc-av-initial'/);
  assert.match(av, /img\.addEventListener\('error'/);
  assert.match(av, /img\.remove\(\)/);
  assert.match(av, /avatarBad\.add\(m\.avatar\)/, 'and the CDN is not asked again on every rebuild');
  assert.match(av, /setAttribute\('aria-hidden', 'true'\)/, 'a screen reader reads the name once, not "G Giulia"');
  assert.match(av, /referrerPolicy = 'no-referrer'/);
});

test('the state glyph sits after the name, at a size that reads', () => {
  // On the 20px avatar an 8px badge could not be made out; Discord's own voice
  // list puts the glyph after the name.
  assert.match(fn('memberChip'), /chip\.append\(memberAvatar\(m\), el\('span', 'dc-member-name', m\.name \|\| '—'\), state\)/);
  assert.match(CSS, /\.dc-member-state svg \{ width: 12px; height: 12px;/);
  assert.match(CSS, /\.dc-member\.is-speaking \.dc-av \{ box-shadow: 0 0 0 2px #3bd678; \}/, "Discord's green ring");
  assert.doesNotMatch(CSS, /dc-member-dot/, 'the old dot is gone');
});

test('the strip and the Channels tab read on a light theme', () => {
  for (const sel of ['.dc-member.is-speaking', '.dc-member-state', '.dc-guild', '.dc-chan-count']) {
    assert.ok(LIGHT.includes(':root[data-appearance="light"] ' + sel), sel);
  }
});

test('the state named in the tooltip is translated in every language', () => {
  const I18N = read('../js/i18n.js');
  const block = I18N.slice(I18N.indexOf('// ── Discord widget: member avatars'));
  for (const lang of ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh']) {
    const at = block.indexOf(`Object.assign(i18n.${lang}, {`);
    assert.ok(at >= 0, `${lang} missing`);
    const part = block.slice(at, block.indexOf('});', at));
    assert.match(part, /discord_w_member_muted:/, lang);
    assert.match(part, /discord_w_member_deaf:/, lang);
  }
});
