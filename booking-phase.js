/* ---------------------------------------------------
   Blooma — shared time-awareness for bookings (Bookings list + Booking detail pages).
   A booking marked "upcoming" is only truly upcoming until it starts; after that it's in
   progress until its duration elapses, and then overdue (nobody has checked it out, no-showed
   it or cancelled it). "stale" = overdue by a day or more.
--------------------------------------------------- */
(function(){
  function bookingEndMs(startsAt, durationMinutes){
    return Date.parse(startsAt) + (Number(durationMinutes) || 60) * 60000;
  }
  function bookingPhase(status, startsAt, durationMinutes){
    if(status !== 'upcoming') return null;
    var s = Date.parse(startsAt), e = bookingEndMs(startsAt, durationMinutes), n = Date.now();
    if(n < s) return 'future';
    if(n < e) return 'live';
    return (n - e) >= 86400000 ? 'stale' : 'overdue';
  }
  function bookingAgo(ms){
    var m = Math.floor(ms / 60000);
    if(m < 1) return 'just now';
    if(m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if(h < 24) return h + (h === 1 ? ' hour' : ' hours') + ' ago';
    var d = Math.floor(h / 24);
    if(d < 14) return d + (d === 1 ? ' day' : ' days') + ' ago';
    if(d < 60) return Math.floor(d / 7) + ' weeks ago';
    var mo = Math.floor(d / 30);
    return mo + (mo === 1 ? ' month' : ' months') + ' ago';
  }
  // Per-venue sequential number, e.g. "B-1042".
  function bookingRef(n){ return 'B-' + n; }

  window.BloomaBooking = { endMs: bookingEndMs, phase: bookingPhase, ago: bookingAgo, ref: bookingRef };
})();
