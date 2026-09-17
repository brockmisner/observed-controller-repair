(() => {
  const names = new Set("refresh-cw settings-2 map-pin locate-fixed pause play save x route copy chevron-down chevron-right check check-check triangle-alert circle-help search plus log-out key-round radio wifi bluetooth map list smartphone history sliders-horizontal arrow-left arrow-up-right loader-circle crosshair activity layers eye".split(" "));
  window.obsIcon = (name) => names.has(name)
    ? `<span class="icon" style="--icon:url('/icons/${name}.svg')" aria-hidden="true"></span>`
    : "";
})();
