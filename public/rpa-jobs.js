(() => {
  "use strict";
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  window.ObservatoryRpaJobs = { create({ api, openModal, closeModal, onResolved }) {
    const $ = (id) => document.getElementById(id);
    const s = { device: null, jobs: [], selected: null, version: 0, busy: false };
    document.body.insertAdjacentHTML("beforeend", `<div class="modal" id="rpaJobsModal" role="dialog" aria-modal="true" aria-labelledby="rpaJobsTitle" hidden><div class="modal-card">
      <div class="modal-heading"><h2 id="rpaJobsTitle">Legacy automation jobs</h2><button type="button" class="btn ghost" id="rpaJobsClose">Close</button></div>
      <p class="meta" id="rpaJobsDevice"></p><p class="meta">Review historical controller submissions. Resolve an uncertain job only after checking its remote DuoPlus task.</p>
      <div id="rpaJobsFeedback" class="form-message" role="status" aria-live="polite" hidden></div><div id="rpaJobsList"></div>
      <form id="rpaResolveForm" hidden><h3 id="rpaResolveTitle"></h3><label>Confirmed outcome<select name="outcome"><option value="cancelled">Cancelled</option><option value="completed">Completed</option></select></label>
        <label>Evidence from your provider check<textarea name="evidence" required minlength="10" maxlength="2000" rows="3" placeholder="Task ID, observed outcome and when you checked"></textarea></label>
        <label class="site-check-label"><input name="providerIdleConfirmed" type="checkbox" required />I checked DuoPlus and confirmed no remote run for this job remains active or scheduled.</label>
        <p class="meta">This records your resolution locally. It does not stop or replay a remote task.</p><div class="modal-actions"><button type="button" class="btn ghost" id="rpaResolveCancel">Back</button><button type="submit" class="btn">Record resolution</button></div>
      </form></div></div>`);

    function feedback(message = "", error = false) {
      $("rpaJobsFeedback").textContent = message;
      $("rpaJobsFeedback").hidden = !message;
      $("rpaJobsFeedback").classList.toggle("error", error);
    }
    function render() {
      $("rpaJobsClose").disabled = s.busy;
      $("rpaJobsList").innerHTML = s.jobs.map((job) => `<article class="site-job"><div class="site-job-heading"><strong>${escape(job.name || job.templateId)}</strong><span class="status-chip neutral">${escape(job.status)}</span></div><p class="meta">${escape(job.id)} · ${escape(new Date(job.updatedAt).toLocaleString())}</p>${job.error ? `<p class="site-warning">${escape(job.error)}</p>` : ""}${job.canResolve ? `<button class="btn ghost tiny" type="button" data-rpa-resolve="${escape(job.id)}"${s.busy ? " disabled" : ""}>Review resolution</button>` : ""}</article>`).join("") || '<p class="meta">No legacy automation jobs for this device.</p>';
      $("rpaResolveForm").querySelectorAll("input, select, textarea, button").forEach((control) => { control.disabled = s.busy; });
      $("rpaResolveForm").elements.outcome.querySelector('[value="completed"]').disabled = !s.selected?.canConfirmCompleted;
    }
    async function reload(version) {
      const result = await api(`/devices/${encodeURIComponent(s.device.id)}/rpa`);
      if (version !== s.version) return;
      s.jobs = Array.isArray(result.jobs) ? result.jobs : [];
      render();
    }
    async function open(device) {
      if (!device || s.busy) return;
      const version = ++s.version;
      s.device = device; s.jobs = []; s.selected = null;
      $("rpaJobsDevice").textContent = device.name || device.imageId;
      $("rpaResolveForm").reset(); $("rpaResolveForm").hidden = true;
      openModal("rpaJobsModal"); feedback("Loading jobs…");
      s.busy = true; render();
      try { await reload(version); if (version === s.version) feedback(); }
      catch (error) { if (version === s.version) feedback(error.message, true); }
      finally { if (version === s.version) { s.busy = false; render(); } }
    }
    function close() { if (s.busy) return; closeModal("rpaJobsModal"); $("manageRpaJobs")?.focus(); }
    $("rpaJobsClose").addEventListener("click", close);
    $("rpaResolveCancel").addEventListener("click", () => { if (!s.busy) { s.selected = null; $("rpaResolveForm").hidden = true; render(); } });
    $("rpaJobsList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-rpa-resolve]");
      if (!button || s.busy) return;
      const job = s.jobs.find((item) => item.id === button.dataset.rpaResolve && item.canResolve);
      if (!job) return;
      s.selected = job; $("rpaResolveForm").reset(); $("rpaResolveForm").hidden = false;
      $("rpaResolveTitle").textContent = `Resolve ${job.name || job.templateId}`;
      feedback(); render(); $("rpaResolveForm").elements.evidence.focus();
    });
    $("rpaResolveForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (s.busy || !s.selected || !form.reportValidity()) return;
      const version = s.version, job = s.selected, data = new FormData(form);
      s.busy = true; feedback("Recording resolution…"); render();
      try {
        await api(`/devices/${encodeURIComponent(s.device.id)}/rpa/${encodeURIComponent(job.id)}/resolve`, { method: "POST", body: JSON.stringify({
          outcome: data.get("outcome"), evidence: data.get("evidence").trim(), providerIdleConfirmed: data.get("providerIdleConfirmed") === "on", expectedUpdatedAt: job.updatedAt,
        }) });
        if (version !== s.version) return;
        s.selected = null; form.reset(); form.hidden = true;
        feedback("Resolution recorded. Refreshing jobs…"); onResolved();
        try { await reload(version); if (version === s.version) feedback("Resolution recorded. No remote task was sent."); }
        catch { if (version === s.version) feedback("Resolution recorded, but the refreshed list could not be loaded. Close and reopen this panel.", true); }
      } catch (error) { if (version === s.version) feedback(error.message, true); }
      finally { if (version === s.version) { s.busy = false; render(); } }
    });
    return { open, close, clear() { s.version++; s.device = null; s.jobs = []; s.selected = null; s.busy = false; $("rpaResolveForm").reset(); $("rpaResolveForm").hidden = true; feedback(); render(); closeModal("rpaJobsModal"); } };
  } };
})();
