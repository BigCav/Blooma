/* ---------------------------------------------------
   Blooma — venue-admin light/dark toggle.
   Loaded synchronously in <head> on every /venue/admin/* page so the saved theme is applied
   before first paint (no flash). The choice is remembered per browser and kept in sync across
   open tabs. Light is the default.
--------------------------------------------------- */
(function(){
  var KEY = 'blooma-admin-theme';

  function read(){
    try{ return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; }catch(e){ return 'light'; }
  }
  function write(t){
    try{ localStorage.setItem(KEY, t); }catch(e){}
  }
  function apply(t){
    document.documentElement.setAttribute('data-theme', t);
  }

  var SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';

  function paintButton(){
    var btn = document.getElementById('bloomaThemeToggle');
    if(!btn) return;
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    btn.innerHTML = light ? MOON : SUN;
    var label = light ? 'Switch to dark mode' : 'Switch to light mode';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  function toggle(){
    var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    apply(next);
    write(next);
    paintButton();
  }

  function mount(){
    if(document.getElementById('bloomaThemeToggle')) return;
    var right = document.querySelector('.tb-right');
    if(!right) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'bloomaThemeToggle';
    btn.className = 'theme-toggle';
    btn.addEventListener('click', toggle);
    right.insertBefore(btn, right.firstChild);
    paintButton();
  }

  apply(read());

  window.addEventListener('storage', function(e){
    if(e.key !== KEY) return;
    apply(read());
    paintButton();
  });

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.BloomaTheme = { toggle: toggle, get: function(){ return document.documentElement.getAttribute('data-theme'); } };
})();
