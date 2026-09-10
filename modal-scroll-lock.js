// Blooma admin: locks background scroll behind any open modal or the mobile sidebar drawer.
// Watches for .modal-overlay/.sb-overlay gaining or losing the "open" class (however each page's
// own JS toggles it) and locks document.body via the position:fixed trick, which — unlike plain
// overflow:hidden — reliably stops the background page from dragging on iOS/Android touch too.
(function () {
  var scrollY = 0;
  var locked = false;

  function anyOpen() {
    return !!document.querySelector('.modal-overlay.open, .sb-overlay.open');
  }

  function lock() {
    if (locked) return;
    locked = true;
    scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    var body = document.body.style;
    body.position = 'fixed';
    body.top = (-scrollY) + 'px';
    body.left = '0';
    body.right = '0';
    body.width = '100%';
  }

  function unlock() {
    if (!locked) return;
    locked = false;
    var body = document.body.style;
    body.position = '';
    body.top = '';
    body.left = '';
    body.right = '';
    body.width = '';
    window.scrollTo(0, scrollY);
  }

  function sync() {
    if (anyOpen()) lock(); else unlock();
  }

  var observer = new MutationObserver(function (mutations) {
    var relevant = mutations.some(function (m) {
      var t = m.target;
      return t && t.classList && (t.classList.contains('modal-overlay') || t.classList.contains('sb-overlay'));
    });
    if (relevant) sync();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });

  sync();
})();
