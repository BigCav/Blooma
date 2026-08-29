/* ---------------------------------------------------
   Blooma — shared sidebar badge counts (Bookings / Messages).
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

   Previously every admin page hardcoded or half-wired these badges
   independently, so they showed different (often fake, e.g. a
   permanently-baked-in "24"/"3") numbers depending on which tab you
   were on. This is the single source of truth for both.
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
    var upcoming = 0, unread = 0;
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
    return { upcoming: upcoming, unread: unread };
  }

  function init(){
    if(typeof supabaseClient === 'undefined' || !supabaseClient) return;
    supabaseClient.auth.getSession().then(function(res){
      var session = res && res.data && res.data.session;
      if(!session) return null;
      return supabaseClient.from('owner_profiles').select('salon_id').eq('user_id', session.user.id).maybeSingle().then(function(r){
        var salonId = r && r.data && r.data.salon_id;
        if(!salonId) return null;
        return computeCounts(salonId);
      });
    }).then(function(counts){
      if(!counts) return;
      var bookingsLink = document.querySelector('a.sb-link[href="/venue/admin/bookings"]');
      var messagesLink = document.querySelector('a.sb-link[href="/venue/admin/messages"]');
      if(bookingsLink) setBadge(ensureBadge(bookingsLink), counts.upcoming);
      if(messagesLink) setBadge(ensureBadge(messagesLink), counts.unread);
    }).catch(function(){ /* badges are a nice-to-have — never break the page over this */ });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
