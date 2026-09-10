// Blooma admin: makes the "blooma." wordmark in the sidebar (and its mobile topbar twin)
// clickable everywhere, always going back to the admin dashboard — a global rule so no
// individual page has to wire it up itself.
(function () {
  var SELECTOR = '.sb-logo, .tb-logo-mobile';
  var wired = new WeakSet();

  function wire(el) {
    if (wired.has(el)) return;
    wired.add(el);
    el.style.cursor = 'pointer';
    el.addEventListener('click', function () {
      window.location.href = '/venue/admin';
    });
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
