/* Scripted landing preview. No model, network, analytics or persistence. */
(function () {
  "use strict";
  var root = document.querySelector("[data-workspace-demo]");
  if (!root) return;
  var shell = root.querySelector("[data-demo-shell]");
  var fallback = root.querySelector("[data-demo-fallback]");
  var roster = root.querySelector("[data-demo-roster]");
  var messages = root.querySelector("[data-demo-messages]");
  var form = root.querySelector("[data-demo-form]");
  var input = root.querySelector("[data-demo-input]");
  var inputLabel = root.querySelector("[data-demo-input-label]");
  var send = root.querySelector("[data-demo-send]");
  var prompt = root.querySelector("[data-demo-prompt]");
  var status = root.querySelector("[data-demo-status]");
  var pending = root.querySelector("[data-demo-pending]");
  var headerName = root.querySelector("[data-demo-name]");
  var headerAvatar = root.querySelector("[data-demo-avatar]");
  var inspector = root.querySelector("[data-demo-inspector]");
  var details = root.querySelector("[data-demo-details]");
  var paperTitle = root.querySelector("[data-demo-paper-title]");
  var paperItems = root.querySelector("[data-demo-paper-items]");
  var disclosure = root.querySelector("[data-demo-disclosure]");
  var reset = root.querySelector("[data-demo-reset]");
  var notice = root.querySelector("[data-demo-notice]");
  if (!shell || !fallback || !roster || !messages || !form || !input || !inputLabel ||
      !send || !prompt || !status || !pending || !headerName || !headerAvatar ||
      !inspector || !details || !paperTitle || !paperItems || !disclosure || !reset || !notice) return;

  var bots = [
    { id:"milo", name:"Milo", role:"Daily planning", color:"#f08a24", title:"A little room for your day.",
      question:"Help me plan a calmer morning.",
      intro:"A busy day is easier with a clear starting point. Try a sample morning plan, or tell me what is on your mind.",
      answer:"Here is an example with three priorities and a little breathing room. In your workspace, we would start with the context and tools you choose.",
      steps:["One focused hour on your most important task", "A short window for messages and small follow-ups", "A break before the next commitment"],
      note:"Sample calendar only. This preview cannot read or change your calendar." },
    { id:"scout", name:"Scout", role:"Email drafts", color:"#75b896", title:"A thoughtful first draft.",
      question:"Help me draft a friendly follow-up.",
      intro:"A good reply starts with what you want to say. Try a sample follow-up, then review the proposed next step.",
      answer:"Here is a sample approach for a warm, concise follow-up. I would prepare a draft for you to review before anything is sent.",
      steps:["Open with a short, friendly check-in", "Make the next step clear and easy to answer", "Review the draft and recipient before sending"],
      note:"Sample correspondence only. No inbox is connected and no email is sent." },
    { id:"nova", name:"Nova", role:"Research", color:"#819fdb", title:"Make the next choice clearer.",
      question:"Help me research an idea.",
      intro:"Let's give an idea a little structure. Try the research example to see how a question becomes a useful next step.",
      answer:"This example turns a broad question into a small research plan. A real task would need sources and evidence before drawing a conclusion.",
      steps:["Write down the question you need to answer", "Compare a few relevant sources and viewpoints", "Separate evidence from assumptions in the summary"],
      note:"Sample research plan only. No websites are opened or searched by this preview." },
    { id:"atlas", name:"Atlas", role:"Projects", color:"#b799d4", title:"One useful next step.",
      question:"Break my project into small steps.",
      intro:"You do not need the whole project figured out to begin. Try a sample plan for making the next step manageable.",
      answer:"Here is a sample starting point. Keep the first task small enough to finish and review before deciding what comes next.",
      steps:["Define what a useful first result looks like", "Choose one small task and the tools it needs", "Review the outcome before expanding the plan"],
      note:"Sample project only. No files are changed and no task runs outside this page." }
  ];
  var selected = "milo";
  var states = {};
  var sequence = 0;
  var wide = window.matchMedia("(min-width: 1000px)");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function svgNode(tag, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }
  function avatar(bot) {
    var svg = svgNode("svg", { viewBox:"-112 -112 224 224", "aria-hidden":"true", class:"demo-avatar" });
    svg.appendChild(svgNode("use", { href:"#hero-face-body", fill:bot.color }));
    var eyes = svgNode("g", { class:"demo-avatar__eyes" });
    [-15,38].forEach(function (x,i) {
      var g = svgNode("g", { transform:"translate(" + x + " " + (i ? -6 : -2) + ") rotate(-4)" });
      g.appendChild(svgNode("use", { href:"#hero-face-eye", fill:"#fffaf3" }));
      eyes.appendChild(g);
    });
    svg.appendChild(eyes);
    return svg;
  }
  function botById(id) { return bots.find(function (bot) { return bot.id === id; }); }
  function freshState() { return { draft:"", entries:[], busy:false, timer:null, ticket:0, scroll:0 }; }
  function clearStates() {
    bots.forEach(function (bot) {
      if (states[bot.id] && states[bot.id].timer !== null) window.clearTimeout(states[bot.id].timer);
      states[bot.id] = freshState();
    });
  }
  function updateInputState() {
    states[selected].draft = input.value;
    send.disabled = states[selected].busy || !input.value.trim();
    prompt.disabled = states[selected].busy;
  }
  function setDetails(open) {
    inspector.hidden = !open;
    root.classList.toggle("is-details-open", open);
    details.setAttribute("aria-expanded", String(open));
    details.setAttribute("aria-label", open ? "Hide task details" : "Show task details");
  }
  function appendMessage(bot, entry) {
    var article = element("div", "demo-message" + (entry.who === "user" ? " demo-message--user" : ""));
    var by = element("div", "demo-message__by");
    if (entry.who !== "user") by.appendChild(avatar(bot));
    by.appendChild(element("span", "", entry.who === "user" ? "You · demo" : bot.name + " · sample"));
    article.appendChild(by);
    article.appendChild(element("p", "", entry.text));
    if (entry.result) article.appendChild(resultCard(bot, entry));
    messages.appendChild(article);
  }
  function resultCard(bot, entry) {
    var card = element("div", "demo-result");
    card.appendChild(element("div", "demo-result__eyebrow", "For your review · sample"));
    card.appendChild(element("strong", "", bot.title));
    var list = element("ul");
    bot.steps.forEach(function (step) { list.appendChild(element("li", "", step)); });
    card.appendChild(list);
    if (entry.choice) {
      card.appendChild(element("p", "demo-result__receipt", entry.choice === "approve"
        ? "Sample approved. No real action was taken." : "Sample skipped. No real action was taken."));
    } else {
      var actions = element("div", "demo-result__actions");
      [["approve","Approve sample"],["skip","Skip sample"]].forEach(function (choice) {
        var button = element("button", "", choice[1]);
        button.type = "button";
        button.addEventListener("click", function () {
          entry.choice = choice[0];
          // Keep focus in place after replacing this card's controls.
          var replacement = resultCard(bot, entry);
          replacement.tabIndex = -1;
          card.replaceWith(replacement);
          replacement.focus({ preventScroll:true });
          notice.textContent = choice[0] === "approve" ? "Sample approved. No real action was taken." : "Sample skipped. No real action was taken.";
        });
        actions.appendChild(button);
      });
      card.appendChild(actions);
    }
    return card;
  }
  function render(autoScroll) {
    var bot = botById(selected);
    var state = states[selected];
    roster.querySelectorAll("[data-demo-bot]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.demoBot === selected));
    });
    headerName.textContent = bot.name;
    headerAvatar.replaceChildren(avatar(bot));
    inputLabel.textContent = "Message " + bot.name + " in the demo";
    input.placeholder = "Message " + bot.name + "…";
    input.value = state.draft;
    prompt.textContent = bot.question;
    status.textContent = state.busy ? "Preparing a sample…" : state.entries.length ? "Ready for your review" : "Ready for a task";
    pending.hidden = !state.busy;
    messages.setAttribute("aria-label", bot.name + " sample conversation");
    messages.setAttribute("aria-busy", String(state.busy));
    messages.replaceChildren();
    appendMessage(bot, {who:"bot",text:bot.intro});
    state.entries.forEach(function (entry) { appendMessage(bot, entry); });
    paperTitle.textContent = bot.title;
    paperItems.replaceChildren();
    bot.steps.forEach(function (step) { paperItems.appendChild(element("li", "", step)); });
    root.querySelector("[data-demo-task-note]").textContent = bot.note;
    updateInputState();
    messages.scrollTop = autoScroll ? messages.scrollHeight : state.scroll;
  }
  function submit() {
    var id = selected, state = states[id];
    var text = input.value.trim().slice(0,500);
    if (!text || state.busy) return;
    state.draft = "";
    state.entries.push({who:"user",text:text});
    // Cap in-page history; no storage is written.
    state.entries = state.entries.slice(-12);
    state.busy = true;
    state.ticket = ++sequence;
    var ticket = state.ticket;
    input.value = "";
    render(true);
    state.timer = window.setTimeout(function () {
      if (states[id] !== state || state.ticket !== ticket) return;
      state.timer = null;
      state.busy = false;
      state.entries.push({who:"bot",text:"This reply is scripted for the demo. " + botById(id).answer,result:true});
      state.scroll = 0;
      if (selected === id) render(true);
    }, reduced.matches ? 0 : 650);
  }

  clearStates();
  bots.forEach(function (bot) {
    var button = element("button", "demo-bot");
    button.type = "button";
    button.dataset.demoBot = bot.id;
    button.setAttribute("aria-label", bot.name + " · " + bot.role);
    button.setAttribute("aria-pressed", String(bot.id === selected));
    button.appendChild(avatar(bot));
    var copy = element("span", "demo-bot__copy");
    copy.appendChild(element("strong", "", bot.name));
    copy.appendChild(element("small", "", bot.role));
    button.appendChild(copy);
    button.addEventListener("click", function () {
      states[selected].draft = input.value;
      states[selected].scroll = messages.scrollTop;
      selected = bot.id;
      notice.textContent = "";
      if (!wide.matches) setDetails(false);
      render(false);
    });
    roster.appendChild(button);
  });
  input.addEventListener("input", updateInputState);
  form.addEventListener("submit", function (event) { event.preventDefault(); submit(); });
  prompt.addEventListener("click", function () {
    input.value = botById(selected).question;
    updateInputState();
    input.focus({ preventScroll:true });
  });
  details.addEventListener("click", function () { setDetails(inspector.hidden); });
  wide.addEventListener("change", function () { setDetails(wide.matches); });
  reset.addEventListener("click", function () {
    clearStates();
    selected = "milo";
    notice.textContent = "Demo reset. Sample messages and drafts cleared.";
    setDetails(wide.matches);
    render(false);
  });
  render(false);
  setDetails(wide.matches);
  fallback.hidden = true;
  shell.hidden = false;
  disclosure.hidden = false;
})();
