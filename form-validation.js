// Blooma admin: replaces the browser's default grey validation tooltip with an inline, styled
// error matching the rest of the dark-mode UI — on every form, with no per-form markup changes.
// Works by reusing each field's own native constraint-validation state (required, type=email,
// pattern, min/max, ...) rather than reimplementing validation rules; it only changes how a
// failure is *displayed*, via document-level capture-phase listeners so it always runs before
// a page's own submit handler (inline onsubmit="" or addEventListener alike).
(function () {
  var STYLE_ID = 'bl-form-validation-style';
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.bl-field-invalid{border-color:#FF6B81 !important; box-shadow:0 0 0 3px rgba(255,107,129,.14) !important;}' +
      '.bl-field-error{font-size:11.5px; font-weight:600; color:#FF6B81; margin-top:5px; display:flex; align-items:center; gap:5px; line-height:1.4;}';
    document.head.appendChild(style);
  }

  function clearFieldError(field) {
    field.classList.remove('bl-field-invalid');
    var next = field.nextElementSibling;
    if (next && next.classList && next.classList.contains('bl-field-error')) next.remove();
  }

  function showFieldError(field) {
    field.classList.add('bl-field-invalid');
    var next = field.nextElementSibling;
    if (!(next && next.classList && next.classList.contains('bl-field-error'))) {
      var msg = document.createElement('div');
      msg.className = 'bl-field-error';
      field.insertAdjacentElement('afterend', msg);
      next = msg;
    }
    next.textContent = field.validationMessage || 'This field is required';
  }

  function ensureNoValidate() {
    document.querySelectorAll('form:not([novalidate])').forEach(function (f) {
      f.setAttribute('novalidate', '');
    });
  }

  var scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(function () { scanQueued = false; ensureNoValidate(); });
  }
  new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });
  ensureNoValidate();

  // Clear a field's error as soon as it becomes valid again, while the user is still typing.
  document.addEventListener('input', function (e) {
    var field = e.target;
    if (field && field.matches && field.matches('input,select,textarea') && field.willValidate && field.checkValidity()) {
      clearFieldError(field);
    }
  }, true);

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var invalidFields = [];
    form.querySelectorAll('input,select,textarea').forEach(function (field) {
      if (!field.willValidate) return;
      if (!field.checkValidity()) { invalidFields.push(field); showFieldError(field); }
      else clearFieldError(field);
    });
    if (invalidFields.length) {
      e.preventDefault();
      e.stopPropagation();
      invalidFields[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      invalidFields[0].focus();
    }
  }, true);
})();
