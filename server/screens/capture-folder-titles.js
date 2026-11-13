// The title of the folder dialog for each kind of capture: recordings, screenshots, benchmark
// files and bug reports.

// The folders the user chose for recordings, screenshots and benchmark files
// (capture-folder.js), checked like the transfer inbox: never inside Xenon's
// own folders, never a link. One dialog at a time, whichever it is for.
const CAPTURE_FOLDER_TITLES = { recording: 'capture_folder_title', screenshot: 'shot_folder_title', benchmark: 'bench_folder_title', bugreport: 'bug_folder_title', buglogs: 'bug_logs_title', backup: 'backup_folder_title', transfer: 'xfer_folder_title' };

module.exports = { CAPTURE_FOLDER_TITLES };
