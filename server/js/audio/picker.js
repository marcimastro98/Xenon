'use strict';

let pickerLetGo = null;

function pickerRow(type, dev, currentId) {
  const inUse = dev.id === currentId;
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'picker-item';
  if (inUse) item.setAttribute('aria-current', 'true');
  const text = document.createElement('div');
  text.className = 'picker-item-text';
  const name = document.createElement('div');
  name.className = 'picker-item-name';
  name.textContent = dev.name || dev.label;
  text.appendChild(name);
  if (dev.name && dev.label && dev.label !== dev.name) {
    const lbl = document.createElement('div');
    lbl.className = 'picker-item-label';
    lbl.textContent = dev.label;
    text.appendChild(lbl);
  }
  const check = document.createElement('div');
  check.className = 'picker-check' + (inUse ? ' checked' : '');
  item.appendChild(text);
  item.appendChild(check);
  item.addEventListener('click', () => selectDevice(type, dev.id));
  return item;
}

function pickerFreeze(on) {
  if (typeof window.ambientFreeze === 'function') window.ambientFreeze('device-picker', on);
}

function openPicker(type) {
  if (!audioData) return;
  const isSpeaker = type === 'speaker';
  pickerTitle.textContent = isSpeaker ? t('picker_speaker') : t('picker_mic');
  const devices = (isSpeaker ? audioData.speakers : audioData.mics) || [];
  const currentId = isSpeaker ? (audioData.speaker && audioData.speaker.id) : (audioData.mic && audioData.mic.id);
  pickerList.innerHTML = '';

  devices.forEach(dev => pickerList.appendChild(pickerRow(type, dev, currentId)));
  if (!devices.length) {
    const none = document.createElement('div');
    none.className = 'picker-empty';
    none.textContent = t('picker_none');
    pickerList.appendChild(none);
  }

  pickerOverlay.classList.add('open');
  pickerFreeze(true);
  if (window.DialogFocus && !pickerLetGo) {
    pickerLetGo = window.DialogFocus.hold(pickerOverlay.querySelector('.picker-panel'), { onEsc: closePicker });
  }
}

function closePicker() {
  pickerOverlay.classList.remove('open');
  pickerFreeze(false);
  if (pickerLetGo) { pickerLetGo(); pickerLetGo = null; }
}

async function selectDevice(type, id) {
  closePicker();
  const endpoint = type === 'speaker' ? '/speaker/set' : '/mic/set';
  try {
    const res = await fetch(SERVER + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error('Device switch failed');
    setOnline();
    setTimeout(fetchAudio, 600);
  } catch { setOffline(); }
}
