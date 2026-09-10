// Blooma admin: adds a fade-out edge to horizontally-scrollable strips (filter tabs, data
// tables, the staff/date pickers, etc.) so it's visually obvious there's more to scroll to,
// on both desktop and mobile. Uses a CSS mask on the element itself rather than a matching
// background-color overlay, so it works correctly regardless of what's behind it, and requires
// zero per-page configuration. The fade on a given edge disappears once you've scrolled all the
// way to it, so it never lies about there being more content.
(function () {
  var SELECTOR = '.filter-tabs, .table-wrap, .st-tabs, .staff-filter-row, .cal-month-scroll, .timeline-wrap, .date-row, .re-link-box';
  var EDGE = 22; // px of fade at each side
  var wired = new WeakSet();

  function applyFade(el) {
    var maxScroll = el.scrollWidth - el.clientWidth;
    if (maxScroll <= 2) {
      el.style.maskImage = '';
      el.style.webkitMaskImage = '';
      return;
    }
    var atStart = el.scrollLeft <= 2;
    var atEnd = el.scrollLeft >= maxScroll - 2;
    var left = atStart ? 'black 0' : 'transparent 0';
    var right = atEnd ? 'black 100%' : 'transparent 100%';
    var mask = 'linear-gradient(to right, ' + left + ', black ' + EDGE + 'px, black calc(100% - ' + EDGE + 'px), ' + right + ')';
    el.style.maskImage = mask;
    el.style.webkitMaskImage = mask;
  }

  function wire(el) {
    if (wired.has(el)) { applyFade(el); return; }
    wired.add(el);
    applyFade(el);
    el.addEventListener('scroll', function () { applyFade(el); }, { passive: true });
    if (window.ResizeObserver) {
      new ResizeObserver(function () { applyFade(el); }).observe(el);
    } else {
      window.addEventListener('resize', function () { applyFade(el); });
    }
  }

  function scan() {
    document.querySelectorAll(SELECTOR).forEach(wire);
  }

  var scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(function () { scanQueued = false; scan(); });
  }

  var observer = new MutationObserver(queueScan);
  observer.observe(document.body, { childList: true, subtree: true });

  scan();
})();
