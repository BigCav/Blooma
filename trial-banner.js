/* ---------------------------------------------------
   Blooma — free trial banner + expiry gate.
   Shared across every /venue/admin/* page (included via a single
   <script src="/trial-banner.js"> tag). Self-contained: reads the
   page's already-declared `supabaseClient` (every admin page defines
   one with the same anon key/storageKey) and does its own auth/trial
   check independently of each page's own boot sequence, so it works
   the same way everywhere without each page having to wire it up.

   Trial state lives in venue_billing (trial_ends_at, banner_dismissed),
   started once per venue by a DB trigger on first owner_profiles insert
   (see start_venue_trial()). Pre-existing venues have trial_ends_at =
   null, which this script treats as "never show banner, never gate".
--------------------------------------------------- */
(function(){
  var PURPLE = '#6D5FE8';
  var PURPLE_DARK = '#5C4EDB';

  function injectStyles(){
    var style = document.createElement('style');
    style.textContent = [
      '#bloomaTrialBanner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;',
      'background:' + PURPLE + ';color:#fff;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
      'font-size:13px;font-weight:600;padding:10px 16px;position:relative;z-index:200;}',
      '#bloomaTrialBanner .btb-msg{flex:1;min-width:0;}',
      '#bloomaTrialBanner .btb-cta{background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.4);color:#fff;',
      'font-weight:700;font-size:12.5px;padding:6px 12px;border-radius:7px;cursor:pointer;white-space:nowrap;flex:none;}',
      '#bloomaTrialBanner .btb-cta:hover{background:rgba(255,255,255,0.28);}',
      '#bloomaTrialBanner .btb-close{background:none;border:none;color:rgba(255,255,255,0.85);cursor:pointer;',
      'width:22px;height:22px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:6px;}',
      '#bloomaTrialBanner .btb-close:hover{background:rgba(255,255,255,0.18);}',
      '@media (max-width:640px){#bloomaTrialBanner{font-size:12.5px;padding:9px 12px;}}',
      '#bloomaTrialGate{position:fixed;inset:0;z-index:9999;background:rgba(10,9,14,0.72);',
      'display:flex;align-items:center;justify-content:center;padding:20px;',
      'font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}',
      '#bloomaTrialGate .btg-card{background:#1C1B24;border:1px solid #2E2D3C;border-radius:18px;',
      'max-width:400px;width:100%;padding:30px 26px;text-align:center;color:#F2F1F7;}',
      '#bloomaTrialGate .btg-icon{width:52px;height:52px;border-radius:50%;background:rgba(109,95,232,0.16);',
      'display:flex;align-items:center;justify-content:center;margin:0 auto 16px;}',
      '#bloomaTrialGate h2{font-size:19px;font-weight:800;margin:0 0 8px;}',
      '#bloomaTrialGate p{font-size:13.5px;color:#9F9CB0;line-height:1.55;margin:0 0 22px;}',
      '#bloomaTrialGate .btg-upgrade{width:100%;background:' + PURPLE + ';color:#fff;border:none;',
      'font-weight:700;font-size:14px;padding:13px;border-radius:10px;cursor:pointer;margin-bottom:10px;}',
      '#bloomaTrialGate .btg-upgrade:hover{background:' + PURPLE_DARK + ';}',
      '#bloomaTrialGate .btg-upgrade:disabled{opacity:.6;cursor:not-allowed;}',
      '#bloomaTrialGate .btg-logout{background:none;border:none;color:#6C6980;font-size:12.5px;font-weight:600;cursor:pointer;padding:6px;}',
    ].join('');
    document.head.appendChild(style);
  }

  function daysLeft(trialEndsAtIso){
    var ms = new Date(trialEndsAtIso).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 86400000));
  }

  function showBanner(trialEndsAtIso){
    if(document.getElementById('bloomaTrialBanner')) return;
    var n = daysLeft(trialEndsAtIso);
    var bar = document.createElement('div');
    bar.id = 'bloomaTrialBanner';
    bar.innerHTML =
      '<span class="btb-msg">You have ' + n + ' day' + (n===1?'':'s') + ' left on your free trial.</span>' +
      '<button class="btb-cta" id="btbUpgradeBtn" type="button">Upgrade now</button>' +
      '<button class="btb-close" id="btbCloseBtn" type="button" aria-label="Dismiss">&times;</button>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.getElementById('btbUpgradeBtn').addEventListener('click', startCheckoutRedirect);
    document.getElementById('btbCloseBtn').addEventListener('click', function(){
      bar.remove();
      supabaseClient.rpc('dismiss_trial_banner').then(function(){}, function(){});
    });
  }

  function showGate(){
    if(document.getElementById('bloomaTrialGate')) return;
    document.body.style.overflow = 'hidden';
    var wrap = document.createElement('div');
    wrap.id = 'bloomaTrialGate';
    wrap.innerHTML =
      '<div class="btg-card">' +
        '<div class="btg-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#B7ADF5" stroke-width="2"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>' +
        '<h2>Your free trial has ended</h2>' +
        '<p>Subscribe to keep using Blooma and pick up right where you left off — your data is all still here.</p>' +
        '<button class="btg-upgrade" id="btgUpgradeBtn" type="button">Subscribe to continue</button>' +
        '<button class="btg-logout" id="btgLogoutBtn" type="button">Log out</button>' +
      '</div>';
    document.body.appendChild(wrap);
    document.getElementById('btgUpgradeBtn').addEventListener('click', function(){ startCheckoutRedirect(this); });
    document.getElementById('btgLogoutBtn').addEventListener('click', function(){
      supabaseClient.auth.signOut().finally(function(){ window.location.href = '/business-auth?view=login'; });
    });
  }

  function startCheckoutRedirect(btnEl){
    var btn = btnEl && btnEl.id ? btnEl : document.getElementById('btgUpgradeBtn');
    var original = btn ? btn.textContent : null;
    if(btn){ btn.disabled = true; btn.textContent = 'Loading…'; }
    supabaseClient.auth.getSession().then(function(res){
      var session = res && res.data && res.data.session;
      if(!session) throw new Error('Please log in again.');
      return fetch('/api/stripe/create-checkout-session', {
        method: 'POST',
        headers: {'Authorization':'Bearer '+session.access_token, 'Content-Type':'application/json'}
      }).then(function(r){ return r.json().then(function(body){ if(!r.ok) throw new Error(body.error||'Could not start checkout'); return body; }); });
    }).then(function(body){
      window.location.href = body.url;
    }).catch(function(err){
      if(btn){ btn.disabled = false; btn.textContent = original; }
      alert(err.message || 'Could not start checkout. Please try again.');
    });
  }

  function init(){
    if(typeof supabaseClient === 'undefined' || !supabaseClient){ return; }
    injectStyles();
    supabaseClient.auth.getSession().then(function(res){
      var session = res && res.data && res.data.session;
      if(!session) return;
      return supabaseClient.rpc('get_trial_status').then(function(result){
        var data = result && result.data;
        var error = result && result.error;
        if(error || !data) return;
        var isPaying = data.subscription_status === 'active' || data.subscription_status === 'trialing';
        if(isPaying) return; // real paying subscriber — no banner, no gate, regardless of trial dates
        if(!data.trial_ends_at) return; // grandfathered pre-trial venue — never gate
        var expired = new Date(data.trial_ends_at).getTime() < Date.now();
        if(expired){
          showGate();
        } else if(!data.banner_dismissed){
          showBanner(data.trial_ends_at);
        }
      });
    }).catch(function(){ /* fail open — never block the page load itself over a network hiccup */ });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
