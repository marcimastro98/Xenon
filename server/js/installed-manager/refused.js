// What the list of installed things says about a widget that was not loaded, or that the sandbox
// blocks: why a folder was refused, and what the sandbox stops, kind by kind. Folder names, hosts
// and files go in as text. Nothing here decides what a widget may do.
'use strict';

(() => {
  const t = (k, fb) => {
    const v = (typeof window.t === 'function') ? window.t(k) : k;
    return (v === k && fb != null) ? fb : v;
  };
  const el = makeEl; // shared DOM factory from utils.js

  // The package scan already records WHY it skipped a folder (server-side
  // listPackages → `invalid`), and the host has always cached that list — but
  // nothing ever put it on screen. So dropping a folder Xenon can't read meant
  // the widget simply never appeared, with no message anywhere: the user was
  // left guessing, which is exactly the silent no-op the project forbids. The
  // reported case was a folder named "ip-info-widget 1.0.0" — the folder name IS
  // the package id, so a space and dots fail the id rule and the whole folder is
  // skipped. Listing it here with the reason turns a dead end into a fix.
  const REJECT_HINTS = {
    bad_id: ['installed_bad_id', 'Il nome della cartella può contenere solo lettere minuscole, cifre e trattini. Rinominala (per esempio «ip-info-widget») e riapri lo Store.'],
    id_mismatch: ['installed_bad_id_mismatch', 'L\'id nel manifest.json non corrisponde al nome della cartella. Rendili identici.'],
    missing_manifest: ['installed_no_manifest', 'Manca manifest.json nella cartella.'],
    bad_manifest: ['installed_bad_manifest', 'manifest.json non è leggibile o è troppo grande.'],
    missing_entry: ['installed_no_entry', 'Il file indicato da "entry" nel manifest non esiste nella cartella.'],
    bad_entry: ['installed_bad_entry', 'Il campo "entry" del manifest non è valido.'],
    missing_name: ['installed_no_name', 'Nel manifest manca il campo "name".'],
    bad_version: ['installed_bad_version', 'Il campo "version" del manifest non è valido.'],
    unsupported_api: ['installed_bad_api', 'Il widget dichiara una versione di API che questa build non supporta.'],
    too_large: ['installed_too_large', 'La cartella supera il limite di dimensione.'],
  };

  function rejectHint(reason) {
    const hit = REJECT_HINTS[reason];
    if (hit) return t(hit[0], hit[1]);
    // Unknown/rarer reasons (bad_hosts, bad_deck, bad_storage_group…) still get a
    // real answer: the raw code names the offending manifest field precisely
    // enough for a creator to act on, which beats inventing a vague sentence.
    return t('installed_bad_generic', 'Il manifest non ha superato il controllo ({r}).').replace('{r}', String(reason || '?'));
  }

  function rejectedBlock(invalid) {
    if (!Array.isArray(invalid) || !invalid.length) return null;
    const box = el('div', 'inst-rejected');
    box.appendChild(el('p', 'inst-rejected-title', invalid.length === 1
      ? t('installed_rejected_one', '1 cartella widget non è stata caricata')
      : t('installed_rejected_n', '{n} cartelle widget non sono state caricate').replace('{n}', String(invalid.length))));
    const list = el('div', 'inst-rejected-list');
    invalid.forEach((bad) => {
      const row = el('div', 'inst-rejected-row');
      // Folder names are untrusted filesystem text → textContent, never markup.
      row.appendChild(el('code', 'inst-rejected-name', String((bad && bad.id) || '?')));
      row.appendChild(el('span', 'inst-rejected-why', rejectHint(bad && bad.reason)));
      list.appendChild(row);
    });
    box.appendChild(list);
    box.appendChild(el('p', 'cgal-status', t('installed_rejected_foot', 'Le cartelle si trovano in server/data/widgets. Dopo averle sistemate, riapri lo Store.')));
    return box;
  }

  const ISSUE_WHERE_MAX = 3;

  function groupIssues(issues) {
    const byKind = new Map();
    for (const i of issues) {
      if (!byKind.has(i.kind)) byKind.set(i.kind, []);
      const where = i.host || i.file;
      if (where && !byKind.get(i.kind).includes(where)) byKind.get(i.kind).push(where);
    }
    const order = window.SdkDiagnostics ? SdkDiagnostics.ISSUE_KINDS : [];
    return [...byKind.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }

  function issuesBlock(issues) {
    const groups = groupIssues(issues);
    const box = el('details', 'inst-issues');
    box.appendChild(el('summary', 'inst-issues-title', groups.length === 1
      ? t('installed_issues_one', 'La sandbox blocca 1 cosa in questo widget')
      : t('installed_issues_n', 'La sandbox blocca {n} cose in questo widget').replace('{n}', String(groups.length))));
    const list = el('div', 'inst-issues-list');
    for (const [kind, where] of groups) {
      const row = el('div', 'inst-issues-row');
      row.appendChild(el('b', 'inst-issues-kind', t('sdk_issue_' + kind, kind)));
      if (where.length) {
        const shown = where.slice(0, ISSUE_WHERE_MAX).join(', ') + (where.length > ISSUE_WHERE_MAX ? ', …' : '');
        row.appendChild(el('code', 'inst-issues-where', shown));
      }
      row.appendChild(el('span', 'inst-issues-fix', t('sdk_issue_' + kind + '_fix', '')));
      list.appendChild(row);
    }
    box.appendChild(list);
    box.appendChild(el('p', 'inst-issues-foot', t('installed_issues_foot', '')));
    return box;
  }

  window.InstalledManagerRefused = { t, el, rejectedBlock, issuesBlock };
})();
