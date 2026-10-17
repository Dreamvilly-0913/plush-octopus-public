const HOWTO = {
  hand: '<span class="tag">Hand</span>Grab the head or any arm and pull — each arm stretches on its own. Scroll, or add a second finger, while holding to twist. Drag the table to look around.',
  finger: '<span class="tag">Finger</span>Hold a finger out over an arm and it reaches up for it; press to put the finger down and the arms wrap round and hold on. Move it, lift it — they come along.',
  comb: '<span class="tag">Comb</span>Stroke the fur to lay the pile the way you brush — against the grain it turns darker, with it, it shines. Smooth fur puts it all back.',
};

export function bindUI(app) {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const howto = $('#howto');

  const setTool = (tool) => {
    $$('.tool').forEach((b) => {
      const on = b.dataset.tool === tool;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    });
    howto.innerHTML = HOWTO[tool];
    app.setTool(tool);
  };
  $$('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  howto.innerHTML = HOWTO.hand;

  $$('.swatch').forEach((b) => b.addEventListener('click', () => {
    $$('.swatch').forEach((s) => {
      const on = s === b;
      s.classList.toggle('is-active', on);
      s.setAttribute('aria-checked', String(on));
    });
    app.setFur(b.dataset.fur);
  }));

  const stuffing = $('#stuffing'), pile = $('#pile'), damping = $('#damping');
  stuffing.addEventListener('input', () => {
    app.sim.params.stuffing = +stuffing.value;
    $('#v-stuffing').textContent = (+stuffing.value).toFixed(2);
  });
  pile.addEventListener('input', () => {
    app.view.setPile(+pile.value);
    $('#v-pile').textContent = `${pile.value} mm`;
  });
  damping.addEventListener('input', () => {
    app.sim.params.damping = +damping.value;
    $('#v-damping').textContent = (+damping.value).toFixed(2);
  });

  $$('[data-action]').forEach((b) => b.addEventListener('click', () => app.action(b.dataset.action)));

  $('#slowmo').addEventListener('change', (e) => { app.sim.timeScale = e.target.checked ? 0.25 : 1; });
  $('#mesh').addEventListener('change', (e) => app.view.setDebug(e.target.checked));
  const pause = $('#pause');
  pause.addEventListener('click', () => {
    app.sim.paused = !app.sim.paused;
    pause.textContent = app.sim.paused ? 'Play' : 'Pause';
    pause.classList.toggle('is-on', app.sim.paused);
  });

  const vol = $('#s-volume'), kin = $('#s-kinetic'), hold = $('#s-holding'), holdUnit = $('#s-holding-unit');
  let last = 0;
  return {
    setTool,
    tick(now) {
      if (now - last < 110) return;
      last = now;
      const v = Math.max(0, Math.min(999.9, app.sim.volume * 100));
      vol.textContent = v.toFixed(1);
      const k = app.sim.kinetic;
      kin.textContent = k < 100 ? k.toFixed(2) : k.toFixed(0);
      const n = app.sim.holdingCount();
      hold.textContent = String(n);
      holdUnit.textContent = n === 1 ? 'arm' : 'arms';
    },
  };
}
