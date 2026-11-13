// A calendar day in the user's own time zone, as the count of days Xenon was used stores it.

// A calendar day as this file stores it. Local time on purpose: "days I used
// Xenon" is a human unit, and a UTC boundary would count an evening session as
// tomorrow for a whole hemisphere.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function localDay(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

module.exports = { DAY_RE, localDay };
