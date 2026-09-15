/* Docs behaviors for every /docs/ page: persisted light/dark theme, the
 * right-hand "On this page" TOC (with scroll-spy) built from h2/h3, and a
 * copy button on every code block. Plain DOM, no dependencies, no build. */
(function () {
  "use strict";

  // ── theme: light-first like the reference site, persisted choice ─────
  var stored = null;
  try { stored = localStorage.getItem("muster-docs-theme"); } catch (e) {}
  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }
  apply(stored === "dark" || stored === "light" ? stored : "light");

  // ── helpers ───────────────────────────────────────────────────────────
  function slug(text, taken) {
    var base = text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "section";
    var s = base, n = 2;
    while (taken.has(s)) s = base + "-" + n++;
    taken.add(s);
    return s;
  }

  document.addEventListener("DOMContentLoaded", function () {
    // theme toggle in the header
    var links = document.querySelector(".docs-header__links");
    if (links) {
      var btn = document.createElement("button");
      btn.className = "theme-toggle";
      btn.setAttribute("aria-label", "Toggle dark mode");
      var SUN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
      var MOON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
      function paint() {
        btn.innerHTML = document.documentElement.getAttribute("data-theme") === "dark" ? SUN : MOON;
      }
      paint();
      btn.addEventListener("click", function () {
        var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        apply(next);
        try { localStorage.setItem("muster-docs-theme", next); } catch (e) {}
        paint();
      });
      links.insertBefore(btn, links.firstChild);
    }

    // ── TOC: collect h2/h3 (giving them ids), build the right rail ─────
    var content = document.querySelector(".docs-content");
    var shell = document.querySelector(".docs-shell");
    if (content && shell) {
      var heads = [].slice.call(content.querySelectorAll("h2, h3")).filter(function (h) {
        return h.textContent.trim();
      });
      var taken = new Set();
      [].slice.call(document.querySelectorAll("[id]")).forEach(function (el) { taken.add(el.id); });
      heads.forEach(function (h) { if (!h.id) h.id = slug(h.textContent, taken); });
      if (heads.length >= 2) {
        var nav = document.createElement("aside");
        nav.className = "docs-toc";
        nav.setAttribute("aria-label", "On this page");
        var html = '<p class="docs-toc__title">On this page</p>';
        heads.forEach(function (h) {
          html += '<a class="' + (h.tagName === "H3" ? "lv3" : "") + '" href="#' + h.id + '"><span>' +
            h.textContent.replace(/\s+/g, " ").trim() + "</span></a>";
        });
        nav.innerHTML = html;
        shell.appendChild(nav);

        // scroll-spy: the last heading above the fold is the active one
        var tocLinks = [].slice.call(nav.querySelectorAll("a"));
        var byId = {};
        heads.forEach(function (h, i) { byId[h.id] = tocLinks[i]; });
        var ticking = false;
        function spy() {
          ticking = false;
          var current = null;
          for (var id in byId) {
            var el = document.getElementById(id);
            if (el && el.getBoundingClientRect().top < 96) current = id;
          }
          tocLinks.forEach(function (a) { a.classList.remove("active"); });
          if (current) byId[current].classList.add("active");
        }
        window.addEventListener("scroll", function () {
          if (!ticking) { ticking = true; requestAnimationFrame(spy); }
        }, { passive: true });
        spy();
      }
    }

    // ── copy button on every code block ─────────────────────────────────
    [].slice.call(document.querySelectorAll("pre")).forEach(function (pre) {
      var btn = document.createElement("button");
      btn.className = "code-copy";
      btn.type = "button";
      btn.textContent = "Copy";
      btn.setAttribute("aria-label", "Copy code to clipboard");
      btn.addEventListener("click", function () {
        var text = (pre.querySelector("code") || pre).textContent || "";
        function done(ok) {
          btn.textContent = ok ? "Copied" : "Failed";
          setTimeout(function () { btn.textContent = "Copy"; }, 1400);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        } else {
          done(false);
        }
      });
      pre.appendChild(btn);
    });
  });
})();
