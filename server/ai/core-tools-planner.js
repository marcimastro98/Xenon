// The tools the assistant always has for notes, tasks and the calendar.

function plannerAiFunctions() {
  return [
        // ── Notes ──
        { name: 'read_notes', description: 'Read the current notes/scratchpad content', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'write_notes', description: 'Replace the whole text of the note open in the notes widget. To add a note, add to one or change another, use edit_note instead.', parameters: { type: 'OBJECT', properties: { content: { type: 'STRING', description: 'New notes content' } }, required: ['content'] } },
        { name: 'edit_note', description: 'Work on one note of the notes widget, which holds several (read_notes lists their titles: a title is the first line). action: "new" (default, a new note with text: "write a note: buy milk", "prendi nota"), "append" (text on a new line at the end: "add eggs to the shopping note"), "replace" (the whole text), "pin", "unpin", "open" (show it in the widget) or "delete" (confirm first unless the user was explicit). note: words from the title of the note to work on; leave it out for the note open in the widget. Errors: "not_found" (comes with the titles), "empty_text", "too_many_notes".', parameters: { type: 'OBJECT', properties: { action: { type: 'STRING', description: 'new, append, replace, pin, unpin, open or delete' }, note: { type: 'STRING', description: 'words from the note title; empty = the open note' }, text: { type: 'STRING', description: 'the text for new, append or replace' } } } },
        // ── Tasks ──
        { name: 'list_tasks', description: 'List all tasks in the task list', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'create_task', description: 'Create a new task in the task list', parameters: { type: 'OBJECT', properties: {
          text: { type: 'STRING', description: 'Task description' },
          priority: { type: 'STRING', description: 'Priority: high, medium, or low (default: medium)' },
        }, required: ['text'] } },
        { name: 'delete_task', description: 'Delete a specific task by its id. Use list_tasks first to get the id if not known.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Task id to delete' },
        }, required: ['id'] } },
        { name: 'clear_all_tasks', description: 'Delete ALL tasks at once. Use only when the user explicitly asks to clear or delete all tasks.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'edit_task', description: 'Change a task that already exists: its text, priority or how often it repeats. Name it by words from its text (or its id from list_tasks); only the fields given change. When the words fit several tasks the reply lists them to ask which.', parameters: { type: 'OBJECT', properties: {
          task: { type: 'STRING', description: 'Words from the task as the user says them, e.g. "dentist"' },
          id: { type: 'STRING', description: 'Task id from list_tasks, instead of words' },
          text: { type: 'STRING', description: 'New text' },
          priority: { type: 'STRING', description: 'high, medium or low' },
          repeat: { type: 'STRING', description: 'never, daily, weekly or custom (every N days)' },
          every_days: { type: 'NUMBER', description: 'With repeat custom: every how many days' },
        } } },
        { name: 'complete_task', description: 'Mark a task as completed or uncompleted. Use list_tasks first if you do not know the id.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Task id to mark' },
          completed: { type: 'BOOLEAN', description: 'true to mark done, false to unmark (default true)' },
        }, required: ['id'] } },
        // ── Calendar ──
        { name: 'list_calendar_events', description: 'List upcoming calendar events', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'create_calendar_event', description: 'Create a new calendar event', parameters: { type: 'OBJECT', properties: {
          title: { type: 'STRING', description: 'Event title' },
          starts_at: { type: 'STRING', description: 'Start datetime in ISO 8601, e.g. 2026-05-25T14:00:00' },
          notes: { type: 'STRING', description: 'Optional notes' },
          reminder_at: { type: 'STRING', description: 'Optional reminder datetime in ISO 8601' },
        }, required: ['title', 'starts_at'] } },
        { name: 'delete_calendar_event', description: 'Delete a calendar event by its id. Use list_calendar_events first if you do not know the id.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Event id to delete' },
        }, required: ['id'] } },
        { name: 'edit_calendar_event', description: 'Change a calendar event that already exists: move it, rename it, change its notes, end or reminder. Name it by words from its title (or its id from list_calendar_events); only the fields given change. When the words fit several events the reply lists them to ask which.', parameters: { type: 'OBJECT', properties: {
          event: { type: 'STRING', description: 'Words from the title as the user says them, e.g. "dentist"' },
          id: { type: 'STRING', description: 'Event id from list_calendar_events, instead of words' },
          title: { type: 'STRING', description: 'New title' },
          starts_at: { type: 'STRING', description: 'New start in ISO 8601, e.g. 2026-05-25T14:00:00' },
          ends_at: { type: 'STRING', description: 'New end in ISO 8601, or "none" for no end' },
          reminder_at: { type: 'STRING', description: 'New reminder in ISO 8601, or "none" to remove it' },
          notes: { type: 'STRING', description: 'New notes (empty text clears them)' },
        } } },
        { name: 'clear_all_calendar_events', description: 'Delete ALL calendar events at once. Use only when the user explicitly asks to clear or delete all events.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'play_in_tile', description: 'Play a Twitch channel or a YouTube video, or open a web page, in the tile that shows it (Twitch, YouTube, Browser), on whichever screen of this PC has that tile. Give the channel, link or address the user named in `target`; when they only describe it ("a Minecraft stream", "lofi music") give the words in `search` and the first match plays. The reply says what is playing, or that no open screen has that tile (then offer to add it with place_widget).', parameters: { type: 'OBJECT', properties: {
          tile: { type: 'STRING', enum: ['twitch', 'youtube', 'browser'], description: 'Which tile' },
          target: { type: 'STRING', description: 'Twitch channel name or link, YouTube video link or id, or the web address for the Browser tile' },
          search: { type: 'STRING', description: 'Words to look for on Twitch (a live channel) or YouTube (a video) when the user named no exact channel or video' },
        }, required: ['tile'] } },
  ];
}

module.exports = { plannerAiFunctions };
