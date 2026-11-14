// Which version of the Store a widget was last installed from, so an update is offered only
// when the Store has a newer one.

const { _widgetOrigins } = require('./widget-origins.js');

// The catalog-entry version this package was last installed from ('' when it
// never came from the catalog, or predates this record).
function widgetCatalogVersionOf(id) {
  const rec = _widgetOrigins[id];
  return (rec && rec.catalogVersion) || '';
}

module.exports = { widgetCatalogVersionOf };
