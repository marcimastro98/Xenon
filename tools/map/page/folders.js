// The folder tree: what each folder is for and which feature owns it, opened one level at a time.

function ownerLine(node) {
  const owners = ownersOf(node);
  if (owners.length === 0) return '';
  if (owners.length === 1) return say(owners[0].name);
  const names = owners.slice(0, 4).map((f) => say(f.name)).join(', ');
  return t('several', owners.length > 4 ? `${names}…` : names);
}

function folderList(node) {
  const box = h('div');
  for (const child of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const kids = h('div', { class: 'kids', hidden: true });
    const line = folderLine(child.path);
    const button = h('button', { class: 'dir', type: 'button', 'aria-expanded': 'false', 'data-dir': child.path },
      h('span', { class: 'tw', 'aria-hidden': 'true' }, '›'),
      h('span', { class: 'nm' }, `${child.name}/`, h('span', null, ownerLine(child)), line ? h('span', null, line) : null),
      h('span', { class: 'ct' }, t('files', num(child.count))));
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      if (open && !kids.firstChild) kids.append(folderList(child));
      kids.hidden = !open;
    });
    box.append(button, kids);
  }
  for (const file of node.files.slice().sort((a, b) => a.p.localeCompare(b.p))) {
    box.append(h('a', { class: 'leaf', href: `#f-${file.o}`, 'data-open': file.p },
      h('span', { 'aria-hidden': 'true' }),
      h('span', { class: 'nm' }, baseName(file.p), file.d ? h('span', null, file.d) : null)));
  }
  return box;
}

function foldersView() {
  return h('div', null,
    h('h1', null, t('foldersTitle')),
    h('p', null, t('foldersHint')),
    h('div', { class: 'tree' }, folderList(TREE)));
}
