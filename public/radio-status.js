(function (root) {
  "use strict";

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const sequence = (value) => Number.isInteger(value) ? String(value) : "None";
  const when = (value) => Number.isFinite(value) ? new Date(value).toLocaleString() : "Not recorded";
  const chip = (tone, label) => `<span class="status-chip ${["good", "warn", "bad", "neutral"].includes(tone) ? tone : "neutral"}">${escape(label)}</span>`;

  function markup(status) {
    if (!status) {
      return `<div class="section-heading"><h3>Live radio</h3></div><p class="meta">No radio status for this phone.</p>`;
    }
    const phone = status.phone || {};
    const requested = status.requested || {};
    const applied = status.applied || {};
    const observed = status.observed || {};
    const carrier = status.carrier || {};
    const bluetooth = status.bluetooth || {};
    const readiness = status.readiness || {};
    const operator = status.operator || {};
    const display = status.display || {};
    const scan = Array.isArray(status.scanAge) ? status.scanAge : [];
    const handover = carrier.handover && (carrier.handover.from || carrier.handover.to)
      ? `${carrier.handover.from || "none"} → ${carrier.handover.to || "none"} (model serving-cell change)`
      : "No model serving-cell change";
    const scanRows = scan.length
      ? scan.map((age) => `<dt>${escape(age.interface)} scan age</dt><dd>${escape(age.label)}</dd>`).join("")
      : `<dt>Scan age</dt><dd>No model cache age yet. Cached model samples are not Android scan results.</dd>`;
    return `<div class="section-heading"><h3>Live radio</h3>${chip(operator.tone, operator.label)}</div>
      <p class="meta">${escape(operator.detail || "")}</p>
      <dl class="environment-fields">
        <dt>Phone / session</dt><dd>${escape(phone.imageId || "Unknown")}${phone.sessionId ? `<span class="meta">session ${escape(phone.sessionId)}</span>` : "<span class=\"meta\">No live session</span>"}${phone.bootId ? `<span class="meta">boot ${escape(phone.bootId)}</span>` : ""}</dd>
        <dt>Last requested sequence</dt><dd>${escape(sequence(requested.sequence))}<span class="meta">${escape(requested.source || "MODEL_FRAME")}${requested.simElapsedMs != null ? ` · sim ${requested.simElapsedMs} ms` : ""}</span><span class="meta">${escape(requested.detail || "")}</span></dd>
        <dt>Last applied sequence</dt><dd>${escape(applied.applied ? sequence(applied.sequence) : "Not applied")}<span class="meta">${escape(applied.source || "NOT_APPLIED")}${applied.lifecycle ? ` · ${escape(applied.lifecycle)}` : ""}</span><span class="meta">${escape(applied.detail || "")}</span></dd>
        <dt>Last observed sequence</dt><dd>${escape(observed.availability || "NOT_OBSERVED")}<span class="meta">${escape(sequence(observed.sequence))}</span><span class="meta">${escape(observed.claim || observed.detail || "")}</span></dd>
        <dt>Requested carrier</dt><dd>${escape(carrier.requestedMcc || "?")} / ${escape(carrier.requestedMnc || "?")}</dd>
        <dt>Serving cell (requested)</dt><dd>${escape(carrier.servingCellRequested || "None")}</dd>
        <dt>Serving cell (observed)</dt><dd>${escape(carrier.servingCellObserved || "NOT_OBSERVED")}</dd>
        <dt>Serving-cell change</dt><dd>${escape(handover)}</dd>
        ${scanRows}
        <dt>Bluetooth action</dt><dd>${escape(bluetooth.intent || "HOLD")}<span class="meta">observed ${escape(bluetooth.observed || "NOT_OBSERVED")}</span><span class="meta">${escape(bluetooth.detail || "")}</span></dd>
        <dt>Failure / uncertainty</dt><dd>${status.failure?.uncertain ? "Uncertain" : status.failure?.blocked ? "Blocked" : "None"}<span class="meta">${escape(status.failure?.detail || operator.detail || "")}</span></dd>
      </dl>
      <div class="section-heading"><h3>Radio readiness</h3>${chip(readiness.tone, readiness.code || readiness.label || "UNKNOWN")}</div>
      <p class="meta">${escape(readiness.detail || "")}${readiness.checkedAt ? ` Checked ${escape(new Date(readiness.checkedAt).toLocaleString())}.` : ""}</p>
      <p class="meta">${escape(display.note || "Visible snapshots poll every 2.5 s. Marker motion is presentation, not new phone evidence.")}${display.interpolation ? ` Interpolation: ${escape(display.interpolation)}.` : ""}</p>`;
  }

  const api = { markup, chip };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ObservatoryRadioStatus = api;
})(typeof window === "object" ? window : globalThis);
