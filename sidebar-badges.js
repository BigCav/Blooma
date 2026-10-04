/* ---------------------------------------------------
   Blooma — shared sidebar badge counts (Bookings / Messages / Support).
   Included on every /venue/admin/* page via a single
   <script src="/sidebar-badges.js"> tag, same pattern as
   trial-banner.js: self-contained, reads the page's own
   `supabaseClient` global, does its own auth/data lookup
   independent of each page's boot sequence.

   Bookings badge = count of this venue's bookings with
   status = 'upcoming' (not yet happened, not cancelled/no-show).
   Messages badge = count of distinct conversations with at least
   one unread customer message (sender='customer', read_by_venue=false),
   via the existing get_venue_messages() RPC.
   Support badge = count of unread replies from the Blooma team, via
   get_support_unread_count() — a read-only counter, separate from
   get_support_messages() itself, which marks messages read as a side
   effect of actually opening the Support page.

   Previously every admin page hardcoded or half-wired these badges
   independently, so they showed different (often fake, e.g. a
   permanently-baked-in "24"/"3") numbers depending on which tab you
   were on. This is the single source of truth for all three.
--------------------------------------------------- */
(function(){
  function ensureBadge(link){
    var badge = link.querySelector('.sb-live-badge');
    if(!badge){
      badge = document.createElement('span');
      badge.className = 'sb-badge sb-live-badge';
      badge.style.display = 'none';
      link.appendChild(badge);
    }
    return badge;
  }

  function setBadge(badge, count){
    if(!badge) return;
    if(count > 0){ badge.textContent = count > 99 ? '99+' : String(count); badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  }

  async function computeCounts(salonId){
    var upcoming = 0, unread = 0, supportUnread = 0;
    try{
      const { count } = await supabaseClient.from('bookings').select('id', {count:'exact', head:true}).eq('salon_id', salonId).eq('status','upcoming');
      upcoming = count || 0;
    }catch(e){}
    try{
      const { data } = await supabaseClient.rpc('get_venue_messages');
      var seen = {};
      (data||[]).forEach(function(m){
        if(m.sender==='customer' && !m.read_by_venue){ seen[m.customer_key || m.customer_email || m.customer_phone || '?'] = true; }
      });
      unread = Object.keys(seen).length;
    }catch(e){}
    try{
      const { data } = await supabaseClient.rpc('get_support_unread_count');
      supportUnread = Number(data) || 0;
    }catch(e){}
    return { upcoming: upcoming, unread: unread, supportUnread: supportUnread };
  }

  /* ---------------------------------------------------
     Physical-terminal payment reconcile. Windcave HIT has no webhook, so a card charged on the
     terminal after staff left the checkout page would otherwise never mark the booking paid.
     Every admin page asks the server to settle any unresolved terminal charge for this venue
     (on load, then every 30s while the tab is visible). Loyalty points are awarded client-side
     elsewhere, so for bookings settled here we award them too — both calls are idempotent.
  --------------------------------------------------- */
  var RELOAD_ON_SETTLE = ['/venue/admin','/venue/admin/bookings','/venue/admin/calendar','/venue/admin/payments','/venue/admin/reports','/venue/admin/clients'];

  async function awardLoyaltyFor(salonId, bookingId){
    try{
      var b = (await supabaseClient.from('bookings').select('*').eq('id', bookingId).eq('salon_id', salonId).maybeSingle()).data;
      if(!b || b.status !== 'completed' || !b.customer_user_id) return;
      var cfg = (await supabaseClient.from('app_config').select('config').eq('salon_id', salonId).maybeSingle()).data;
      var loyalty = cfg && cfg.config && cfg.config.salon && cfg.config.salon.loyalty;
      if(!loyalty || !loyalty.enabled) return;
      var pts = Math.max(0, Math.round(Number(b.total||0) * Number(loyalty.pointsPerDollar||0)));
      if(pts > 0){
        var ins = await supabaseClient.from('loyalty_transactions').insert({salon_id:salonId,customer_user_id:b.customer_user_id,booking_id:b.id,points_change:pts,reason:'Booking completed'});
        if(!ins.error){
          var acct = (await supabaseClient.from('loyalty_accounts').select('points').eq('salon_id',salonId).eq('customer_user_id',b.customer_user_id).maybeSingle()).data;
          await supabaseClient.from('loyalty_accounts').upsert({salon_id:salonId,customer_user_id:b.customer_user_id,customer_name:b.customer_name,points:((acct&&acct.points)||0)+pts,updated_at:new Date().toISOString()},{onConflict:'salon_id,customer_user_id'});
        }
      }
      var m = await supabaseClient.rpc('check_and_award_milestone',{p_booking_id:b.id});
      if(m.data && m.data.milestone && b.customer_phone){
        var s = (await supabaseClient.from('salons').select('name').eq('id',salonId).maybeSingle()).data;
        await supabaseClient.functions.invoke('send-sms',{body:{type:'loyalty_milestone',to:b.customer_phone,data:{salonName:(s&&s.name)||'',visitCount:m.data.milestone,bonusPoints:m.data.bonus_points}}});
      }
    }catch(e){ console.warn('Loyalty award failed', e); }
  }

  var reconcileBusy = false;
  async function reconcileTerminalPayments(salonId, session){
    if(reconcileBusy) return;
    reconcileBusy = true;
    try{
      var res = await fetch('/api/windcave-hit?action=reconcile', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token}, body:'{}'});
      var out = await res.json().catch(function(){ return null; });
      if(!res.ok || !out || !out.completed || !out.completed.length) return;
      for(var i=0;i<out.completed.length;i++){ await awardLoyaltyFor(salonId, out.completed[i]); }
      if(RELOAD_ON_SETTLE.indexOf(location.pathname.replace(/\/$/,'')) !== -1) location.reload();
    }catch(e){ /* background safety net — never break the page over this */ }
    finally{ reconcileBusy = false; }
  }

  function startReconcile(salonId, session){
    reconcileTerminalPayments(salonId, session);
    setInterval(function(){
      if(document.visibilityState !== 'visible') return;
      supabaseClient.auth.getSession().then(function(r){
        var s = r && r.data && r.data.session;
        if(s) reconcileTerminalPayments(salonId, s);
      });
    }, 30000);
  }

  function init(){
    if(typeof supabaseClient === 'undefined' || !supabaseClient) return;
    supabaseClient.auth.getSession().then(function(res){
      var session = res && res.data && res.data.session;
      if(!session) return null;
      return supabaseClient.from('owner_profiles').select('salon_id').eq('user_id', session.user.id).maybeSingle().then(function(r){
        var salonId = r && r.data && r.data.salon_id;
        if(!salonId) return null;
        startReconcile(salonId, session);
        return computeCounts(salonId);
      });
    }).then(function(counts){
      if(!counts) return;
      var bookingsLink = document.querySelector('a.sb-link[href="/venue/admin/bookings"]');
      var messagesLink = document.querySelector('a.sb-link[href="/venue/admin/messages"]');
      var supportLink = document.querySelector('a.sb-link[href="/venue/admin/support"]');
      if(bookingsLink) setBadge(ensureBadge(bookingsLink), counts.upcoming);
      if(messagesLink) setBadge(ensureBadge(messagesLink), counts.unread);
      if(supportLink) setBadge(ensureBadge(supportLink), counts.supportUnread);
    }).catch(function(){ /* badges are a nice-to-have — never break the page over this */ });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
