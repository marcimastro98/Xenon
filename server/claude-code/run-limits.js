'use strict';
// How much a run started from the dashboard may take: prompt, output, projects, folders, time
// and the efforts a run can ask for.

const MAX_PROMPT = 4000;          // one touchscreen dictation, generously
const MAX_RUNS = 2;               // concurrent; the quota is shared and finite
const MAX_OUTPUT_CHARS = 24000;   // per run, oldest text dropped first
const MAX_PROJECTS = 40;
const MAX_FOLDERS = 20;           // folders the user added by hand
const MAX_FOLDER_PATH = 500;
const RUN_TTL_MS = 30 * 60 * 1000;
const PROJECT_TTL_MS = 60 * 1000; // project list cache

const START_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_ACTIVITY = 6;           // tool calls kept per run

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

module.exports = {
  MAX_PROMPT, MAX_RUNS, MAX_OUTPUT_CHARS, MAX_PROJECTS, MAX_FOLDERS, MAX_FOLDER_PATH, RUN_TTL_MS,
  PROJECT_TTL_MS, START_TIMEOUT_MS, MAX_ACTIVITY, EFFORTS,
};
