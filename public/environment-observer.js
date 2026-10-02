(function(root){
  'use strict';
  const escape=value=>String(value??'Unknown').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const age=ms=>Number.isFinite(ms)?`${Math.round(ms)} ms`:'Not measured';
  function markup(state){
    const s=state?.observation,lab=state?.lab;
    return `<section aria-label="Independent environment observer">
      <div class="section-heading"><h3>Android environment observer</h3><button type="button" class="btn ghost" data-environment-action="readback">Read Android APIs</button></div>
      <p class="meta">Read-only observer APK required. A scan cache is not a fresh scan; mock flags are preserved.</p>
      <div id="environmentObserverFeedback" class="form-message" role="status" aria-live="polite"></div>
      ${state?.error?`<p class="meta">${escape(state.error)}. Any values below are the previous observation, not a new success.</p>`:''}
      ${s?`<dl class="environment-fields">
        <dt>Observer identity</dt><dd>${escape(s.imageId)}<span class="meta">Boot ${escape(s.bootId)}</span></dd>
        <dt>Location</dt><dd>${escape(s.location.availability)}<span class="meta">${s.location.point?`${escape(s.location.point.lat)}, ${escape(s.location.point.lng)}`:escape(s.location.reason)}</span></dd>
        <dt>Location age</dt><dd>${age(s.location.ageMs)} — ${s.location.fresh?'fresh':'stale or unavailable'}</dd>
        <dt>Mock flag</dt><dd>${s.location.isMock===null?'Unknown':String(s.location.isMock)}</dd>
        <dt>Wi-Fi scan</dt><dd>${escape(s.wifi.availability)}; entries ${escape(s.wifi.count)}<span class="meta">Newest ${age(s.wifi.newestAgeMs)} / oldest ${age(s.wifi.oldestAgeMs)}</span><span class="meta">${escape(s.wifi.reason||s.wifi.collectionMethod)}</span></dd>
        <dt>Associated BSSID</dt><dd>${escape(s.wifi.connection?.bssid)}<span class="meta">${escape(s.wifi.connection?.reason||s.wifi.connection?.availability)}</span></dd>
        <dt>Cellular</dt><dd>${escape(s.cells.availability)}; entries ${escape(s.cells.count)}<span class="meta">${escape(s.cells.reason||'Default subscription only')}</span></dd>
        <dt>Bluetooth</dt><dd>${escape(s.bluetooth.availability)}<span class="meta">${escape(s.bluetooth.reason||'Read-only scan cache')}</span></dd>
      </dl>`:'<p class="meta">No independent observation captured on this controller process.</p>'}
      <div class="section-heading"><h3>Application test playback</h3></div>
      <p class="meta">Sends the current trip model to the separate lab APK. Does not change Android radios or verify physical travel.</p>
      <div class="environment-actions"><button type="button" class="btn ghost" data-environment-action="lab-start">Start test playback</button><button type="button" class="btn ghost" data-environment-action="lab-stop">Stop test playback</button></div>
      <p class="meta">${escape(lab?.status||'Not started')}${lab?.error?`: ${escape(lab.error)}`:''} — Android radio application: not implemented.</p>
    </section>`;
  }
  const api={markup};if(typeof module==='object'&&module.exports)module.exports=api;else root.ObservatoryEnvironmentObserver=api;
})(typeof window==='object'?window:globalThis);
