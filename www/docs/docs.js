/* Progressive reading controls. Guides, navigation and heading anchors also
 * work without JavaScript; the saved docs theme keeps its existing key. */
(function () {
  "use strict";

  var stored = null;
  try { stored = localStorage.getItem("muster-docs-theme"); } catch {}
  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }
  apply(stored === "dark" || stored === "light" ? stored : "light");

  function slug(text, taken) {
    var base = text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "section";
    var value = base, suffix = 2;
    while (taken.has(value)) value = base + "-" + suffix++;
    taken.add(value);
    return value;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var links = document.querySelector(".docs-header__links");
    if (links) {
      var themeButton = document.createElement("button");
      themeButton.className = "theme-toggle";
      themeButton.type = "button";
      themeButton.setAttribute("aria-label", "Toggle dark mode");
      var sun = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
      var moon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
      function paintTheme() {
        var dark = document.documentElement.getAttribute("data-theme") === "dark";
        themeButton.innerHTML = dark ? sun : moon;
        themeButton.setAttribute("aria-pressed", String(dark));
        themeButton.title = dark ? "Switch to light theme" : "Switch to dark theme";
      }
      paintTheme();
      themeButton.addEventListener("click", function () {
        var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        apply(next);
        try { localStorage.setItem("muster-docs-theme", next); } catch {}
        paintTheme();
      });
      links.insertBefore(themeButton, links.firstChild);
    }

    var menuButton = document.getElementById("docs-menu-toggle");
    var sidebar = document.getElementById("docs-navigation");
    if (menuButton && sidebar) {
      var mobile = window.matchMedia("(max-width: 900px)");
      function setMenu(open) {
        menuButton.setAttribute("aria-expanded", String(open));
        sidebar.classList.toggle("is-open", open);
      }
      menuButton.addEventListener("click", function () {
        setMenu(menuButton.getAttribute("aria-expanded") !== "true");
      });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && mobile.matches && menuButton.getAttribute("aria-expanded") === "true") {
          setMenu(false);
          menuButton.focus();
        }
      });
      mobile.addEventListener("change", function () {
        var sidebarHadFocus = sidebar.contains(document.activeElement);
        setMenu(false);
        if (mobile.matches && sidebarHadFocus) menuButton.focus();
      });
      menuButton.hidden = false;
      document.documentElement.classList.add("docs-enhanced");
    }

    var content = document.querySelector(".docs-content");
    var shell = document.querySelector(".docs-shell");
    if (content && shell) {
      var headings = Array.from(content.querySelectorAll("h2, h3")).filter(function (heading) {
        return heading.textContent.trim();
      });
      var taken = new Set();
      document.querySelectorAll("[id]").forEach(function (element) { taken.add(element.id); });
      headings.forEach(function (heading) { if (!heading.id) heading.id = slug(heading.textContent, taken); });
      if (headings.length >= 2) {
        var toc = document.createElement("aside");
        toc.className = "docs-toc";
        toc.setAttribute("aria-label", "On this page");
        var title = document.createElement("p");
        title.className = "docs-toc__title";
        title.textContent = "On this page";
        toc.appendChild(title);
        var tocLinks = headings.map(function (heading) {
          var link = document.createElement("a");
          if (heading.tagName === "H3") link.className = "lv3";
          link.setAttribute("href", "#" + heading.id);
          link.textContent = heading.textContent.replace(/\s+/g, " ").trim();
          toc.appendChild(link);
          return link;
        });
        shell.appendChild(toc);
        var ticking = false;
        function spy() {
          ticking = false;
          var current = -1;
          headings.forEach(function (heading, index) {
            if (heading.getBoundingClientRect().top < 140) current = index;
          });
          tocLinks.forEach(function (link, index) {
            link.classList.toggle("active", index === current);
            if (index === current) link.setAttribute("aria-current", "location");
            else link.removeAttribute("aria-current");
          });
        }
        window.addEventListener("scroll", function () {
          if (!ticking) { ticking = true; requestAnimationFrame(spy); }
        }, { passive: true });
        spy();
      }
    }

    var blocks = document.querySelectorAll(".docs-content pre");
    if (blocks.length && content) {
      var copyStatus = document.createElement("p");
      copyStatus.className = "docs-copy-status";
      copyStatus.setAttribute("role", "status");
      content.appendChild(copyStatus);
      blocks.forEach(function (pre) {
        // Capture the example before adding the control, including pre-only examples.
        var text = (pre.querySelector("code") || pre).textContent || "";
        var button = document.createElement("button");
        var resetTimer;
        button.className = "code-copy";
        button.type = "button";
        button.textContent = "Copy";
        button.setAttribute("aria-label", "Copy code to clipboard");
        pre.setAttribute("tabindex", "0");
        button.addEventListener("click", function () {
          copyStatus.textContent = "";
          function done(ok) {
            clearTimeout(resetTimer);
            button.textContent = ok ? "Copied" : "Failed";
            copyStatus.textContent = ok ? "Code copied to clipboard." : "Could not copy. Select the code and copy it manually.";
            resetTimer = setTimeout(function () { button.textContent = "Copy"; }, 1400);
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
          } else {
            done(false);
          }
        });
        pre.appendChild(button);
      });
    }
  });
})();
