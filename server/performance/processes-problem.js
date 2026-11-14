// Tells the dashboards once why the list of programs cannot be read.

const { sseClients, broadcastSSE } = require('../http/sse-clients.js');
const { processesProblem } = require('./processes-problem-state.js');

// Said ONCE on the same channel, so a widget that can never get data renders its
// own explanation instead of an empty list that looks like an idle machine.
function announceProcessesProblem(problem) {
  if (problem === processesProblem.said) return;
  processesProblem.said = problem;
  if (problem && sseClients.size > 0) broadcastSSE('processes', { problem, apps: [] });
}

module.exports = { announceProcessesProblem };
