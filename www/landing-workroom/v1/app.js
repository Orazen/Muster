import { createHandoff, SCENARIOS } from './handoff.mjs';
const $ = selector => document.querySelector(selector);
const model = createHandoff();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let motionPaused = reducedMotion.matches;
let heroActor, deskActor, helloTimer;
let disposed = false;
const lifetime = new AbortController();
const roleNames = { update: 'Slate', plan: 'Atlas', research: 'Quill' };
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const lines = (items, cls = '') => `<ul class="${cls}">${items.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul>`;
const action = (name, label, secondary = false) => `<button class="button demo-button ${secondary ? 'secondary' : 'dark'}" data-action="${name}">${label}<span aria-hidden="true">${secondary ? '↳' : '↗'}</span></button>`;

function render({focus = false} = {}) {
  const snapshot = model.getSnapshot();
  const {scenario, scenarioKey, phase, outcome} = snapshot;
  $('#handoff-panel').dataset.phase = phase;
  $('#handoff-panel').dataset.outcome = outcome || '';
  $('#handoff-panel').setAttribute('aria-labelledby', `tab-${scenarioKey}`);
  document.querySelectorAll('[data-scenario]').forEach(button => {
    const selected = button.dataset.scenario === scenarioKey;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
  });
  $('#demo-role').textContent = roleNames[scenarioKey];
  $('.avatar').textContent = roleNames[scenarioKey][0];
  $('#demo-status').textContent = {ready:'Ready for your brief',preparing:'Making a little headway',review:'Your call from here',complete:outcome === 'approved'?'Example approved':'Draft kept here'}[phase];
  $('#demo-status').setAttribute('role','status');
  $('#demo-kicker').textContent = `A SMALL TASK / 0${Object.keys(SCENARIOS).indexOf(scenarioKey) + 1}`;
  $('#desk-aside').textContent = {ready:'A starting point is all it takes.',preparing:'Connecting the dots.',review:'Take a look. What do you think?',complete:outcome==='approved'?'A little further than before.':'We can come back to this.'}[phase];
  const order = ['ready','preparing','review','complete'];
  document.querySelectorAll('[data-step]').forEach(item => {
    item.classList.toggle('complete', order.indexOf(item.dataset.step) < order.indexOf(phase));
    if (item.dataset.step === phase) item.setAttribute('aria-current','step'); else item.removeAttribute('aria-current');
  });
  deskActor?.setState(snapshot.cue);
  let content = '';
  if (phase === 'ready') content = `<h3 tabindex="-1">${escapeHTML(scenario.title)}</h3><p>${escapeHTML(scenario.brief)}</p><div class="brief-box"><span>THE NOTES YOU BRING</span>${lines(scenario.inputs)}</div>${action('start', 'Give it to ' + roleNames[scenarioKey])}`;
  if (phase === 'preparing') content = `<h3 tabindex="-1">A little groundwork.</h3><p>${roleNames[scenarioKey]} has a clear plan for this example. Follow the steps, then take a look at the draft.</p><ol class="work-log">${scenario.steps.map((step,i)=>`<li><span>0${i+1}</span>${escapeHTML(step)}</li>`).join('')}</ol>${action('advance','Take a look at the draft')}`;
  const draft = `<div class="review-draft"><span class="result-label">${phase === 'complete' ? 'YOUR EXAMPLE RESULT' : 'THE FIRST DRAFT'}</span><h4>${escapeHTML(scenario.draftTitle)}</h4>${lines(scenario.draft,'draft-lines')}</div>`;
  if (phase === 'review') content = `<h3 tabindex="-1">Ready for your eyes.</h3>${draft}<div class="approval-line"><span class="approval-icon">?</span><div><strong>${escapeHTML(scenario.approvalTitle)}</strong><p>${escapeHTML(scenario.approvalDetail)}</p></div></div><div class="demo-actions">${action('approve',escapeHTML(scenario.approveLabel))}${action('draft','Keep as a draft',true)}</div>`;
  if (phase === 'complete') content = `<div class="receipt-mark" aria-hidden="true">${outcome==='approved'?'✓':'↳'}</div><h3 tabindex="-1">${outcome==='approved'?'A useful little handoff.':'Good things can wait.'}</h3>${draft}<div class="receipt-box"><span class="result-label">THE RECEIPT</span>${escapeHTML(snapshot.receipt)}</div>${action('reset','Try it again',true)}`;
  $('#demo-content').innerHTML = content;
  if (focus) $('#demo-content h3').focus({preventScroll:true});
}
$('#demo-content').addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const type = button.dataset.action;
  if (type === 'approve' || type === 'draft') model.decide(type); else model[type]();
  render({focus:true});
});
$('#reset-demo').addEventListener('click', () => { model.reset(); render({focus:true}); });
function selectScenario(key) { model.selectScenario(key); render(); }
document.querySelectorAll('[data-scenario]').forEach(button => {
  button.addEventListener('click', () => selectScenario(button.dataset.scenario));
  button.addEventListener('keydown', event => {
    const keys = Object.keys(SCENARIOS); let index = keys.indexOf(button.dataset.scenario);
    if (event.key === 'ArrowRight') index = (index+1)%keys.length;
    else if(event.key === 'ArrowLeft') index = (index+keys.length-1)%keys.length;
    else if(event.key === 'Home') index = 0;
    else if(event.key === 'End') index = keys.length-1;
    else return;
    event.preventDefault(); selectScenario(keys[index]); $(`#tab-${keys[index]}`).focus();
  });
});
document.querySelectorAll('[data-try]').forEach(button => button.addEventListener('click', () => {
  selectScenario(button.dataset.try); $('#workbench').scrollIntoView({behavior:reducedMotion.matches?'instant':'smooth'});
  $(`#tab-${button.dataset.try}`).focus({preventScroll:true});
}));
document.querySelectorAll('.role-row').forEach(row => row.addEventListener('toggle', () => {
  if (row.open) document.querySelectorAll('.role-row').forEach(other => { if (other !== row) other.open = false; });
}));
const menu = $('#menu-toggle');
function closeMenu(){menu.setAttribute('aria-expanded','false');$('#site-nav').classList.remove('open');}
menu.addEventListener('click', () => {const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));$('#site-nav').classList.toggle('open',open);});
$('#site-nav').addEventListener('click',event=>{if(event.target.closest('a'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu.getAttribute('aria-expanded')==='true'){closeMenu();menu.focus();}});
const motionButton = $('#motion-toggle');
const helloButton = $('#hello-button');
const heroElement = $('#hero-mascot');
const deskElement = $('#desk-mascot');
const actorSlots = {
  hero: { element: heroElement, loading: false, attempted: false, inView: false, available: false },
  desk: { element: deskElement, loading: false, attempted: false, inView: false, available: false },
};
const desktopStage = matchMedia('(min-width: 601px)');
const loadingCleanups = [];

function syncMotion() {
  heroActor?.setPaused(motionPaused);
  deskActor?.setPaused(motionPaused);
  const available = actorSlots.hero.available;
  motionButton.disabled = !available;
  helloButton.disabled = !available;
  motionButton.setAttribute('aria-pressed', String(motionPaused));
  motionButton.setAttribute('aria-label', available
    ? (motionPaused ? 'Play mascot motion' : 'Pause mascot motion')
    : 'Mascot motion is currently unavailable');
  motionButton.textContent = motionPaused ? '▷' : 'Ⅱ';
}

function actorStatus(name, { available, status }) {
  if (disposed) return;
  const slot = actorSlots[name];
  slot.available = available;
  slot.element.dataset.mascotReady = String(available);
  slot.element.querySelector('img.mascot-fallback')?.setAttribute('aria-hidden', String(available));
  if (name !== 'hero') return;
  const announcement = $('#mascot-status');
  if (announcement) announcement.textContent = status === 'context-lost'
    ? 'The animated companion is temporarily unavailable. Its portrait is shown instead.'
    : status === 'unavailable'
      ? 'The animated companion could not load. You can still explore Muster and try the example below.'
      : status === 'restored' ? 'The animated companion is available again.' : '';
  if (!available) {
    clearTimeout(helloTimer);
    $('#hero-state').textContent = 'Ready when you are.';
  }
  syncMotion();
}

motionButton.addEventListener('click', () => {
  if (!actorSlots.hero.available) return;
  motionPaused = !motionPaused; syncMotion();
});
reducedMotion.addEventListener('change', () => {
  if (disposed) return;
  motionPaused = reducedMotion.matches; syncMotion();
}, { signal: lifetime.signal });
helloButton.addEventListener('click', () => {
  if (!heroActor?.available) return;
  clearTimeout(helloTimer);
  heroActor.setState('excited');
  $('#hero-state').textContent = 'Hey. Good to meet you.';
  helloTimer = setTimeout(() => {
    if (disposed) return;
    heroActor?.setState('idle'); $('#hero-state').textContent = 'Ready when you are.';
  }, 3400);
});

// Keep the static page usable if optional graphics or their network requests fail.
async function loadActor(name) {
  const slot = actorSlots[name];
  if (disposed || document.hidden || slot.loading || slot.attempted || !slot.inView) return;
  if (name === 'desk' && !desktopStage.matches) return;
  slot.loading = true; slot.attempted = true;
  try {
    const { mountMascot } = await import('./mascot-stage.js');
    if (disposed || lifetime.signal.aborted || !slot.element.isConnected) return;
    if (!slot.inView || document.hidden || (name === 'desk' && !desktopStage.matches)) {
      slot.attempted = false; return;
    }
    const actor = await mountMascot(slot.element, {
      initialState: name === 'hero' ? 'idle' : model.getSnapshot().cue,
      interactive: name === 'hero',
      signal: lifetime.signal,
      onStatus: status => actorStatus(name, status),
    });
    if (disposed || lifetime.signal.aborted || !slot.element.isConnected) { actor.dispose(); return; }
    if (name === 'hero') heroActor = actor;
    else { deskActor = actor; actor.setState(model.getSnapshot().cue); }
    actor.setPaused(motionPaused);
    actorStatus(name, { available: actor.available, status: actor.available ? 'ready' : 'unavailable' });
  } catch (error) {
    if (!disposed) {
      actorStatus(name, { available: false, status: 'unavailable' });
      console.warn('Optional Muster animation did not load.', error);
    }
  } finally { slot.loading = false; }
}

function mountVisibleActors() {
  if (disposed || document.hidden) return;
  void loadActor('hero'); void loadActor('desk');
}
function observeStage(name, element) {
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      actorSlots[name].inView = entries.some(entry => entry.isIntersecting);
      mountVisibleActors();
    }, { rootMargin: '150px' });
    observer.observe(element); loadingCleanups.push(() => observer.disconnect());
  } else {
    const check = () => {
      const rect = element.getBoundingClientRect();
      actorSlots[name].inView = rect.width > 0 && rect.height > 0 && rect.bottom > -150 && rect.top < innerHeight + 150;
      mountVisibleActors();
    };
    window.addEventListener('scroll', check, { passive: true, signal: lifetime.signal });
    window.addEventListener('resize', check, { passive: true, signal: lifetime.signal });
    check();
  }
}

// Only announce enhanced controls after the ordinary page interactions are installed.
render();
syncMotion();
document.querySelectorAll('[data-scenario], #reset-demo, #menu-toggle, [data-try]').forEach(control => {
  if ('disabled' in control) control.disabled = false;
});
document.documentElement.classList.add('enhanced');
observeStage('hero', heroElement);
observeStage('desk', $('#workbench'));
desktopStage.addEventListener('change', mountVisibleActors, { signal: lifetime.signal });
document.addEventListener('visibilitychange', mountVisibleActors, { signal: lifetime.signal });
window.addEventListener('pageshow', mountVisibleActors, { signal: lifetime.signal });
window.addEventListener('pagehide', event => {
  // BFCache preserves this page; the host's visibility handling freezes animation.
  if (event.persisted || disposed) return;
  disposed = true; clearTimeout(helloTimer); lifetime.abort();
  loadingCleanups.splice(0).forEach(cleanup => cleanup());
  heroActor?.dispose(); deskActor?.dispose();
});
