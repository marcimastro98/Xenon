/*
 * iCUE plugin wrappers — official SDK boilerplate, kept faithful to the docs.
 * Source: icue/reference/references/common-tools.md.
 *
 * iCUE injects Qt WebChannel plugin objects into window.plugins.* before widget
 * scripts run. These wrappers turn the callback-based Qt API into Promises.
 * Only Sensors, Media and Link are officially supported. (FPS is a Sensors type.)
 *
 * Each plugin used must also be declared in the widget's manifest.json
 * `required_plugins`. This file is inlined into the widget at build time.
 */

/* Base class — always present whenever any plugin wrapper is used. */
class IcueWidgetApiWrapper {
  constructor(plugin, timeoutMs) {
    this.plugin = plugin;
    this.timeoutMs = timeoutMs || 5000;
    this.pendingRequests = new Map();
    this.nextRequestId = 0;
    if (this.plugin && this.plugin.asyncResponse) {
      this.plugin.asyncResponse.connect(this._handleAsyncResponse.bind(this));
    }
  }
  _nextRequestId() { return this.nextRequestId++; }
  _handleAsyncResponse(requestId, value) {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pending.resolve(value);
      this.pendingRequests.delete(requestId);
    }
  }
  request(method) {
    const args = Array.prototype.slice.call(arguments, 1);
    const self = this;
    return new Promise(function (resolve, reject) {
      const requestId = self._nextRequestId();
      method.apply(self.plugin, [requestId].concat(args));
      const timeoutId = setTimeout(function () {
        if (self.pendingRequests.has(requestId)) {
          self.pendingRequests.delete(requestId);
          reject(new Error("Request timeout"));
        }
      }, self.timeoutMs);
      self.pendingRequests.set(requestId, { resolve: resolve, reject: reject, timeoutId: timeoutId });
    });
  }
}

/* Hardware sensors: CPU/GPU temp, load, fan speed, RAM, FPS (type "fps"), etc.
 * manifest: "widgetbuilder.sensorsdataprovider:Sensors:1.0" */
class SimpleSensorApiWrapper extends IcueWidgetApiWrapper {
  getSensorValue(sensorId)      { return this.request(this.plugin.getSensorValue, sensorId); }
  getSensorUnits(sensorId)      { return this.request(this.plugin.getSensorUnits, sensorId); }
  getSensorName(sensorId)       { return this.request(this.plugin.getSensorName, sensorId); }
  getSensorDeviceName(sensorId) { return this.request(this.plugin.getSensorDeviceName, sensorId); }
  getSensorType(sensorId)       { return this.request(this.plugin.getSensorType, sensorId); }
  getSensorKind(sensorId)       { return this.request(this.plugin.getSensorKind, sensorId); }
  getAllSensorIds()             { return this.request(this.plugin.getAllSensorIds); }
  sensorIsConnected(sensorId)   { return this.request(this.plugin.sensorIsConnected, sensorId); }
}

/* Now-playing track info (read-only fields; controls are separate Qt signals).
 * manifest: "widgetbuilder.mediadataprovider:Media:1.0" */
class SimpleMediaApiWrapper extends IcueWidgetApiWrapper {
  getSongName() { return this.request(this.plugin.getSongName); }
  getArtist()   { return this.request(this.plugin.getArtist); }
}

/* Open a URL in the system browser (else it navigates inside the widget view).
 * manifest: "widgetbuilder.linkprovider:Url:1.0". Synchronous — no wrapper class. */
function openLink(url) {
  const ready = typeof pluginLinkprovider_initialized !== "undefined" && pluginLinkprovider_initialized;
  if (window.plugins && window.plugins.Linkprovider && ready) {
    window.plugins.Linkprovider.open(url);
  } else {
    window.open(url, "_blank"); // browser-testing fallback outside iCUE
  }
}
