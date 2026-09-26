/* Landing-only presentation and public release metadata. No account or provider calls. */
(function () {
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  var showcase = document.querySelector("[data-product-showcase]");
  if (showcase) {
    var tablist = showcase.querySelector("[data-product-tabs]");
    var tabs = Array.from(showcase.querySelectorAll("[data-product-tab]"));
    var panels = Array.from(showcase.querySelectorAll("[data-product-panel]"));
    function selectTab(index, focus) {
      tabs.forEach(function (tab, i) {
        tab.setAttribute("aria-selected", String(i === index));
        tab.tabIndex = i === index ? 0 : -1;
      });
      panels.forEach(function (panel) { panel.hidden = panel.dataset.productPanel !== tabs[index].dataset.productTab; });
      if (focus) tabs[index].focus({ preventScroll:true });
    }
    if (tablist && tabs.length === panels.length && tabs.length) {
      tablist.setAttribute("role", "tablist");
      tabs.forEach(function (tab, i) {
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", "product-" + tab.dataset.productTab);
        tab.addEventListener("click", function () { selectTab(i, false); });
        tab.addEventListener("keydown", function (event) {
          var index = event.key === "ArrowRight" ? (i + 1) % tabs.length : event.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
          if (index < 0) return;
          event.preventDefault();
          selectTab(index, true);
        });
      });
      panels.forEach(function (panel) { panel.setAttribute("role", "tabpanel"); panel.tabIndex = 0; });
      selectTab(0, false);
      tablist.hidden = false;
    }
  }

  // Small, finite entrances only. Content is visible even if enhancement fails.
  if ("IntersectionObserver" in window && !reduced.matches) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-story-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold:0.12 });
    document.querySelectorAll("[data-story-reveal]").forEach(function (section) { observer.observe(section); });
  }
  var greet = document.querySelector("[data-mascot-greet]");
  var greeting = document.querySelector("[data-mascot-greeting]");
  var closing = document.getElementById("meet-muster");
  if (greet && greeting && closing) {
    var greetings = ["Hello! What shall we work on?", "One small task is a lovely place to start.", "A little team. A little more room for you."];
    var greetIndex = 0;
    var greetingTimer = null;
    greet.hidden = false;
    greet.addEventListener("click", function () {
      greeting.textContent = greetings[greetIndex++ % greetings.length];
      if (greetingTimer !== null) window.clearTimeout(greetingTimer);
      closing.classList.remove("is-greeting");
      if (!reduced.matches) {
        // Restart this finite, user-requested reaction without scrolling or focus changes.
        void closing.offsetWidth;
        closing.classList.add("is-greeting");
        greetingTimer = window.setTimeout(function () { closing.classList.remove("is-greeting"); greetingTimer = null; }, 750);
      }
    });
  }

  var status = document.querySelector("[data-release-status]");
  var links = Array.from(document.querySelectorAll("[data-download-file]"));
  if (!status || !links.length) return;
  var allowed = ["Muster.dmg", "Muster-intel.dmg", "Muster-setup.exe", "Muster.deb", "Muster.AppImage"];
  var origin = "https://muster.today/downloads/";
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON boundary: reject scalar/array envelopes before reading manifest fields.
  function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function validFile(value) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON boundary: a checksum must be a string before its exact digest format is checked.
    return isRecord(value) && Number.isSafeInteger(value.size) && value.size > 0 && value.size < 100000000000 && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/i.test(value.sha256);
  }
  function unavailable() {
    status.textContent = "Desktop release details are unavailable. Check the installation guide.";
    document.querySelectorAll("[data-download-meta]").forEach(function (node) { node.textContent = "Availability not confirmed"; });
  }
  var controller = new AbortController();
  var timer = window.setTimeout(function () { controller.abort(); }, 5000);
  fetch("/downloads/latest.json", { signal:controller.signal, cache:"no-cache", credentials:"omit" })
    .then(function (response) { if (!response.ok) throw new Error("Manifest unavailable"); return response.json(); })
    .then(function (meta) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON boundary: require a string, then validate the complete stable release identifier.
      if (!isRecord(meta) || typeof meta.version !== "string" || meta.version.length > 80 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(meta.version) || !isRecord(meta.files)) throw new Error("Invalid manifest");
      var ready = [];
      links.forEach(function (link) {
        var name = link.dataset.downloadFile;
        var descriptor = Object.hasOwn(meta.files, name) ? meta.files[name] : null;
        var info = document.querySelector('[data-download-meta="' + name + '"]');
        if (!allowed.includes(name) || !validFile(descriptor)) { if (info) info.textContent = "Availability not confirmed"; return; }
        // Never consume remote href/url fields or interpolate untrusted filenames.
        link.href = origin + name;
        if (info) info.textContent = "v" + meta.version + " · " + (descriptor.size / 1048576).toLocaleString(undefined, { maximumFractionDigits:1 }) + " MB";
        var checksum = document.querySelector('[data-download-checksum="' + name + '"]');
        if (checksum) { checksum.querySelector("code").textContent = descriptor.sha256.toLowerCase(); checksum.hidden = false; }
        ready.push(name);
      });
      if (!ready.length) { unavailable(); return; }
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON boundary: numeric dates are not accepted as publication timestamps.
      var published = typeof meta.published === "string" ? new Date(meta.published) : null;
      status.textContent = "Desktop v" + meta.version + (published && Number.isFinite(published.getTime()) ? " · Published " + published.toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric", timeZone:"UTC" }) : "") + (ready.length < allowed.length ? " · Some downloads unavailable" : "");
      var version = document.getElementById("hero-dl-version");
      if (version) version.textContent = "v" + meta.version;
      var hero = document.getElementById("hero-dl");
      var label = document.getElementById("hero-dl-label");
      var ua = navigator.userAgent;
      var mobile = /iPhone|iPad|iPod|Android/i.test(ua) || (/Mac/i.test(navigator.platform || "") && navigator.maxTouchPoints > 1);
      var file = !mobile && /Windows/i.test(ua) ? "Muster-setup.exe" : !mobile && /Linux/i.test(ua) ? "Muster.AppImage" : null;
      if (hero && label && ready.includes(file)) {
        hero.href = origin + file;
        label.textContent = file === "Muster-setup.exe" ? "Download for Windows" : "Download for Linux";
      }
      // macOS keeps the platform picker: a web UA does not reliably identify its CPU.
    })
    .catch(unavailable)
    .finally(function () { window.clearTimeout(timer); });
})();
