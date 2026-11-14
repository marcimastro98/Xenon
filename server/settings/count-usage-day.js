// Counts a day of real use once, when a dashboard connects.

const { localDay } = require('./usage-day.js');
const { readHubSettingsForUpdate } = require('./read.js');
const { hub } = require('./current.js');
const { writeHubSettings } = require('./write.js');
const { withHubSettingsLock } = require('./write-lock.js');

// One day of real use, counted once. Called when a dashboard connects, which is
// the only signal that someone actually LOOKED at Xenon: the engine starts at
// logon on machines nobody opens, and counting launches would hand those the
// same credit as a person using it daily.
//
// Writes at most once per day, and only when something changed.
async function noteUsageDay() {
  try {
    const today = localDay();
    const cur = hub.settings || {};
    if (cur.lastUsageDay === today) return;               // already counted today
    await withHubSettingsLock(async () => {
      const prev = await readHubSettingsForUpdate();
      if (prev.lastUsageDay === today) return;            // another surface got there first
      const next = {
        ...prev,
        firstRunDay: prev.firstRunDay || today,
        lastUsageDay: today,
        usageDays: (Number(prev.usageDays) || 0) + 1,
      };
      hub.settings = await writeHubSettings(next);
    });
  } catch { /* a counter is never worth failing a page load over */ }
}

module.exports = { noteUsageDay };
