// What changes on a member's chip while the chip stays: speaking, muted, deafened, turned down by
// you.
'use strict';

(() => {
  const { t } = window.DiscordWidgetTabs;

  // The parts of a member that change while the chip stays: who is speaking,
  // their own mute and deafen, and "I turned them down" (localMute), which is a
  // different fact from "they muted themselves" and must not share a marker:
  // the glyph is theirs, the struck-through name is yours.
  function applyMemberState(chip, m) {
    chip.classList.toggle('is-speaking', !!m.speaking);
    chip.classList.toggle('is-deaf', !!m.deaf);
    chip.classList.toggle('is-muted', !!m.mute && !m.deaf);
    chip.classList.toggle('is-local-muted', !!(chip.classList.contains('is-adjustable') && m.localMute));
    const label = m.name || '';
    const state = m.deaf ? t('discord_w_member_deaf', 'deafened') : m.mute ? t('discord_w_member_muted', 'muted') : '';
    chip.title = state ? label + ' (' + state + ')' : label;
  }

  function syncMemberStates(box, members) {
    const byId = new Map(members.map(m => [m.id || '', m]));
    box.querySelectorAll('.dc-member[data-member]').forEach((chip) => {
      const m = byId.get(chip.dataset.member);
      if (m) applyMemberState(chip, m);
    });
  }

  window.DiscordWidgetMemberState = { applyMemberState, syncMemberStates };
})();
