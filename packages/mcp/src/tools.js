'use strict';
// The tools a coding assistant sees, and what each one does. The list is
// fixed here (an assistant reads it before Xenon may even be running); each
// call becomes one op on Xenon (server/mcp-dev-tools.js), with the widget
// folder read or written on this side, so Xenon never takes a path.
const { readWidgetFolder, writeWidgetFolder, widgetId } = require('./folder.js');

const SIZES = ['small', 'medium', 'wide', 'tall', 'large'];
const folderProp = { type: 'string', description: 'Absolute path of the widget folder (the one holding manifest.json). Its name is the widget id unless `id` is given.' };
const idProp = { type: 'string', description: 'Widget id: 2 to 41 characters, a-z, 0-9 and dashes.' };

const TOOLS = [
  {
    name: 'xenon_status',
    description: 'Check that Xenon is running on this computer and ready for widgets: its version, the Widget SDK version, whether community widgets are on and whether a dashboard is open. Call it first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sdk_reference',
    description: 'Read the Xenon Widget SDK reference: the manifest, the message protocol, data streams, actions, storage, sizing and the sandbox rules. With no section you get the table of contents. Read it before writing a widget.',
    inputSchema: { type: 'object', properties: { section: { type: 'string', description: 'A section name from the table of contents.' } } },
  },
  {
    name: 'new_widget',
    description: 'Write a working starter widget (manifest, HTML, CSS, JS showing live CPU and memory) into a new or empty folder. Edit it from there, then install_widget.',
    inputSchema: {
      type: 'object',
      required: ['folder'],
      properties: {
        folder: folderProp,
        id: idProp,
        name: { type: 'string', description: 'The name people see. Defaults to the id.' },
        size: { type: 'string', enum: SIZES, description: 'Tile size. Defaults to medium.' },
        overwrite: { type: 'boolean', description: 'Replace files with the same names in a folder that is not empty.' },
      },
    },
  },
  {
    name: 'check_widget',
    description: 'Run the checks Xenon runs before installing, without installing: the package rules, what the sandbox will refuse (inline scripts, remote code, hosts) and the Store\'s review notes.',
    inputSchema: { type: 'object', required: ['folder'], properties: { folder: folderProp, id: idProp } },
  },
  {
    name: 'install_widget',
    description: 'Install or update the widget from its folder put it on the dashboard and show its page (a new page when the one in view is full). Permissions it asks for still wait for the person to approve them on the dashboard. Then call widget_issues and widget_screenshot.',
    inputSchema: { type: 'object', required: ['folder'], properties: { folder: folderProp, id: idProp } },
  },
  {
    name: 'widget_issues',
    description: 'What went wrong in an installed widget while it ran: errors and console.error lines, requests the sandbox blocked, whether its permissions are approved, and how heavy it is. Errors thrown in widget code show as "Script error." because of the sandbox: wrap code in try/catch and console.error the message to see it.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: idProp } },
  },
  {
    name: 'widget_screenshot',
    description: 'A picture of the widget\'s tile as it is on screen now. Anything on top of the dashboard shows too. Not available on Linux under Wayland.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: idProp } },
  },
  {
    name: 'my_widgets',
    description: 'List the widgets the person made (not Store downloads). With an id and a folder, write that widget\'s files into the folder to keep working on it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: idProp,
        folder: { type: 'string', description: 'With id: a new or empty folder to write the widget into.' },
        overwrite: { type: 'boolean', description: 'Replace files with the same names in a folder that is not empty.' },
      },
    },
  },
  {
    name: 'share_widget',
    description: 'A share code for one of the person\'s own widgets, which anyone can paste into Xenon, plus the Store review notes. To put it in the Store the person sends it from xenon-app.com/submit.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: idProp } },
  },
];

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const failed = (obj) => ({ ...text(obj), isError: true });
// Xenon's answer, as the assistant reads it: errors marked as errors.
const answer = (r) => (r && r.ok === false ? failed(r) : text(r));

async function payloadFrom(args) {
  const id = widgetId(args.folder, args.id);
  if (!id) return { error: failed({ ok: false, error: 'bad_id', hint: 'Name the folder like a widget id (a-z, 0-9, dashes), or pass `id`.' }) };
  const read = await readWidgetFolder(args.folder);
  if (!read.ok) return { error: failed(read) };
  return { id, files: read.files, skipped: read.skipped };
}

// Folder-based ops: read the folder, send the files, say what was left out.
async function withFolder(op, args, client) {
  const p = await payloadFrom(args);
  if (p.error) return p.error;
  const r = await client.call(op, { id: p.id, files: p.files });
  if (r && r.ok !== false && p.skipped.length) r.skippedFiles = p.skipped;
  return answer(r);
}

async function newWidget(args, client) {
  const id = widgetId(args.folder, args.id);
  if (!id) return failed({ ok: false, error: 'bad_id', hint: 'Name the folder like a widget id (a-z, 0-9, dashes), or pass `id`.' });
  const r = await client.call('widget_template', { id, name: args.name, size: args.size });
  if (!r || !r.ok) return answer(r);
  const w = await writeWidgetFolder(args.folder, r.files, { overwrite: args.overwrite === true });
  return w.ok ? text({ ok: true, id, folder: w.folder, files: w.written, next: 'Edit the files, then call install_widget with this folder.' }) : failed(w);
}

async function myWidgets(args, client) {
  const r = await client.call('my_widgets', { id: args.id });
  if (!r || !r.ok || !args.id || !args.folder) {
    // Without a folder the files stay out of the answer: they are base64.
    if (r && Array.isArray(r.files)) r.files = r.files.map((f) => f.path);
    return answer(r);
  }
  const w = await writeWidgetFolder(args.folder, r.files, { overwrite: args.overwrite === true });
  return w.ok ? text({ ok: true, id: args.id, folder: w.folder, files: w.written }) : failed(w);
}

async function screenshot(args, client) {
  const r = await client.call('widget_shot', { id: args.id });
  if (!r || !r.ok || !r.image) return answer(r);
  return { content: [{ type: 'image', data: r.image.data, mimeType: r.image.mimeType }, { type: 'text', text: `${args.id}, ${r.size.width}x${r.size.height}` }] };
}

const HANDLERS = {
  xenon_status: (_a, c) => c.call('status', {}).then(answer),
  sdk_reference: (a, c) => c.call('sdk_reference', { section: a.section }).then(answer),
  new_widget: newWidget,
  check_widget: (a, c) => withFolder('check_widget', a, c),
  install_widget: (a, c) => withFolder('install_widget', a, c),
  widget_issues: (a, c) => c.call('widget_issues', { id: a.id }).then(answer),
  widget_screenshot: screenshot,
  my_widgets: myWidgets,
  share_widget: (a, c) => c.call('share_widget', { id: a.id }).then(answer),
};

async function callTool(name, args, client) {
  const fn = Object.prototype.hasOwnProperty.call(HANDLERS, name) ? HANDLERS[name] : null;
  if (!fn) return failed('Unknown tool: ' + name);
  try {
    return await fn(args && typeof args === 'object' ? args : {}, client);
  } catch (e) {
    return failed({ ok: false, error: (e && e.code) || 'failed', hint: (e && (e.hint || e.message)) || String(e) });
  }
}

module.exports = { TOOLS, callTool };
