// Gets JSON back from PowerShell: out of the text a script printed, or from a file a script
// wrote.

const fs = require('node:fs');

// Read + parse a JSON marker file written by a PowerShell script, stripping the
// UTF-8 BOM Windows PowerShell's `-Encoding UTF8` prepends (JSON.parse rejects
// a BOM'd payload — the documented "permanently idle" trap). Returns null when
// the file is absent or unparsable. Use this for every PS-written JSON file.
async function readPwshJson(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch { return null; }
}

function parseJsonOutput(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON output');
  return JSON.parse(stdout.slice(start, end + 1));
}

module.exports = { readPwshJson, parseJsonOutput };
