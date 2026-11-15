// The choices of the deck editor for streaming tools: an OBS scene or source, a Streamer.bot action
// or code trigger, a Discord channel.
'use strict';

window.DeckEditorStreamPick = (wrapper) => {
    const { discordChannels, enhanceSelects, input, sbActions, sbCodeTriggers, t } = wrapper;

    // A param control that starts as a text field and upgrades to a dropdown of
    // OBS's live list (scenes or audio sources) when reachable; stays a typed
    // text field when OBS is offline. `fetcher` returns a Promise<string[]>.
    function obsPickControl(step, name, fetcher, placeholderKey) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t(placeholderKey);
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      fetcher().then((items) => {
        if (!items || !items.length) return;
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        const names = (cur && !items.includes(cur)) ? [cur, ...items] : items;
        names.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
        sel.value = cur || items[0];
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // OBS scene/source list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // A param control for the sbAction kind: a dropdown of Streamer.bot's live
    // actions ({value:id, label:name}). The action is stored by id (stable across
    // renames). A typed text field is the fallback shown while streamer.bot is
    // unreachable, so an already-assigned id is never lost when offline.
    function sbActionPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_action');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      sbActions().then((items) => {
        if (!items || !items.length) return;   // offline → typed id field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        // Preserve an assigned id that's no longer in the list as a trailing option
        // so the select reads its real value instead of silently switching actions.
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // streamer.bot list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // A param control for the sbCodeTrigger kind: a dropdown of Streamer.bot code
    // triggers, stored by trigger name. A typed field is the fallback while
    // streamer.bot is unreachable, so an assigned trigger is never lost (mirrors
    // sbActionPickControl).
    function sbCodeTriggerPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_trigger');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      sbCodeTriggers().then((items) => {
        if (!items || !items.length) return;   // offline → typed name field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // code-trigger list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // A param control for the discordChannel kind: a dropdown of the user's live
    // voice channels ({value:id, label:"Guild › Channel"}), stored by channel id.
    // A typed id field is the fallback while Discord is unreachable, so an already-
    // assigned channel is never lost when offline (mirrors sbActionPickControl).
    function discordChannelPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_channel');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      discordChannels().then((items) => {
        if (!items || !items.length) return;   // offline → typed id field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // channel list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    return { obsPickControl, sbActionPickControl, sbCodeTriggerPickControl, discordChannelPickControl };
};
