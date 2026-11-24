'use strict';
// Airflow's route (structure-conventions.md §5, listed in feature-routes.js).
//
//   GET /airflow   how the fans are now: state, mode, the reason, every fan with its
//                  speed and who drives it, the check, the shadow score, the choices.
//                  Read by the Fans section while it is open (speeds move every second)
//                  and the Fans widget. Reads the fans once when the engine is not
//                  running; never writes. A paired phone may: it shows the same menu.
//
// Every change is an action (js/capabilities/catalog-airflow.js) through POST
// /actions/run, so the menu, Bit, a Deck key and a phone pass the same checks.
// Loading this file starts the engine, which ticks only when Airflow is on.

const airflow = require('./index.js');

async function status(_req, _res, { json }) {
  if (!airflow.available()) { json({ ok: false, error: 'unavailable' }); return; }
  try { json({ ok: true, ...(await airflow.actions.view()) }); }
  catch (e) {
    console.warn(`airflow: the fans could not be read (${e.message})`);
    json({ ok: false, error: 'read_failed' });
  }
}

airflow.start();

module.exports = {
  routes: { 'GET /airflow': status },
  stop: airflow.stop,
};
