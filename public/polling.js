(function (root) {
  "use strict";

  // Share overlapping reads, but refresh again when a mutation/session change
  // invalidates the request that is still in flight.
  function singleFlight(run, version = () => 0) {
    let pending = null;
    return function request() {
      const requestedVersion = version();
      if (pending) {
        const previous = pending;
        return previous.promise.then(
          (value) => previous.version === requestedVersion ? value : request(),
          (error) => { if (previous.version !== requestedVersion) return request(); throw error; },
        );
      }
      const current = { version: requestedVersion, promise: null };
      current.promise = Promise.resolve().then(run).finally(() => {
        if (pending === current) pending = null;
      });
      pending = current;
      return current.promise;
    };
  }

  function snapshotNeeded({ hidden, authenticated, hasSnapshot, section, diagnosticsOpen }) {
    return !hidden && authenticated !== false && (!hasSnapshot || section === "devices" || diagnosticsOpen);
  }

  const api = { singleFlight, snapshotNeeded };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ObservatoryPolling = api;
})(typeof window === "object" ? window : globalThis);
