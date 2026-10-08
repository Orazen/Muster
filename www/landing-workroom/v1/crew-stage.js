import { CREW, CREW_ROLES } from './mascot/crew.js';
import { GROUPS, LABELS, STATES } from './mascot/companion.js';

// One optional shared stage; portraits stay usable without WebGL or JavaScript.
export function mountCrew(root, { paused = false, onPause } = {}) {
  if (!root) return { setPaused() {}, dispose() {} };
  const lifetime = new AbortController();
  const $ = selector => root.querySelector(selector);
  const stage = $('#crew-mascot');
  const pauseButton = $('#crew-pause');
  const playButton = $('#crew-story');
  const stateSelect = $('#crew-expression');
  const expressionList = $('#crew-expressions');
  const caption = $('#crew-caption');
  const storyLine = $('#crew-story-line');
  const cleanups = [];
  let actor, disposed = false, inView = false, attempted = false, loading = false;
  let role = 'designer', state = 'idle', group = 'lifecycle';
  let frameId = 0, lastFrame = 0, age = 0, index = -1;
  const story = [
    ['coordinator', 'receiving', 'A little brief. A clear place to start.', 2.6],
    ['researcher', 'searching', 'The researcher follows a question and gathers sources.', 3.2],
    ['designer', 'thinking', 'The designer finds a direction worth exploring.', 2.8],
    ['designer', 'writing', 'A first idea takes shape.', 2.5],
    ['developer', 'working', 'The developer turns the idea into a working draft.', 3.2],
    ['coordinator', 'notifying', 'A draft comes back to you. The decision is yours.', 3.1],
    ['coordinator', 'celebrate', 'A useful result. And a little celebration.', 2.8],
  ];
  const listen = (element, event, callback) => element?.addEventListener(event, callback, { signal: lifetime.signal });
  // The caller supplies the preference initially; explicit Play is consistent
  // with the hero and can opt into motion until the system preference changes.
  const safePause = value => paused = Boolean(value);
  function updatePause() {
    actor?.setPaused(paused);
    root.dataset.crewPaused = String(paused);
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.textContent = paused ? 'Play motion' : 'Pause motion';
    if (paused && frameId) { cancelAnimationFrame(frameId); frameId = 0; }
    lastFrame = 0;
    requestTick();
  }
  function syncRole() {
    const item = CREW[role];
    root.dataset.crewRole = role;
    root.querySelectorAll('[data-crew-role]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.crewRole === role)));
    $('#crew-name').textContent = item.name;
    $('#crew-description').textContent = item.description;
    const portrait = stage.querySelector('img');
    portrait.src = `/landing-workroom/v1/mascot/posters/${role}.png`;
    portrait.alt = `${item.name}, Muster's ${role} teammate`;
    actor?.setRole(role);
  }
  function setState(next) {
    if (!Object.hasOwn(STATES, next)) return;
    state = next; root.dataset.crewState = state;
    actor?.setState(state);
    stateSelect.value = state;
    caption.textContent = STATES[state][0];
    $('#crew-state-name').textContent = LABELS[state];
    expressionList.querySelectorAll('[data-crew-state]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.crewState === state)));
  }
  function stopStory() {
    index = -1; age = 0; lastFrame = 0;
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
    playButton.setAttribute('aria-pressed', 'false');
    playButton.textContent = 'See a little teamwork';
    storyLine.textContent = 'A scripted example. Explore at your own pace.';
    root.dataset.crewStory = 'idle';
  }
  function renderGroup() {
    expressionList.replaceChildren(...GROUPS[group].map(key => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'crew-expression';
      button.dataset.crewState = key;
      button.textContent = LABELS[key];
      button.setAttribute('aria-pressed', String(state === key));
      return button;
    }));
    root.querySelectorAll('[data-crew-group]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.crewGroup === group)));
  }
  function requestTick() {
    if (!disposed && index >= 0 && !paused && inView && !document.hidden && !frameId) frameId = requestAnimationFrame(tick);
  }
  function showStep() {
    const [nextRole, nextState, line] = story[index];
    role = nextRole; syncRole(); setState(nextState);
    storyLine.textContent = line;
    root.dataset.crewStory = String(index + 1);
  }
  function tick(now) {
    frameId = 0;
    if (disposed || paused || document.hidden || !inView || index < 0) { lastFrame = 0; return; }
    if (lastFrame) age += Math.min((now - lastFrame) / 1000, .1);
    lastFrame = now;
    if (age >= story[index][3]) {
      age = 0; index++;
      if (index === story.length) { stopStory(); setState('idle'); return; }
      showStep();
    }
    requestTick();
  }
  async function load() {
    if (disposed || loading || attempted || !inView || document.hidden) return;
    loading = true; attempted = true;
    try {
      const { mountMascot } = await import('./mascot-stage.js');
      if (disposed || !root.isConnected) return;
      if (!inView || document.hidden) { attempted = false; return; }
      const mounted = await mountMascot(stage, { role, initialState: state, interactive: true, signal: lifetime.signal,
        onStatus: ({ available }) => { if (!disposed) root.dataset.crewReady = String(available); } });
      if (disposed) { mounted.dispose(); return; }
      actor = mounted; actor.setRole(role); actor.setState(state); actor.setPaused(paused);
    } catch (error) {
      if (!disposed) { root.dataset.crewReady = 'false'; console.warn('Crew portraits remain available.', error); }
    } finally { loading = false; }
  }
  function visibility(visible) {
    inView = visible; lastFrame = 0;
    if (!inView && frameId) { cancelAnimationFrame(frameId); frameId = 0; }
    void load(); requestTick();
  }
  listen(root, 'click', event => {
    const roleButton = event.target.closest('button[data-crew-role]');
    if (roleButton && CREW_ROLES.includes(roleButton.dataset.crewRole)) {
      stopStory(); role = roleButton.dataset.crewRole; syncRole(); setState(CREW[role].workState); return;
    }
    const groupButton = event.target.closest('button[data-crew-group]');
    if (groupButton && Object.hasOwn(GROUPS, groupButton.dataset.crewGroup)) { group = groupButton.dataset.crewGroup; renderGroup(); return; }
    const stateButton = event.target.closest('button[data-crew-state]');
    if (stateButton) { stopStory(); setState(stateButton.dataset.crewState); }
  });
  listen(stateSelect, 'change', () => { stopStory(); setState(stateSelect.value); });
  listen(playButton, 'click', () => {
    if (index >= 0) { stopStory(); return; }
    if (paused) { safePause(false); onPause?.(paused); updatePause(); }
    index = 0; age = 0; showStep();
    playButton.setAttribute('aria-pressed', 'true'); playButton.textContent = 'Stop the example'; requestTick();
  });
  listen(pauseButton, 'click', () => { safePause(!paused); onPause?.(paused); updatePause(); });
  listen(document, 'visibilitychange', () => {
    lastFrame = 0;
    if (document.hidden && frameId) { cancelAnimationFrame(frameId); frameId = 0; }
    if (!document.hidden) { void load(); requestTick(); }
  });
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => visibility(entries.some(entry => entry.isIntersecting)), { rootMargin: '100px' });
    observer.observe(stage); cleanups.push(() => observer.disconnect());
  } else {
    const check = () => { const box = stage.getBoundingClientRect(); visibility(box.bottom > -100 && box.top < innerHeight + 100); };
    listen(window, 'scroll', check); listen(window, 'resize', check); check();
  }
  for (const [name, keys] of Object.entries(GROUPS)) {
    const options = document.createElement('optgroup');
    options.label = ({ lifecycle: 'Lifecycle', reactions: 'Emotions', morphs: 'Agent signals', product: 'Task motion' })[name];
    for (const key of keys) { const option = document.createElement('option'); option.value = key; option.textContent = LABELS[key]; options.append(option); }
    stateSelect.append(options);
  }
  root.querySelectorAll('button, select').forEach(control => control.disabled = false);
  safePause(paused); syncRole(); renderGroup(); setState(state); updatePause();
  return {
    setPaused(value) { if (!disposed) { safePause(value); updatePause(); } },
    dispose() {
      if (disposed) return;
      disposed = true; lifetime.abort(); cancelAnimationFrame(frameId);
      cleanups.forEach(cleanup => cleanup()); actor?.dispose();
    },
  };
}
