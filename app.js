/* Cholo Ghuri — Biker Convoy & Highway Radar (clean rebuild)
 * New humanized UI wired to the real backend: Mapbox/Leaflet live map,
 * Supabase REST + Realtime (rooms / riders / checkpoints / tours).
 * No old UI. Credentials are carried over unchanged from the
 * previous working build. */
(function () {
  "use strict";

  /* ---------- credentials (injected verbatim at build time) ---------- */
  var MAPBOX_TOKEN = "pk.eyJ1Ijoib3NoaXVyMjQyIiwiYSI6ImNtdnNkaDluazA1NnAzMHF3dnZoc3o4ODgifQ.HNHHnUivjVDOU7z99iX3lg";
  var SUPABASE_URL = "https://iblaigoargdzrpahktxt.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_iXppRFLUtwNngEd1m80zVw_lWS8HgMV";

  /* ---------- small helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function on(id, ev, fn) { var el = $(id); if (el) el.addEventListener(ev, fn); }
  function bnNum(s) {
    var bn = "০১২৩৪৫৬৭৮৯";
    return String(s).replace(/[0-9]/g, function (d) { return bn[+d]; });
  }
  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function generateUUID() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
  }
  function generateRoomCode() {
    // No I / 1 / O / 0 — those get misread (4ZDI5A looked like 4ZD15A).
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var buf = new Uint8Array(6);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(buf);
    else for (var i = 0; i < 6; i++) buf[i] = Math.floor(Math.random() * 256);
    var out = "";
    for (var j = 0; j < 6; j++) out += chars[buf[j] % 32];
    return out;
  }
  function initials(name) {
    var n = (name || "?").trim();
    if (!n) return "?";
    var parts = n.split(/\s+/);
    if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }
  function fmtDist(km) {
    if (km == null || isNaN(km)) return "—";
    return km < 1 ? bnNum(Math.round(km * 1000)) + " m" : bnNum(km.toFixed(1)) + " km";
  }
  function toast(el, msg, ms) {
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    el.style.display = "block";
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove("show"); el.style.display = "none"; }, ms || 3400);
  }

  /* ---------- Supabase ---------- */
  var sbClient = null;
  if (window.supabase && typeof window.supabase.createClient === "function") {
    try { sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); } catch (e) {}
  }
  async function supabaseRest(endpoint, method, body) {
    method = method || "GET";
    var res = await fetch(SUPABASE_URL + "/rest/v1/" + endpoint, {
      method: method,
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      var txt = "";
      try { txt = await res.text(); } catch (e) {}
      throw new Error("Supabase " + res.status + " " + txt.slice(0, 200));
    }
    var text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  /* ---------- session / state ---------- */
  var SESSION_KEY = "cholo_ghuri_session";
  var currentSession = { riderId: null, riderName: "", roomCode: "", isLeader: false, subgroup: "All Riders" };
  try {
    var saved = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    if (saved) { var p = JSON.parse(saved); if (p && p.riderId) currentSession = p; }
  } catch (e) {}
  var riderLocation = { lat: 23.8103, lng: 90.4125, speed: 0, heading: 0 };
  var hasGpsFix = false; // true only after a real GPS fix — never show the Dhaka fallback as "you"
  var followMe = false; // true only after the rider pins his own location
  // (recenter button). The map never chases the rider on its own: dragging
  // the map away to look elsewhere must stay put until he pins again.
  var hasJoinedDB = false;
  var isHandlingKick = false, isHandlingRoomClose = false;
  // A rider counts as "live" for 2 minutes without an update (was 45s).
  // On a ride, phones lose signal in tunnels, go into pockets with the tab
  // backgrounded (mobile browsers throttle timers there), or drop to 2G —
  // 45s was ejecting live members and even whole rooms over a short gap.
  var STALE_AFTER_MS = 120000;
  var kickedRiderIds = new Set();
  var allConvoyRiders = new Map();
  var policeReportsMap = new Map();
  var realtimeChannel = null;
  var lastUpsertTime = 0, lastFetchTime = 0, lastGeocodeAt = 0;
  var currentMapTheme = "night";
  try { currentMapTheme = localStorage.getItem("cholo_map_theme") || "night"; } catch (e) {}

  function saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
      localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
      localStorage.setItem("cg_room_code", currentSession.roomCode || "");
    } catch (e) {}
  }

  /* ---------- screens / bottom tabs ---------- */
  function openScreen(id) {
    document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
    var target = $(id);
    if (target) { target.classList.add("active"); target.scrollTop = 0; }
    document.querySelectorAll(".bottom-tabs [role='tab']").forEach(function (t) {
      t.setAttribute("aria-selected", t.getAttribute("data-screen") === id ? "true" : "false");
    });
    if (id === "screen-riding") {
      ensureRidingMap();
      startGps(); // GPS must run even if the user opens the Ride tab before pressing START
      if (hasGpsFix) { updateMyMarker(); if (window.map) window.map.panTo([riderLocation.lat, riderLocation.lng], { animate: true }); }
      setTimeout(function () { if (window.map) window.map.invalidateSize(); }, 120);
    }
    // Leaving the Riding map ends Tour point-picking (the banner goes away).
    if (id !== "screen-riding" && tourPickActive) {
      tourPickActive = false;
      var pb = $("pickBanner"); if (pb) pb.hidden = true;
    }
  }
  document.querySelectorAll(".bottom-tabs [role='tab']").forEach(function (tab) {
    tab.addEventListener("click", function () { openScreen(tab.getAttribute("data-screen")); });
  });

  /* ---------- Leaflet maps (Mapbox tiles) ---------- */
  function tileUrlFor(theme) {
    var styleId = theme === "day" ? "traffic-day-v2" : "traffic-night-v2";
    return "https://api.mapbox.com/styles/v1/mapbox/" + styleId +
      "/tiles/512/{z}/{x}/{y}?access_token=" + MAPBOX_TOKEN;
  }
  var rideTileLayer = null, tourTileLayer = null;
  function ensureRidingMap() {
    var el = $("map");
    if (!el || typeof L === "undefined") return null;
    if (window.map && window.map.invalidateSize) { window.map.invalidateSize(); return window.map; }
    if (el._leaflet_id) { el._leaflet_id = null; el.innerHTML = ""; }
    window.map = L.map("map", { zoomControl: false, attributionControl: true, touchZoom: true, scrollWheelZoom: true, doubleClickZoom: true, zoomSnap: 0.5 })
      .setView([riderLocation.lat, riderLocation.lng], 14);
    // In Tour pick mode, a tap on the real map picks a tour point.
    // (Ordinary taps do nothing — the map keeps its normal pan/zoom.)
    window.map.on("click", function (e) { if (tourPickActive) handleRideMapPick(e.latlng); });
    // Any manual drag unlocks the follow: the map stays where the rider
    // put it until he pins his own location again (recenter button).
    window.map.on("dragstart", function () { followMe = false; });
    rideTileLayer = L.tileLayer(tileUrlFor(currentMapTheme), {
      maxZoom: 19, tileSize: 512, zoomOffset: -1, attribution: "© Mapbox"
    }).addTo(window.map);
    setTimeout(function () { if (window.map) window.map.invalidateSize(); }, 200);
    return window.map;
  }
  var tourMap = null;
  function ensureTourMap() {
    var el = $("tourLeaflet");
    if (!el || typeof L === "undefined") return null;
    if (tourMap && tourMap.invalidateSize) { tourMap.invalidateSize(); return tourMap; }
    if (el._leaflet_id) { el._leaflet_id = null; el.innerHTML = ""; }
    tourMap = L.map("tourLeaflet", { zoomControl: false, attributionControl: false, touchZoom: true, scrollWheelZoom: true, doubleClickZoom: true, zoomSnap: 0.5 })
      .setView([23.9, 90.5], 7);
    tourTileLayer = L.tileLayer(tileUrlFor(currentMapTheme), {
      maxZoom: 19, tileSize: 512, zoomOffset: -1, attribution: ""
    }).addTo(tourMap);
    tourMap.on("click", function (e) {
      var rect = el.getBoundingClientRect();
      var pt = tourMap.latLngToContainerPoint(e.latlng);
      var x = Math.min(96, Math.max(4, pt.x / rect.width * 100));
      var y = Math.min(96, Math.max(5, pt.y / rect.height * 100));
      handleTourMapTap(x, y, e.latlng);
    });
    setTimeout(function () { if (tourMap) tourMap.invalidateSize(); }, 200);
    return tourMap;
  }
  function applyMapTheme(theme) {
    currentMapTheme = theme === "day" ? "day" : "night";
    try { localStorage.setItem("cholo_map_theme", currentMapTheme); } catch (e) {}
    if (window.map && rideTileLayer) {
      window.map.removeLayer(rideTileLayer);
      rideTileLayer = L.tileLayer(tileUrlFor(currentMapTheme), { maxZoom: 19, tileSize: 512, zoomOffset: -1, attribution: "© Mapbox" }).addTo(window.map);
    }
    if (tourMap && tourTileLayer) {
      tourMap.removeLayer(tourTileLayer);
      tourTileLayer = L.tileLayer(tileUrlFor(currentMapTheme), { maxZoom: 19, tileSize: 512, zoomOffset: -1, attribution: "" }).addTo(tourMap);
    }
  }

  /* rider + police markers on the Riding map */
  var myMarker = null, remoteMarkers = new Map(), policeMarkers = new Map(), tourRouteLine = null;
  function riderIcon(name, isMe, isLeader) {
    return L.divIcon({
      className: "",
      html: '<div class="rider-dot' + (isMe ? " me" : "") + (isLeader ? " captain" : "") + '">' +
        initials(name) + "</div>",
      iconSize: [36, 36], iconAnchor: [18, 18]
    });
  }
  function updateMyMarker() {
    if (!window.map || !hasGpsFix) return;
    if (!myMarker) {
      myMarker = L.marker([riderLocation.lat, riderLocation.lng],
        { icon: riderIcon(currentSession.riderName || "তুমি", true, currentSession.isLeader) }).addTo(window.map);
    } else {
      myMarker.setLatLng([riderLocation.lat, riderLocation.lng]);
      myMarker.setIcon(riderIcon(currentSession.riderName || "তুমি", true, currentSession.isLeader));
    }
  }
  function updateRemoteRiderMarker(r) {
    if (!window.map || r.lat == null || r.lng == null) return;
    var m = remoteMarkers.get(r.id);
    if (!m) {
      m = L.marker([r.lat, r.lng], { icon: riderIcon(r.rider_name || "Rider", false, r.is_leader) }).addTo(window.map);
      remoteMarkers.set(r.id, m);
    } else {
      m.setLatLng([r.lat, r.lng]);
      m.setIcon(riderIcon(r.rider_name || "Rider", false, r.is_leader));
    }
  }
  function removeRemoteRiderMarker(id) {
    var m = remoteMarkers.get(id);
    if (m && window.map) { try { window.map.removeLayer(m); } catch (e) {} }
    remoteMarkers.delete(id);
  }
  function addOrUpdatePoliceMarker(report) {
    policeReportsMap.set(report.id, report);
    if (!window.map || report.lat == null || report.lng == null) return;
    var m = policeMarkers.get(report.id);
    var icon = L.divIcon({
      className: "",
      html: '<div class="stop-badge" style="position:static"><i style="background:#b3372a">!</i><span>চেকপোস্ট</span></div>',
      iconSize: [110, 30], iconAnchor: [55, 15]
    });
    if (!m) { m = L.marker([report.lat, report.lng], { icon: icon }).addTo(window.map); policeMarkers.set(report.id, m); }
    else m.setLatLng([report.lat, report.lng]);
  }
  function removePoliceMarker(id) {
    policeReportsMap.delete(id);
    var m = policeMarkers.get(id);
    if (m && window.map) { try { window.map.removeLayer(m); } catch (e) {} }
    policeMarkers.delete(id);
  }

  /* ---------- GPS ---------- */
  var gpsWatchId = null;
  var gpsLowAccuracy = false; // set after a high-accuracy timeout — network location works indoors
  function startGps() {
    if (!("geolocation" in navigator) || gpsWatchId !== null) return;
    var opts = gpsLowAccuracy
      ? { enableHighAccuracy: false, maximumAge: 10000, timeout: 20000 }
      : { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 };
    gpsWatchId = navigator.geolocation.watchPosition(function (pos) {
      hasGpsFix = true;
      riderLocation.lat = pos.coords.latitude;
      riderLocation.lng = pos.coords.longitude;
      riderLocation.speed = pos.coords.speed != null ? pos.coords.speed * 3.6 : 0;
      riderLocation.heading = pos.coords.heading || 0;
      var sp = $("speedNum");
      if (sp) sp.textContent = String(Math.round(riderLocation.speed));
      // Show the live coordinates at once, so the "তুমি এখন" card never
      // stays blank while the place name is still being looked up.
      var ws0 = $("whereSub");
      if (ws0) ws0.textContent = riderLocation.lat.toFixed(4) + ", " + riderLocation.lng.toFixed(4);
      updateMyMarker();
      if (window.map && currentSession.riderId && followMe) {
        // Follow only while the rider pinned his own location. Without the
        // pin, a GPS fix must never yank the map back after he dragged it
        // away to look at another place.
        var c = window.map.getCenter();
        if (haversineKm(c.lat, c.lng, riderLocation.lat, riderLocation.lng) > 0.6) {
          window.map.panTo([riderLocation.lat, riderLocation.lng], { animate: true });
        }
      }
      maybeGeocode();
      evaluatePoliceProximity();
    }, function (err) {
      console.debug("[GPS]", err && err.code, err && err.message);
      var code = err && err.code;
      if (code === 1) {
        // Permission actually denied — only then say so.
        var w = $("whereNow"); if (w) w.textContent = "Location পাওয়া যাচ্ছে না";
        var ws = $("whereSub"); if (ws) ws.textContent = "ফোনের Location অনুমতি দাও, তারপর আবার চেষ্টা করো";
        toast($("rideToast"), "Location অনুমতি দরকার — ব্রাউজারের ঠিকানা বারের তালা চিহ্নে চেপে Location Allow করো");
      } else if (code === 3 && !gpsLowAccuracy) {
        // High-accuracy GPS timed out (common indoors) — fall back to
        // network location instead of wrongly reporting "not found".
        gpsLowAccuracy = true;
        try { navigator.geolocation.clearWatch(gpsWatchId); } catch (e) {}
        gpsWatchId = null;
        var w2 = $("whereNow"); if (w2) w2.textContent = "অবস্থান খোঁজা হচ্ছে…";
        startGps();
      } else {
        // Still searching (no fix yet) — keep waiting, don't claim failure.
        var w3 = $("whereNow"); if (w3) w3.textContent = "অবস্থান খোঁজা হচ্ছে…";
        var ws3 = $("whereSub"); if (ws3) ws3.textContent = "GPS সিগন্যাল খোঁজা হচ্ছে — খোলা জায়গায় গেলে তাড়াতাড়ি পাবে";
      }
    }, opts);
  }
  async function maybeGeocode() {
    var now = Date.now();
    if (now - lastGeocodeAt < 30000) return;
    lastGeocodeAt = now;
    try {
      var res = await fetch("https://nominatim.openstreetmap.org/reverse?format=json&zoom=14&lat=" +
        riderLocation.lat + "&lon=" + riderLocation.lng, { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error("geocode " + res.status);
      var j = await res.json();
      var name = "";
      if (j && j.address) {
        var a = j.address;
        // Wide fallback chain: highway/rural addresses often have no
        // road/suburb/city, only a village, quarter or county — the old
        // narrow chain returned "" there and the name never appeared.
        name = a.road || a.neighbourhood || a.quarter || a.suburb || a.village ||
          a.hamlet || a.city_district || a.town || a.city || a.county ||
          a.state_district || a.state || "";
      }
      if (!name && j && j.display_name) name = String(j.display_name).split(",")[0];
      if (!name && j && j.name) name = j.name;
      if (name) {
        var w = $("whereNow"); if (w) w.textContent = name;
        var ws = $("whereSub");
        if (ws) ws.textContent = riderLocation.lat.toFixed(4) + ", " + riderLocation.lng.toFixed(4);
        var rl = $("reportLocText");
        if (rl) rl.textContent = name + " — এই জায়গাটাই গ্রুপ দেখবে";
      } else {
        // No name found — retry sooner instead of waiting out the 30s throttle.
        lastGeocodeAt = now - 20000;
      }
    } catch (e) {
      // Lookup failed — retry sooner instead of waiting out the 30s throttle.
      lastGeocodeAt = Date.now() - 20000;
    }
  }
  // Pin my location: the ONLY thing that locks the map to the rider.
  // From here on, GPS fixes keep the map following until he drags it away.
  on("recenterBtn", "click", function () {
    ensureRidingMap();
    followMe = true;
    if (window.map) window.map.setView([riderLocation.lat, riderLocation.lng], 15);
    updateMyMarker();
    toast($("rideToast"), "ম্যাপ তোমার অবস্থানে ফিরল");
  });
  on("compassBtn", "click", function () {
    applyMapTheme(currentMapTheme === "night" ? "day" : "night");
    toast($("rideToast"), currentMapTheme === "day" ? "দিনের ম্যাপ" : "রাতের ম্যাপ");
  });

  /* ---------- Join / onboarding ---------- */
  var captainWanted = false;
  on("captainToggle", "click", function () {
    captainWanted = !captainWanted;
    $("captainToggle").setAttribute("aria-pressed", captainWanted ? "true" : "false");
  });
  on("genCodeBtn", "click", function () {
    var rc = $("roomCode");
    if (rc) { rc.value = generateRoomCode(); rc.focus(); }
  });
  function showJoinError(msg) {
    var e = $("joinError");
    if (e) { e.textContent = msg; e.hidden = false; }
    var n = $("riderName");
    if (n) { n.focus(); n.style.borderColor = "#b3372a"; }
  }
  async function submitOnboarding() {
    var nameInput = $("riderName"), codeInput = $("roomCode");
    var name = nameInput ? nameInput.value.trim() : "";
    if (!name) {
      // Name is required — never auto-generate one.
      showJoinError("তোমার নাম লিখো — নাম ছাড়া Ride শুরু হবে না।");
      return;
    }
    if (nameInput) nameInput.style.borderColor = "";
    var err = $("joinError"); if (err) err.hidden = true;
    var code = codeInput ? codeInput.value.trim().toUpperCase() : "";
    if (!code) { code = generateRoomCode(); if (codeInput) codeInput.value = code; }

    // A fresh join attempt clears any earlier kick/room-close lock, so a
    // rider who was kicked (or wrongly ejected) can join again by pressing
    // START — the lock used to stay set forever and blocked every rejoin.
    isHandlingKick = false; isHandlingRoomClose = false;
    var riderId = currentSession.riderId;
    var isDifferent = !riderId || !currentSession.riderName ||
      currentSession.riderName.trim().toLowerCase() !== name.toLowerCase() ||
      (currentSession.roomCode || "").trim().toUpperCase() !== code;
    if (isDifferent) {
      // Remove the old row first, so the same person never shows twice
      // in the group list (old row + new row) after rejoining.
      if (riderId) supabaseRest("riders?id=eq." + encodeURIComponent(riderId), "DELETE").catch(function () {});
      riderId = generateUUID();
    }

    var wantedLeader = captainWanted;
    var finalIsLeader = wantedLeader;
    try {
      var existing = await supabaseRest(
        "riders?room_code=eq." + encodeURIComponent(code) + "&select=id,rider_name,is_leader,updated_at", "GET");
      var now = Date.now(), stale = [], live = [];
      if (Array.isArray(existing)) existing.forEach(function (r) {
        if (!r || !r.id) return;
        var t = r.updated_at ? new Date(r.updated_at).getTime() : 0;
        if (isNaN(t) || now - t > STALE_AFTER_MS) stale.push(r); else live.push(r);
      });
      stale.forEach(function (s) {
        supabaseRest("riders?id=eq." + encodeURIComponent(s.id), "DELETE").catch(function () {});
      });
      if (live.length === 0) purgeEntireRoomData(code, false);
      var others = live.filter(function (r) { return r.id !== riderId; });
      var existingLeader = others.find(function (r) { return r.is_leader === true; });
      if (existingLeader) {
        finalIsLeader = false;
        if (wantedLeader) toast($("rideToast"), "এই রুমে Captain (" + (existingLeader.rider_name || "Captain") + ") আছে — Rider হিসেবে যোগ দিলে");
      } else if (others.length === 0) {
        finalIsLeader = true; // first live rider in the room becomes Captain
      }
    } catch (e) { console.debug("[leader check]", e); }

    currentSession = { riderId: riderId, riderName: name, roomCode: code, isLeader: finalIsLeader, subgroup: "All Riders" };
    captainWanted = finalIsLeader;
    var cap = $("captainToggle"); if (cap) cap.setAttribute("aria-pressed", finalIsLeader ? "true" : "false");
    saveSession();
    var rc = $("roomChip"); if (rc) rc.textContent = code + " · সংযুক্ত";
    await upsertLiveRiderData(true);
    subscribeRealtime();
    startGps();
    startSyncLoops();
    openScreen("screen-riding");
    toast($("rideToast"), "Ride শুরু — " + code + " রুমে যুক্ত হলে" + (finalIsLeader ? " (Captain)" : ""));
  }
  on("startRideBtn", "click", submitOnboarding);

  function purgeEntireRoomData(cleanRoom, useKeepalive) {
    var enc = encodeURIComponent(cleanRoom);
    supabaseRest("tour_plans?room_code=eq." + enc, "DELETE").catch(function () {});
    supabaseRest("police_reports?room_code=eq." + enc, "DELETE").catch(function () {});
    supabaseRest("voice_messages?room_code=eq." + enc, "DELETE").catch(function () {});
  }
  async function leaveRoom() {
    if (!currentSession.riderId) return;
    var wasLeader = currentSession.isLeader, code = currentSession.roomCode;
    try {
      await supabaseRest("riders?id=eq." + encodeURIComponent(currentSession.riderId), "DELETE");
    } catch (e) {}
    if (wasLeader && code) purgeEntireRoomData(code, false);
    hasJoinedDB = false;
    if (realtimeChannel) { try { sbClient.removeChannel(realtimeChannel); } catch (e) {} realtimeChannel = null; }
    currentSession = { riderId: null, riderName: "", roomCode: "", isLeader: false, subgroup: "All Riders" };
    try { sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY); } catch (e) {}
    openScreen("screen-join");
  }
  window.addEventListener("beforeunload", function () {
    if (currentSession.riderId) {
      try {
        fetch(SUPABASE_URL + "/rest/v1/riders?id=eq." + encodeURIComponent(currentSession.riderId), {
          method: "DELETE", keepalive: true,
          headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + SUPABASE_ANON_KEY }
        });
      } catch (e) {}
    }
  });

  /* ---------- riders sync ---------- */
  async function upsertLiveRiderData(force) {
    if (!currentSession.roomCode || !currentSession.riderId) return;
    if (isHandlingKick) return;
    var now = Date.now();
    if (!force && now - lastUpsertTime < 1200) return;
    lastUpsertTime = now;
    try {
      await supabaseRest("riders?on_conflict=id", "POST", {
        id: currentSession.riderId,
        room_code: currentSession.roomCode.trim().toUpperCase(),
        rider_name: currentSession.riderName || "Rider",
        is_leader: Boolean(currentSession.isLeader),
        lat: riderLocation.lat, lng: riderLocation.lng,
        speed: Math.round((riderLocation.speed || 0) * 10) / 10,
        updated_at: new Date().toISOString()
      });
      hasJoinedDB = true;
    } catch (e) { console.debug("[riders upsert]", e); }
  }
  async function fetchExistingRiders() {
    if (!currentSession.roomCode || !currentSession.riderId) return;
    var now = Date.now();
    if (now - lastFetchTime < 4000) return;
    lastFetchTime = now;
    try {
      var riders = await supabaseRest(
        "riders?room_code=eq." + encodeURIComponent(currentSession.roomCode.trim().toUpperCase()) +
        "&select=*&order=updated_at.desc&limit=30", "GET");
      if (!Array.isArray(riders)) return;
      var live = [], stale = [];
      riders.forEach(function (r) {
        if (!r || !r.id) return;
        if (r.id === currentSession.riderId) { live.push(r); return; }
        if ((r.room_code || "").indexOf("KICKED_") === 0 || (r.room_code || "").indexOf("CLOSED_") === 0) return;
        if (kickedRiderIds.has(r.id)) return;
        var t = r.updated_at ? new Date(r.updated_at).getTime() : 0;
        if (isNaN(t) || now - t > STALE_AFTER_MS) stale.push(r); else live.push(r);
      });
      stale.forEach(function (s) {
        supabaseRest("riders?id=eq." + encodeURIComponent(s.id), "DELETE").catch(function () {});
        allConvoyRiders.delete(s.id); removeRemoteRiderMarker(s.id);
      });
      if (hasJoinedDB && !currentSession.isLeader) {
        var hasLiveLeader = live.some(function (r) { return r.is_leader === true; });
        if (live.length === 0 || !hasLiveLeader) { handleRoomClosedByLeader(); return; }
      }
      var activeIds = new Set();
      live.forEach(function (r) {
        if (r.id === currentSession.riderId) return;
        if (r.lat != null && r.lng != null) {
          activeIds.add(r.id); allConvoyRiders.set(r.id, r); updateRemoteRiderMarker(r);
        }
      });
      allConvoyRiders.forEach(function (v, k) {
        if (k !== currentSession.riderId && !activeIds.has(k)) { allConvoyRiders.delete(k); removeRemoteRiderMarker(k); }
      });
      renderGroupRidersList(live);
    } catch (e) { console.debug("[riders fetch]", e); }
  }
  var syncTimer = null;
  function startSyncLoops() {
    if (syncTimer) return;
    syncTimer = setInterval(async function () {
      if (isHandlingKick || isHandlingRoomClose) return;
      await checkIfCurrentRiderKicked();
      await upsertLiveRiderData(false);
      await fetchExistingRiders();
    }, 5000);
  }
  async function checkIfCurrentRiderKicked() {
    if (!hasJoinedDB || !currentSession.riderId) return;
    try {
      var rows = await supabaseRest("riders?id=eq." + encodeURIComponent(currentSession.riderId) + "&select=id,room_code", "GET");
      if (Array.isArray(rows) && rows.length === 0) {
        // My row is gone but there is no KICKED_ marker — that is a lost
        // row (stale cleanup by another member, bad signal), NOT a kick.
        // Quietly put my row back instead of throwing me out of the room.
        upsertLiveRiderData(true);
        return;
      }
      if (rows && rows[0] && (rows[0].room_code || "").indexOf("KICKED_") === 0) handleKickedFromConvoy();
    } catch (e) {}
  }
  function handleKickedFromConvoy() {
    if (isHandlingKick) return;
    isHandlingKick = true;
    hasJoinedDB = false;
    // Clean up my own KICKED_ marker row so it does not linger in the DB.
    if (currentSession.riderId) {
      supabaseRest("riders?id=eq." + encodeURIComponent(currentSession.riderId), "DELETE").catch(function () {});
    }
    toast($("rideToast"), "Captain তোমাকে গ্রুপ থেকে সরিয়ে দিয়েছে");
    openScreen("screen-join");
  }
  function handleRoomClosedByLeader() {
    if (isHandlingRoomClose) return;
    isHandlingRoomClose = true;
    hasJoinedDB = false;
    toast($("rideToast"), "Captain রুম বন্ধ করেছে বা চলে গেছে");
    openScreen("screen-join");
    setTimeout(function () { isHandlingRoomClose = false; }, 5000);
  }

  /* ---------- Group list (one vertical column) ---------- */
  function renderGroupRidersList(live) {
    var list = $("riderList");
    if (!list) return;
    var me = {
      id: currentSession.riderId, rider_name: currentSession.riderName || "তুমি",
      is_leader: currentSession.isLeader, lat: riderLocation.lat, lng: riderLocation.lng,
      speed: riderLocation.speed || 0
    };
    var rows = [me].concat(live.filter(function (r) { return r.id !== currentSession.riderId; }));
    var title = $("groupTitle");
    if (title) title.textContent = "তোমার গ্রুপ · " + bnNum(rows.length) + " জন";
    var sub = $("groupSub");
    if (sub) sub.textContent = "রুম " + (currentSession.roomCode || "—") + " · সবাই " + fmtDist(maxGapKm(rows)) + "-এর মধ্যে আছে";
    list.innerHTML = "";
    rows.forEach(function (r) {
      var li = document.createElement("li");
      var av = document.createElement("div");
      av.className = "avatar" + (r.is_leader ? " leader" : "");
      av.textContent = initials(r.rider_name);
      var who = document.createElement("div");
      who.className = "who";
      var b = document.createElement("b");
      b.textContent = r.id === currentSession.riderId ? "তুমি" : (r.rider_name || "Rider");
      if (r.is_leader) {
        var tag = document.createElement("span");
        tag.className = "tag-leader"; tag.textContent = "Captain";
        b.appendChild(tag);
      }
      var sp = document.createElement("span");
      sp.textContent = "গতি " + bnNum(Math.round(r.speed || 0)) + " km/h" +
        (r.id === currentSession.riderId ? "" : " · " + fmtDist(distFromMe(r)) + " দূরে");
      who.appendChild(b); who.appendChild(sp);
      var dist = document.createElement("div");
      dist.className = "dist";
      dist.textContent = r.id === currentSession.riderId ? "—" : fmtDist(distFromMe(r));
      var small = document.createElement("small");
      small.textContent = r.is_leader ? "লিড করছে" : (r.id === currentSession.riderId ? "নিজের অবস্থান" : "পেছনে/সামনে");
      dist.appendChild(small);
      li.appendChild(av); li.appendChild(who); li.appendChild(dist);
      if (currentSession.isLeader && r.id !== currentSession.riderId) {
        var kick = document.createElement("button");
        kick.type = "button"; kick.className = "kick-btn"; kick.textContent = "সরাও";
        kick.addEventListener("click", function () { kickRiderFromConvoy(r.id, r.rider_name); });
        li.appendChild(kick);
      }
      li.addEventListener("click", function () {
        if (r.lat != null && r.lng != null) {
          openScreen("screen-riding");
          if (window.map) window.map.setView([r.lat, r.lng], 15);
        }
      });
      list.appendChild(li);
    });
  }
  function distFromMe(r) {
    if (r.lat == null || r.lng == null) return 0;
    return haversineKm(riderLocation.lat, riderLocation.lng, r.lat, r.lng);
  }
  function maxGapKm(rows) {
    var m = 0;
    rows.forEach(function (r) { m = Math.max(m, distFromMe(r)); });
    return m;
  }
  async function kickRiderFromConvoy(targetId, targetName) {
    if (!currentSession.isLeader) return;
    // Leader/kick is verified against the DB, never trusted from local state alone.
    try {
      var rows = await supabaseRest("riders?id=eq." + encodeURIComponent(currentSession.riderId) + "&select=is_leader", "GET");
      if (!rows || !rows[0] || rows[0].is_leader !== true) {
        toast($("rideToast"), "শুধু Captain-ই রাইডার সরাতে পারে");
        return;
      }
    } catch (e) { toast($("rideToast"), "যাচাই করা যায়নি — আবার চেষ্টা করো"); return; }
    try {
      // Mark the row KICKED_ instead of deleting it: a deleted row looks
      // exactly like a row lost to bad signal, so the member's phone could
      // not tell a real kick from a network gap. The KICKED_ marker is the
      // reliable signal (see checkIfCurrentRiderKicked).
      await supabaseRest("riders?id=eq." + encodeURIComponent(targetId), "PATCH", {
        room_code: "KICKED_" + (currentSession.roomCode || "").trim().toUpperCase()
      });
      kickedRiderIds.add(targetId);
      allConvoyRiders.delete(targetId); removeRemoteRiderMarker(targetId);
      if (realtimeChannel) realtimeChannel.send({ type: "broadcast", event: "kick", payload: { riderId: targetId } });
      toast($("rideToast"), (targetName || "রাইডার") + "-কে গ্রুপ থেকে সরানো হয়েছে");
      fetchExistingRiders();
    } catch (e) { toast($("rideToast"), "সরানো যায়নি — আবার চেষ্টা করো"); }
  }

  /* ---------- police reports ---------- */
  var POLICE_REPORT_COOLDOWN_MS = 60000;
  var POLICE_VOTES_KEY = "cholo_ghuri_police_votes";
  var lastPoliceReportAt = 0;
  try { lastPoliceReportAt = parseInt(localStorage.getItem("cholo_ghuri_last_police_report_at") || "0", 10) || 0; } catch (e) {}
  var nearestReportId = null;

  function isValidPolicePhotoData(value) {
    return typeof value === "string" && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(value) &&
      value.length > 100 && value.length < 1500000;
  }
  var pendingPolicePhotoData = null;
  function handlePolicePhotoSelected(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || "")) { toast($("reportToast"), "শুধু ছবির ফাইল নাও"); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 800, w = img.width, h = img.height;
        if (w > max || h > max) { var s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        var dataUrl = cv.toDataURL("image/jpeg", 0.8);
        if (!isValidPolicePhotoData(dataUrl)) { toast($("reportToast"), "ছবিটা ব্যবহার করা যায়নি"); return; }
        pendingPolicePhotoData = dataUrl;
        setReportPhoto(dataUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }
  function setReportPhoto(src) {
    var img = $("photoPreviewImg"), prev = $("photoPreview"), drop = $("photoDropBtn");
    if (img) img.src = src;
    if (prev) prev.classList.add("show");
    if (drop) drop.style.display = "none";
    if (!$("screen-report").classList.contains("active")) openScreen("screen-report");
  }
  on("photoDropBtn", "click", function () { var f = $("reportPhoto"); if (f) f.click(); });
  on("retakeBtn", "click", function () { var f = $("reportPhoto"); if (f) f.click(); });
  on("reportPhoto", "change", function () {
    var f = $("reportPhoto");
    if (f && f.files && f.files[0]) handlePolicePhotoSelected(f.files[0]);
  });
  on("photoReportBtn", "click", function () { var f = $("reportPhoto"); if (f) f.click(); });

  var reportType = "পুলিশ চেকপোস্ট";
  document.querySelectorAll("#reportTypes .stop-chip").forEach(function (c) {
    c.addEventListener("click", function () {
      document.querySelectorAll("#reportTypes .stop-chip").forEach(function (x) { x.setAttribute("aria-pressed", "false"); });
      c.setAttribute("aria-pressed", "true");
      reportType = c.getAttribute("data-type");
    });
  });
  async function reportPoliceCheckpost() {
    var nowMs = Date.now();
    var waitMs = POLICE_REPORT_COOLDOWN_MS - (nowMs - lastPoliceReportAt);
    if (waitMs > 0) {
      toast($("rideToast"), "আরেকটা রিপোর্টের আগে " + bnNum(Math.ceil(waitMs / 1000)) + " সেকেন্ড অপেক্ষা করো");
      return;
    }
    lastPoliceReportAt = nowMs;
    try { localStorage.setItem("cholo_ghuri_last_police_report_at", String(nowMs)); } catch (e) {}
    var note = "";
    var noteEl = $("reportNote"); if (noteEl) note = noteEl.value.trim();
    var photoData = pendingPolicePhotoData && isValidPolicePhotoData(pendingPolicePhotoData) ? pendingPolicePhotoData : null;
    var newReport = {
      id: generateUUID(), lat: riderLocation.lat, lng: riderLocation.lng,
      reported_by: currentSession.riderName || "Rider",
      report_type: reportType, note: note, photo_data: photoData,
      true_votes: 1, false_votes: 0, created_at: new Date().toISOString()
    };
    addOrUpdatePoliceMarker(newReport);
    toast($("rideToast"), "চেকপোস্ট রিপোর্ট গ্রুপে পাঠানো হয়েছে" + (photoData ? " (ছবিসহ)" : ""));
    if (realtimeChannel) {
      try { realtimeChannel.send({ type: "broadcast", event: "police_alert", payload: newReport }); } catch (e) {}
    }
    if (sbClient) {
      try {
        var payload = {
          lat: newReport.lat, lng: newReport.lng, reported_by: newReport.reported_by,
          true_votes: 1, false_votes: 0, created_at: newReport.created_at, photo_data: photoData
        };
        var res = await sbClient.from("police_reports").insert(payload).select().single();
        if (res.error && (res.error.code === "PGRST204" || (res.error.message && res.error.message.indexOf("photo_data") !== -1) || res.error.status === 400)) {
          delete payload.photo_data;
          res = await sbClient.from("police_reports").insert(payload).select().single();
        }
        if (!res.error && res.data && res.data.id) {
          policeReportsMap.delete(newReport.id);
          newReport.id = res.data.id;
          policeReportsMap.set(newReport.id, newReport);
        }
      } catch (e) { console.debug("[police_reports insert]", e); }
    }
    pendingPolicePhotoData = null;
    var prev = $("photoPreview"); if (prev) prev.classList.remove("show");
    var drop = $("photoDropBtn"); if (drop) drop.style.display = "";
    if (noteEl) noteEl.value = "";
    // add to the report list on the report screen (text only — no raw HTML)
    var list = $("reportList");
    if (list) {
      var item = document.createElement("div"); item.className = "report-item";
      var img = document.createElement("img");
      img.src = photoData || ""; img.alt = "";
      if (!photoData) img.style.display = "none";
      var txt = document.createElement("div"); txt.className = "ri-txt";
      var b = document.createElement("b"); b.textContent = reportType;
      var s = document.createElement("span");
      s.textContent = (note ? note + " · " : "") + "এখনই · তুমি পাঠিয়েছ";
      txt.appendChild(b); txt.appendChild(s);
      var sent = document.createElement("span"); sent.className = "ri-sent"; sent.textContent = "পাঠানো হয়েছে";
      item.appendChild(img); item.appendChild(txt); item.appendChild(sent);
      list.insertBefore(item, list.firstChild);
      var empty = $("reportEmpty"); if (empty) empty.style.display = "none";
    }
    toast($("reportToast"), "রিপোর্ট গ্রুপে পাঠানো হয়েছে — সবাই ছবিসহ দেখতে পাবে");
    evaluatePoliceProximity();
  }
  on("submitReportBtn", "click", reportPoliceCheckpost);
  on("reportBtn", "click", function () { reportPoliceCheckpost(); });

  async function fetchPoliceReports() {
    try {
      var reports = await supabaseRest("police_reports?select=*", "GET");
      if (Array.isArray(reports)) reports.forEach(function (r) { if (r && r.id) addOrUpdatePoliceMarker(r); });
    } catch (e) { console.debug("[police fetch]", e); }
  }
  function evaluatePoliceProximity() {
    var card = $("policeCard");
    if (!card) return;
    var best = null, bestD = 1e9;
    policeReportsMap.forEach(function (r) {
      if (r.lat == null || r.lng == null) return;
      var d = haversineKm(riderLocation.lat, riderLocation.lng, r.lat, r.lng);
      if (d < bestD) { bestD = d; best = r; }
    });
    if (best && bestD < 2) {
      nearestReportId = best.id;
      card.style.display = "";
      var b = card.querySelector("b");
      if (b) b.textContent = "সামনে পুলিশ চেকপোস্ট · " + fmtDist(bestD);
      var p = card.querySelector("p");
      if (p) p.textContent = (best.reported_by || "কেউ") + " জানিয়েছে — গতি সীমার মধ্যে থাকো।";
    } else {
      nearestReportId = null;
      card.style.display = "none";
    }
  }
  /* votes: one per rider, stored locally + synced to the DB */
  function loadPoliceVotes() {
    try { var v = JSON.parse(localStorage.getItem(POLICE_VOTES_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
  }
  function savePoliceVotes(v) {
    try {
      var keys = Object.keys(v), trimmed = {};
      keys.slice(-200).forEach(function (k) { trimmed[k] = v[k]; });
      localStorage.setItem(POLICE_VOTES_KEY, JSON.stringify(trimmed));
    } catch (e) {}
  }
  function hasVotedForReport(id) {
    if (!id) return null;
    var e = loadPoliceVotes()[id];
    if (!e) return null;
    if (currentSession && e.voter && e.voter !== currentSession.riderId) return null;
    return e.vote || null;
  }
  async function submitPoliceVote(reportId, isTrue) {
    var report = policeReportsMap.get(reportId);
    if (!report) return;
    if (hasVotedForReport(reportId)) {
      toast($("rideToast"), "এই চেকপোস্টে তুমি আগেই ভোট দিয়েছ");
      return;
    }
    var votes = loadPoliceVotes();
    votes[reportId] = { voter: currentSession.riderId, vote: isTrue ? "true" : "false", at: Date.now() };
    savePoliceVotes(votes);
    if (isTrue) report.true_votes = (report.true_votes || 1) + 1;
    else report.false_votes = (report.false_votes || 0) + 1;
    if (sbClient && report.id) {
      try {
        await sbClient.from("police_reports")
          .update({ true_votes: report.true_votes, false_votes: report.false_votes })
          .eq("id", report.id);
      } catch (e) {}
    }
    var tv = report.true_votes || 0, fv = report.false_votes || 0, tot = tv + fv;
    if (fv >= 10 && tot > 0 && fv / tot >= 0.8) {
      if (sbClient) { try { await sbClient.from("police_reports").delete().eq("id", report.id); } catch (e) {} }
      removePoliceMarker(report.id);
      toast($("rideToast"), "ভুয়া রিপোর্ট সরিয়ে দেওয়া হয়েছে");
    } else {
      toast($("rideToast"), isTrue ? "চেকপোস্ট আছে বলে ভোট দিলে" : "চেকপোস্ট নেই বলে ভোট দিলে");
    }
    evaluatePoliceProximity();
  }
  on("seenBtn", "click", function () {
    if (nearestReportId) submitPoliceVote(nearestReportId, true);
    else { var c = $("policeCard"); if (c) c.style.display = "none"; toast($("rideToast"), "ঠিক আছে — গ্রুপকে জানানো হয়েছে"); }
  });
  on("goneBtn", "click", function () {
    if (nearestReportId) submitPoliceVote(nearestReportId, false);
    else { var c = $("policeCard"); if (c) c.style.display = "none"; toast($("rideToast"), "ধন্যবাদ — চেকপোস্টটা সরিয়ে দেওয়া হয়েছে"); }
  });

  /* ---------- push-to-talk (walkie-talkie) ---------- */
  var pttRecorder = null, pttChunks = [], lastVoiceAt = 0;
  var PTT_COOLDOWN_MS = 10000;
  function pttStart() {
    var now = Date.now();
    if (now - lastVoiceAt < PTT_COOLDOWN_MS) {
      toast($("rideToast"), "আরেকটা ভয়েস পাঠাতে " + bnNum(Math.ceil((PTT_COOLDOWN_MS - (now - lastVoiceAt)) / 1000)) + " সেকেন্ড অপেক্ষা করো");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast($("rideToast"), "এই ডিভাইসে মাইক পাওয়া যায়নি");
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      pttChunks = [];
      pttRecorder = new MediaRecorder(stream);
      pttRecorder.ondataavailable = function (e) { if (e.data && e.data.size) pttChunks.push(e.data); };
      pttRecorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        lastVoiceAt = Date.now();
        var blob = new Blob(pttChunks, { type: pttRecorder.mimeType || "audio/webm" });
        var reader = new FileReader();
        reader.onload = function () { sendVoiceMessage(reader.result); };
        reader.readAsDataURL(blob);
      };
      pttRecorder.start();
      toast($("rideToast"), "বলো — গ্রুপ শুনছে… আবার চাপ দিলে থামবে");
    }).catch(function () { toast($("rideToast"), "মাইকের অনুমতি দাও"); });
  }
  function pttStop() {
    if (pttRecorder && pttRecorder.state !== "inactive") pttRecorder.stop();
    else toast($("rideToast"), "Walkie-talkie: চেপে ধরে কথা বলো");
  }
  on("pttBtn", "click", function () {
    if (pttRecorder && pttRecorder.state === "recording") pttStop(); else pttStart();
  });
  async function sendVoiceMessage(audioData) {
    if (!currentSession.roomCode) return;
    var payload = {
      room_code: currentSession.roomCode.trim().toUpperCase(),
      rider_id: currentSession.riderId,
      rider_name: currentSession.riderName || "Rider",
      audio_data: audioData, created_at: new Date().toISOString()
    };
    if (realtimeChannel) {
      try { realtimeChannel.send({ type: "broadcast", event: "voice_message", payload: payload }); } catch (e) {}
    }
    try { await supabaseRest("voice_messages", "POST", payload); } catch (e) {}
    toast($("rideToast"), "ভয়েস গ্রুপে পাঠানো হয়েছে");
  }
  function playVoiceMessage(payload) {
    if (!payload || !payload.audio_data) return;
    try {
      var audio = new Audio(payload.audio_data);
      audio.play().catch(function () {});
      toast($("rideToast"), (payload.rider_name || "রাইডার") + " ভয়েস পাঠিয়েছে");
    } catch (e) {}
  }

  /* ---------- Tour (demo logic, real map) ---------- */
  var DIST = {
    "Dhaka|Chattogram": 248, "Dhaka|Cox's Bazar": 392, "Dhaka|Sylhet": 237, "Dhaka|Khulna": 212,
    "Dhaka|Bandarban": 325, "Dhaka|Sajek": 378, "Dhaka|Mawa": 41, "Dhaka|Cumilla": 97,
    "Mawa|Chattogram": 230, "Mawa|Cumilla": 88, "Mawa|Khulna": 145, "Mawa|Sylhet": 260,
    "Mawa|Cox's Bazar": 375, "Mawa|Bandarban": 310, "Mawa|Sajek": 360,
    "Cumilla|Chattogram": 151, "Cumilla|Cox's Bazar": 295, "Cumilla|Sylhet": 195,
    "Cumilla|Khulna": 285, "Cumilla|Bandarban": 230, "Cumilla|Sajek": 285,
    "Chattogram|Cox's Bazar": 144, "Chattogram|Bandarban": 77, "Chattogram|Sajek": 165,
    "Chattogram|Khulna": 430, "Chattogram|Sylhet": 390,
    "Khulna|Cox's Bazar": 540, "Khulna|Bandarban": 480, "Khulna|Sajek": 560, "Khulna|Sylhet": 430,
    "Sylhet|Cox's Bazar": 520, "Sylhet|Bandarban": 460, "Sylhet|Sajek": 340,
    "Cox's Bazar|Bandarban": 120, "Cox's Bazar|Sajek": 280, "Bandarban|Sajek": 210
  };
  var PLACES = ["Dhaka", "Mawa", "Bhanga", "Khulna", "Narsingdi", "Cumilla", "Feni", "Chattogram", "Cox's Bazar", "Bandarban", "Sajek", "Sylhet"];
  var PLACE_COORDS = {
    "Dhaka": { x: 42, y: 48 }, "Mawa": { x: 36, y: 59 }, "Bhanga": { x: 27, y: 63 }, "Khulna": { x: 16, y: 74 },
    "Narsingdi": { x: 53, y: 41 }, "Cumilla": { x: 63, y: 56 }, "Feni": { x: 71, y: 63 }, "Chattogram": { x: 79, y: 75 },
    "Cox's Bazar": { x: 85, y: 89 }, "Bandarban": { x: 90, y: 79 }, "Sajek": { x: 93, y: 58 }, "Sylhet": { x: 73, y: 27 }
  };
  var PLACE_LATLNG = {
    "Dhaka": [23.8103, 90.4125], "Mawa": [23.45, 90.25], "Bhanga": [23.39, 90.0], "Khulna": [22.8456, 89.5403],
    "Narsingdi": [23.9226, 90.7175], "Cumilla": [23.4683, 91.1788], "Feni": [23.0159, 91.3976],
    "Chattogram": [22.3569, 91.7832], "Cox's Bazar": [21.4272, 92.0058], "Bandarban": [22.1953, 92.2184],
    "Sajek": [23.3813, 92.2934], "Sylhet": [24.8949, 91.8687]
  };
  // All 64 districts of Bangladesh (name + district HQ lat/lng), so the
  // Tour from/to lists are real choices, not a handful of demo places.
  var DISTRICTS = [
    ["Bagerhat", 22.6516, 89.7855], ["Bandarban", 22.1953, 92.2184], ["Barguna", 22.0953, 90.1121],
    ["Barishal", 22.7010, 90.3535], ["Bhola", 22.6850, 90.6480], ["Bogura", 24.8510, 89.3711],
    ["Brahmanbaria", 23.9608, 91.1115], ["Chandpur", 23.2513, 90.8518], ["Chapai Nawabganj", 24.5965, 88.2791],
    ["Chattogram", 22.3569, 91.7832], ["Chuadanga", 23.6400, 88.8418], ["Cox's Bazar", 21.4272, 92.0058],
    ["Cumilla", 23.4683, 91.1788], ["Dhaka", 23.8103, 90.4125], ["Dinajpur", 25.6277, 88.6332],
    ["Faridpur", 23.6071, 89.8429], ["Feni", 23.0159, 91.3976], ["Gaibandha", 25.3297, 89.5429],
    ["Gazipur", 24.0023, 90.4264], ["Gopalganj", 23.0053, 89.8266], ["Habiganj", 24.3747, 91.4157],
    ["Jamalpur", 24.9375, 89.9371], ["Jashore", 23.1664, 89.2081], ["Jhalokati", 22.5721, 90.1860],
    ["Jhenaidah", 23.5450, 89.1726], ["Joypurhat", 25.0947, 89.0297], ["Khagrachhari", 23.1193, 91.9886],
    ["Khulna", 22.8456, 89.5403], ["Kishoreganj", 24.4260, 90.7828], ["Kurigram", 25.8055, 89.6363],
    ["Kushtia", 23.9013, 89.1200], ["Lakshmipur", 22.9444, 90.8252], ["Lalmonirhat", 25.9923, 89.2847],
    ["Madaripur", 23.1645, 90.1897], ["Magura", 23.4856, 89.4231], ["Manikganj", 23.8617, 90.0003],
    ["Meherpur", 23.7623, 88.6318], ["Moulvibazar", 24.4829, 91.7777], ["Munshiganj", 23.5422, 90.5305],
    ["Mymensingh", 24.7471, 90.4203], ["Naogaon", 24.7936, 88.9318], ["Narail", 23.1725, 89.5120],
    ["Narayanganj", 23.6238, 90.5000], ["Narsingdi", 23.9226, 90.7175], ["Natore", 24.4102, 89.0078],
    ["Netrokona", 24.8831, 90.7290], ["Nilphamari", 25.8486, 88.9414], ["Noakhali", 22.8242, 91.1017],
    ["Pabna", 24.0035, 89.2492], ["Panchagarh", 26.3411, 88.5542], ["Patuakhali", 22.3596, 90.3299],
    ["Pirojpur", 22.5795, 89.9754], ["Rajbari", 23.7574, 89.6444], ["Rajshahi", 24.3745, 88.6042],
    ["Rangamati", 22.7324, 92.2985], ["Rangpur", 25.7439, 89.2752], ["Satkhira", 22.7185, 89.0685],
    ["Shariatpur", 23.2423, 90.4348], ["Sherpur", 25.0205, 90.0155], ["Sirajganj", 24.4534, 89.7006],
    ["Sunamganj", 25.0719, 91.3992], ["Sylhet", 24.8949, 91.8687], ["Tangail", 24.2513, 89.9167],
    ["Thakurgaon", 26.0338, 88.4616]
  ];
  DISTRICTS.forEach(function (d) { if (!PLACE_LATLNG[d[0]]) PLACE_LATLNG[d[0]] = [d[1], d[2]]; });
  // Area names looked up for map pins (pin id -> real place name).
  var pinNames = {};
  function placeLabel(v) {
    if (!v) return "";
    if (pinNames[v]) return pinNames[v];
    return v.indexOf("MapPin-") === 0 ? "ম্যাপ পিন" : v;
  }
  // A map pin shows the name of the area it landed in, not "ম্যাপ পিন".
  // The name arrives a moment after the tap (reverse lookup); the route
  // chain, dropdowns and stop chips are updated in place when it lands.
  function geocodePin(id, lat, lng) {
    fetch("https://nominatim.openstreetmap.org/reverse?format=json&zoom=14&lat=" + lat + "&lon=" + lng, { headers: { "Accept": "application/json" } })
      .then(function (res) { if (!res.ok) throw new Error("geocode " + res.status); return res.json(); })
      .then(function (j) {
        var name = "";
        if (j && j.address) {
          var a = j.address;
          name = a.road || a.neighbourhood || a.quarter || a.suburb || a.village || a.hamlet ||
            a.city_district || a.town || a.city || a.county || a.state_district || a.state || "";
        }
        if (!name && j && j.display_name) name = String(j.display_name).split(",")[0];
        if (!name && j && j.name) name = j.name;
        if (name) {
          pinNames[id] = name;
          try { sessionStorage.setItem("cg_pin_names", JSON.stringify(pinNames)); } catch (e) {}
          [tourFrom, tourTo].forEach(function (sel) {
            if (!sel) return;
            for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === id) sel.options[i].textContent = name;
          });
          renderTour();
        }
      })
      .catch(function () {});
  }
  function legDist(a, b) {
    if (a === b) return 0;
    var d = DIST[a + "|" + b] || DIST[b + "|" + a];
    if (d) return d;
    // Real distance between any two known points (all 64 districts and
    // map pins carry lat/lng), so the tour total is real for any route.
    // Straight-line distance x1.2 approximates the road: Dhaka–Chattogram
    // is 214 km as the crow flies, 248 km by road.
    var la = PLACE_LATLNG[a], lb = PLACE_LATLNG[b];
    if (la && lb) return Math.max(5, Math.round(haversineKm(la[0], la[1], lb[0], lb[1]) * 1.2));
    var ca = PLACE_COORDS[a], cb = PLACE_COORDS[b];
    if (ca && cb) {
      var dx = ca.x - cb.x, dy = ca.y - cb.y;
      return Math.max(12, Math.round(Math.sqrt(dx * dx + dy * dy) * 5.2));
    }
    return 120;
  }
  function routeDist(places) {
    var total = 0;
    for (var i = 0; i < places.length - 1; i++) total += legDist(places[i], places[i + 1]);
    return total;
  }
  // The Tour starts empty: no start, no destination, no stops pre-picked.
  // Anything shown comes only from what the rider actually picked.
  var tourFrom = null, tourTo = null, stopOrder = [];
  var activeTourPlan = null;
  try { var at = sessionStorage.getItem("cg_active_tour_plan"); if (at) activeTourPlan = JSON.parse(at); } catch (e) {}
  // Stops live only in stopOrder now: the map is the one place to add or
  // remove them (tap in stop mode to add, tap again to remove). The route
  // chain preview below shows them; there is no separate chip list anymore.
  function selectedStops() {
    return stopOrder.filter(function (s) { return s !== tourFrom.value && s !== tourTo.value; });
  }
  function chainPlaces() {
    var p = [];
    if (tourFrom.value) p.push(tourFrom.value);
    p = p.concat(selectedStops());
    if (tourTo.value) p.push(tourTo.value);
    return p;
  }
  function populateTourSelects() {
    if (!tourFrom || !tourTo) return;
    DISTRICTS.forEach(function (d) { ensureOption(tourFrom, d[0], d[0]); ensureOption(tourTo, d[0], d[0]); });
    ["Mawa", "Bhanga", "Sajek"].forEach(function (p) { ensureOption(tourFrom, p, p); ensureOption(tourTo, p, p); });
  }
  function ensureOption(sel, value, label) {
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === value) return;
    var o = document.createElement("option"); o.value = value; o.textContent = label;
    sel.appendChild(o);
  }
  function setStop(value, on) {
    var i = stopOrder.indexOf(value);
    if (on && i === -1) stopOrder.push(value);
    if (!on && i !== -1) stopOrder.splice(i, 1);
  }
  function buildChain(el, places, mode) {
    if (!el) return;
    el.innerHTML = "";
    places.forEach(function (p, i) {
      var d = document.createElement("div");
      d.className = "stop" + (i === 0 ? " done" : "") + (mode === "live" && i === 1 ? " now" : "");
      var sub = i === 0 ? (mode === "live" ? "ছেড়েছ" : "শুরু") :
        (i === places.length - 1 ? "গন্তব্য" : (mode === "live" && i === 1 ? "পরের থামা" : "থামা"));
      d.appendChild(document.createTextNode(placeLabel(p)));
      d.appendChild(document.createElement("br"));
      var small = document.createElement("span"); small.textContent = sub; d.appendChild(small);
      el.appendChild(d);
    });
  }
  /* ---------- Live ride clock: real elapsed time while a tour is running ---------- */
  var rideStartAt = null, rideTimerId = null;
  function fmtElapsed(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h > 0) return bnNum(h) + " ঘণ্টা " + bnNum(m % 60) + " মিনিট";
    if (m > 0) return bnNum(m) + " মিনিট";
    return bnNum(s) + " সেকেন্ড";
  }
  function updateRideClock() {
    if (!rideStartAt) return;
    var el = fmtElapsed(Date.now() - rideStartAt);
    var tt = $("tourTime");
    if (tt && tourFrom && tourTo && tourFrom.value && tourTo.value && tourFrom.value !== tourTo.value) tt.textContent = el + " · চলছে";
    var rtl = $("rideTourLeft");
    if (rtl && activeTourPlan) rtl.textContent = "মোট ট্যুর " + bnNum(activeTourPlan.distance_km) + " km · " + el;
  }
  function startRideClock(fromMs) {
    rideStartAt = fromMs || Date.now();
    if (rideTimerId) clearInterval(rideTimerId);
    rideTimerId = setInterval(updateRideClock, 1000);
    updateRideClock();
  }
  // Put a saved/active tour plan back into the Tour screen (selects, stops,
  // and the ride clock when the ride already started).
  function restoreTourPlan(plan) {
    if (!plan || !tourFrom || !tourTo) return;
    if (plan.from) { ensureOption(tourFrom, plan.from, placeLabel(plan.from)); tourFrom.value = plan.from; }
    if (plan.to) { ensureOption(tourTo, plan.to, placeLabel(plan.to)); tourTo.value = plan.to; }
    (plan.stops || []).forEach(function (s) {
      ensureOption(tourFrom, s, placeLabel(s));
      ensureOption(tourTo, s, placeLabel(s));
      setStop(s, true);
    });
    renderTour();
    if (plan.started_at) {
      var st = Date.parse(plan.started_at);
      if (st && Date.now() - st < 12 * 3600 * 1000) startRideClock(st);
    }
  }
  function renderTour() {
    if (!tourFrom || !tourTo) return;
    var from = tourFrom.value, to = tourTo.value;
    var stops = selectedStops(), places = chainPlaces();
    // Nothing picked yet means no demo numbers: distance/time stay blank
    // and the stop count is the real number of stops picked (0 to start).
    var hasRoute = !!(from && to && from !== to);
    var dist = hasRoute ? routeDist(places) : 0;
    var td = $("tourDist"); if (td) td.textContent = hasRoute ? bnNum(dist) + " km" : "—";
    var tt = $("tourTime");
    if (tt) {
      if (!hasRoute) tt.textContent = "—";
      else if (rideStartAt) tt.textContent = fmtElapsed(Date.now() - rideStartAt) + " · চলছে";
      else { var hrs = dist / 55; tt.textContent = hrs < 1 ? "≈ " + bnNum(Math.round(dist / 55 * 60)) + " মিনিট" : "≈ " + bnNum(hrs.toFixed(1)) + " ঘণ্টা"; }
    }
    var tc = $("tourStopsCount"); if (tc) tc.textContent = bnNum(stops.length) + "টা";
    buildChain($("tourRouteChain"), places, "preview");
    renderTourMap();
  }
  function renderTourMap() {
    if (!tourFrom) return;
    var from = tourFrom.value, to = tourTo.value, stops = selectedStops(), places = chainPlaces();
    var pts = [];
    places.forEach(function (p) { var c = PLACE_COORDS[p]; if (c) pts.push(c.x + "," + c.y); });
    var ptsStr = pts.join(" ");
    var l1 = $("tourMapLine"), l2 = $("tourMapLineCase");
    if (l1) l1.setAttribute("points", ptsStr);
    if (l2) l2.setAttribute("points", ptsStr);
    var wrap = $("tourMapPins");
    if (wrap) {
      wrap.innerHTML = "";
      var pinPlaces = PLACES.slice();
      Object.keys(PLACE_COORDS).forEach(function (k) { if (pinPlaces.indexOf(k) === -1) pinPlaces.push(k); });
      pinPlaces.forEach(function (p) {
        var c = PLACE_COORDS[p]; if (!c) return;
        var b = document.createElement("button");
        b.type = "button";
        b.className = "map-pin" + (p === from ? " is-from" : "") + (p === to && p !== from ? " is-to" : "") + (stops.indexOf(p) !== -1 ? " is-stop" : "");
        b.style.left = c.x + "%"; b.style.top = c.y + "%";
        b.setAttribute("aria-label", placeLabel(p) + " — ম্যাপে বাছতে চাপ দাও");
        var lab = document.createElement("span"); lab.className = "mp-label"; lab.textContent = placeLabel(p);
        var dot = document.createElement("span"); dot.className = "mp-dot";
        b.appendChild(lab); b.appendChild(dot);
        b.addEventListener("click", function (ev) { ev.stopPropagation(); applyPick(p); });
        wrap.appendChild(b);
      });
    }
    var sel = $("tourMapSelected");
    if (sel) {
      sel.innerHTML = "";
      var f = document.createElement("span"); f.className = "tms-from"; f.textContent = "শুরু: " + placeLabel(from);
      sel.appendChild(f);
      stops.forEach(function (s) {
        var ar = document.createElement("span"); ar.className = "tms-arrow"; ar.textContent = "→"; sel.appendChild(ar);
        var st = document.createElement("span"); st.className = "tms-stop"; st.textContent = "থামা: " + placeLabel(s); sel.appendChild(st);
      });
      var ar2 = document.createElement("span"); ar2.className = "tms-arrow"; ar2.textContent = "→"; sel.appendChild(ar2);
      var t = document.createElement("span"); t.className = "tms-to"; t.textContent = "গন্তব্য: " + placeLabel(to); sel.appendChild(t);
    }
  }
  var pickMode = "from";
  var PICK_HINTS = {
    from: 'এখন <span>১ · শুরু</span> বাছছো — ম্যাপে যেখান থেকে রাইড শুরু হবে, সেখানে চাপ দাও।',
    to: 'শুরু বসেছে। এখন <span>২ · গন্তব্য</span> বাছছো — যেখানে যাবে, ম্যাপে সেখানে চাপ দাও।',
    stop: 'এবার <span>৩ · মাঝের থামা</span> — পথে যেখানে যেখানে থামবে, একে একে চাপ দাও। আবার চাপ দিলে বাদ যাবে।'
  };
  function setPickMode(mode) {
    pickMode = mode;
    document.querySelectorAll(".pick-mode-btn").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-mode") === mode ? "true" : "false");
    });
    var h = $("pickHint"); if (h) h.innerHTML = PICK_HINTS[mode];
  }
  document.querySelectorAll(".pick-mode-btn").forEach(function (b) {
    b.addEventListener("click", function () { setPickMode(b.getAttribute("data-mode")); });
  });
  // Returns true when the pick actually stuck, false when it was refused
  // (same place as start/destination) — the caller shows that on screen.
  function applyPick(value) {
    if (pickMode === "from") {
      ensureOption(tourFrom, value, placeLabel(value));
      tourFrom.value = value;
      setPickMode("to");
      toast($("tourToast"), "শুরু বসেছে: " + placeLabel(value) + " — এখন ম্যাপে গন্তব্যে চাপ দাও");
    } else if (pickMode === "to") {
      if (value === tourFrom.value) { toast($("tourToast"), "শুরু আর গন্তব্য একই জায়গা হতে পারে না"); return false; }
      ensureOption(tourTo, value, placeLabel(value));
      tourTo.value = value;
      setPickMode("stop");
      toast($("tourToast"), "গন্তব্য বসেছে: " + placeLabel(value) + " — চাইলে এখন মাঝের থামা যোগ করো");
    } else {
      if (value === tourFrom.value || value === tourTo.value) {
        toast($("tourToast"), "এটা তোমার শুরু/গন্তব্য — থামা হিসেবে যোগ হবে না");
        return false;
      }
      setStop(value, stopOrder.indexOf(value) === -1);
    }
    renderTour();
    return true;
  }
  function handleTourMapTap(x, y, latlng) {
    var nearest = null, nd = 1e9;
    PLACES.forEach(function (p) {
      var c = PLACE_COORDS[p];
      var dx = c.x - x, dy = c.y - y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < nd) { nd = d; nearest = p; }
    });
    if (nearest && nd <= 8) { applyPick(nearest); return; }
    var id = "MapPin-" + Math.round(x) + "-" + Math.round(y);
    if (!PLACE_COORDS[id]) {
      PLACE_COORDS[id] = { x: Math.round(x), y: Math.round(y) };
      if (latlng) PLACE_LATLNG[id] = [latlng.lat, latlng.lng];
      ensureOption(tourFrom, id, "ম্যাপ পিন");
      ensureOption(tourTo, id, "ম্যাপ পিন");
    }
    applyPick(id);
  }
  /* ---------- Tour picking on the real Riding map ---------- */
  var tourPickActive = false; // true while the Tour "pick points" banner is up
  function handleRideMapPick(latlng) {
    if (!latlng) return;
    var nearest = null, nd = 1e9;
    Object.keys(PLACE_LATLNG).forEach(function (p) {
      var ll = PLACE_LATLNG[p];
      var d = haversineKm(latlng.lat, latlng.lng, ll[0], ll[1]);
      if (d < nd) { nd = d; nearest = p; }
    });
    // Don't snap onto the start/destination itself: tapping a different
    // spot in the same city must still set a destination/stop, as its own
    // pin — otherwise every tap near the start was silently refused.
    var clashes = (pickMode === "to" && nearest === tourFrom.value) ||
      (pickMode === "stop" && (nearest === tourFrom.value || nearest === tourTo.value));
    if (nearest && nd <= 15 && !clashes) {
      if (applyPick(nearest)) toast($("rideToast"), placeLabel(nearest) + " Tour-এ যোগ হলো");
      else toast($("rideToast"), "এটা শুরুর জায়গাই — গন্তব্যের জন্য আরও দূরে চাপ দাও");
      return;
    }
    // No known place nearby — drop a map pin here and use it as the point.
    var id = "MapPin-" + latlng.lat.toFixed(4) + "-" + latlng.lng.toFixed(4);
    if (!PLACE_LATLNG[id]) {
      PLACE_LATLNG[id] = [latlng.lat, latlng.lng];
      // Real distances from this pin to every known place, so the tour total stays honest.
      Object.keys(PLACE_LATLNG).forEach(function (p) {
        if (p === id) return;
        var ll = PLACE_LATLNG[p];
        DIST[id + "|" + p] = Math.max(5, Math.round(haversineKm(latlng.lat, latlng.lng, ll[0], ll[1]) * 1.2));
      });
      ensureOption(tourFrom, id, "ম্যাপ পিন");
      ensureOption(tourTo, id, "ম্যাপ পিন");
      // Look up the area name for this pin so the route shows it, not "ম্যাপ পিন".
      geocodePin(id, latlng.lat, latlng.lng);
    }
    if (applyPick(id)) toast($("rideToast"), "ম্যাপ পিন Tour-এ যোগ হলো");
    else toast($("rideToast"), "এই পয়েন্টটা যোগ হলো না — আরেকটু দূরে চাপ দাও");
  }
  function openRideMapPick() {
    tourPickActive = true;
    var b = $("pickBanner"); if (b) b.hidden = false;
    setPickMode(pickMode || "from");
    openScreen("screen-riding");
  }
  function closeRideMapPick() {
    tourPickActive = false;
    var b = $("pickBanner"); if (b) b.hidden = true;
    openScreen("screen-tour");
  }
  on("openRideMapPickBtn", "click", openRideMapPick);
  on("pickDoneBtn", "click", closeRideMapPick);

  // Tour points on the Riding map are single location pins only — one pin
  // for the start, one for the destination, one per stop — with no line
  // (dotted or otherwise) joining them. tourRouteLine now holds that pin
  // group, so resetTour() can still remove it with removeLayer().
  function drawTourRouteOnRidingMap(plan) {
    if (!window.map || !plan) return;
    if (tourRouteLine) { try { window.map.removeLayer(tourRouteLine); } catch (e) {} tourRouteLine = null; }
    var places = plan.places || [];
    if (places.length < 1 || typeof L === "undefined") return;
    var group = L.layerGroup();
    places.forEach(function (p, i) {
      var ll = PLACE_LATLNG[p];
      if (!ll) return;
      var cls = i === 0 ? "is-from" : (i === places.length - 1 ? "is-to" : "is-stop");
      var icon = L.divIcon({
        className: "",
        html: '<div class="tour-pin ' + cls + '"></div>',
        iconSize: [22, 22], iconAnchor: [11, 11]
      });
      L.marker(ll, { icon: icon, interactive: false }).addTo(group);
    });
    group.addTo(window.map);
    tourRouteLine = group;
  }
  async function applyTour(goRide) {
    var from = tourFrom.value, to = tourTo.value;
    if (!from || !to) { toast($("tourToast"), "আগে শুরু আর গন্তব্য বাছো — তালিকা বা ম্যাপ থেকে"); return; }
    if (from === to) { toast($("tourToast"), "শুরু আর গন্তব্য একই জায়গা হতে পারে না — গন্তব্য বদলাও"); return; }
    var stops = selectedStops(), places = chainPlaces();
    var next = stops.length ? stops[0] : to;
    var dist = routeDist(places);
    var gnp = $("groupNextPlace");
    if (gnp) gnp.textContent = placeLabel(next) + " — সবাই মিলব এখানে";
    buildChain($("groupRouteChain"), places, "live");
    var mnb = $("mapNextBadge"); if (mnb) mnb.textContent = placeLabel(next);
    var rns = $("rideNextStop"); if (rns) rns.textContent = placeLabel(next);
    var rtl = $("rideTourLeft"); if (rtl) rtl.textContent = "মোট ট্যুর " + bnNum(dist) + " km";
    var tp = $("rideTpStops");
    if (tp) {
      tp.innerHTML = "";
      places.forEach(function (p, i) {
        var s = document.createElement("span");
        if (i === 0) s.textContent = placeLabel(p) + " ✓";
        else if (i === 1) { s.textContent = placeLabel(p) + " · পরের"; s.className = "on"; }
        else s.textContent = placeLabel(p);
        tp.appendChild(s);
      });
    }
    var bar = $("rideTpBar"); if (bar) bar.style.width = "8%";
    var tourPlan = {
      id: (activeTourPlan && activeTourPlan.id) || generateUUID(),
      room_code: (currentSession.roomCode || "").trim().toUpperCase(),
      name: "CONVOY Tour Plan",
      from: from, to: to, stops: stops, places: places,
      distance_km: dist, status: "active",
      created_by: currentSession.riderId || null,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    activeTourPlan = tourPlan;
    try { sessionStorage.setItem("cg_active_tour_plan", JSON.stringify(tourPlan)); } catch (e) {}
    // The ride starts now: the Tour time box and the Riding screen switch
    // from the estimate to the real ticking ride time.
    startRideClock();
    ensureRidingMap();
    drawTourRouteOnRidingMap(tourPlan);
    if (realtimeChannel) {
      try { realtimeChannel.send({ type: "broadcast", event: "tour_plan_update", payload: tourPlan }); } catch (e) {}
    }
    if (currentSession.roomCode) {
      try { await supabaseRest("tour_plans", "POST", tourPlan); } catch (e) { console.debug("[tour_plans]", e); }
    }
    toast($("tourToast"), "Tour সেট হয়েছে: " + placeLabel(from) + " → " + placeLabel(to) + " — Group আর Riding-এও বদলে গেছে");
    if (goRide) setTimeout(function () { openScreen("screen-riding"); }, 500);
  }
  // Reset the whole Tour so fresh data can be entered again: clears the
  // start, destination and stops, the distance/time summary, the live ride
  // clock, the route line on the map, and the saved plan (local + server),
  // so Riding and Group go back to "no tour set" too.
  function resetTour() {
    if (tourFrom) tourFrom.value = "";
    if (tourTo) tourTo.value = "";
    stopOrder.length = 0;
    activeTourPlan = null;
    try { sessionStorage.removeItem("cg_active_tour_plan"); } catch (e) {}
    if (rideTimerId) clearInterval(rideTimerId);
    rideTimerId = null; rideStartAt = null;
    if (tourRouteLine && window.map) { try { window.map.removeLayer(tourRouteLine); } catch (e) {} tourRouteLine = null; }
    var rns = $("rideNextStop"); if (rns) rns.textContent = "ট্যুর সেট করা হয়নি";
    var rtl = $("rideTourLeft"); if (rtl) rtl.textContent = "—";
    var tp = $("rideTpStops"); if (tp) tp.innerHTML = "<span>এখনো ট্যুর সেট করা হয়নি — Tour ট্যাবে গিয়ে পথ সেট করো</span>";
    var bar = $("rideTpBar"); if (bar) bar.style.width = "0%";
    var gnp = $("groupNextPlace"); if (gnp) gnp.textContent = "এখনো ট্যুর সেট করা হয়নি — Tour ট্যাবে গিয়ে পথ সেট করো";
    var grc = $("groupRouteChain"); if (grc) grc.innerHTML = "";
    var mnb = $("mapNextBadge"); if (mnb) mnb.textContent = "—";
    if (currentSession.roomCode) {
      try { supabaseRest("tour_plans?room_code=eq." + encodeURIComponent(currentSession.roomCode.trim().toUpperCase()), "DELETE").catch(function () {}); } catch (e) {}
    }
    setPickMode("from");
    renderTour();
    toast($("tourToast"), "সব মুছে গেছে — এখন নতুন করে শুরু, গন্তব্য আর থামা বাছো");
  }
  on("resetTourBtn", "click", resetTour);
  on("clearStopsBtn", "click", function () {
    stopOrder.slice().forEach(function (s) { setStop(s, false); });
    renderTour();
    toast($("tourToast"), "সব মাঝের থামা মোছা হয়েছে");
  });
  on("resetPickBtn", "click", function () {
    setPickMode("from");
    toast($("tourToast"), "আবার শুরু থেকে — ম্যাপে শুরুর জায়গায় চাপ দাও");
  });
  on("swapTourBtn", "click", function () {
    var v = tourFrom.value; tourFrom.value = tourTo.value; tourTo.value = v;
    renderTour();
  });
  on("setTourBtn", "click", function () { applyTour(false); });
  on("startTourRideBtn", "click", function () { applyTour(true); });

  /* ---------- Realtime ---------- */
  function subscribeRealtime() {
    if (!sbClient || realtimeChannel || !currentSession.roomCode) return;
    try {
      var channelName = "cholo-ghuri-room-" + currentSession.roomCode.trim().toUpperCase();
      realtimeChannel = sbClient.channel(channelName, { config: { broadcast: { self: false } } });
      realtimeChannel
        .on("broadcast", { event: "police_alert" }, function (m) {
          if (m.payload) addOrUpdatePoliceMarker(m.payload);
          evaluatePoliceProximity();
        })
        .on("broadcast", { event: "tour_plan_update" }, function (m) {
          if (m.payload) {
            activeTourPlan = m.payload;
            try { sessionStorage.setItem("cg_active_tour_plan", JSON.stringify(m.payload)); } catch (e) {}
            drawTourRouteOnRidingMap(m.payload);
            toast($("rideToast"), "Captain নতুন Tour সেট করেছে");
          }
        })
        .on("broadcast", { event: "voice_message" }, function (m) { if (m.payload) playVoiceMessage(m.payload); })
        .on("broadcast", { event: "kick" }, function (m) {
          if (m.payload && m.payload.riderId === currentSession.riderId) handleKickedFromConvoy();
        })
        .subscribe();
      sbClient.channel("police_reports_realtime")
        .on("postgres_changes", { event: "*", schema: "public", table: "police_reports" }, function (payload) {
          if (payload.new) addOrUpdatePoliceMarker(payload.new);
          if (payload.eventType === "DELETE" && payload.old) removePoliceMarker(payload.old.id);
          evaluatePoliceProximity();
        })
        .subscribe();
    } catch (e) { console.debug("[realtime]", e); }
  }
  async function fetchActiveTourPlan() {
    if (!currentSession.roomCode) return;
    try {
      var plans = await supabaseRest(
        "tour_plans?room_code=eq." + encodeURIComponent(currentSession.roomCode.trim().toUpperCase()) +
        "&status=eq.active&order=updated_at.desc&limit=1", "GET");
      if (Array.isArray(plans) && plans[0]) {
        activeTourPlan = plans[0];
        try { sessionStorage.setItem("cg_active_tour_plan", JSON.stringify(plans[0])); } catch (e) {}
        restoreTourPlan(plans[0]);
        drawTourRouteOnRidingMap(plans[0]);
      }
    } catch (e) {}
  }

  /* ---------- init ---------- */
  function init() {
    tourFrom = $("tourFrom"); tourTo = $("tourTo");
    populateTourSelects();
    // Picking from the list recalculates distance/time/route at once,
    // exactly like picking on the map does — no stale numbers.
    tourFrom.addEventListener("change", renderTour);
    tourTo.addEventListener("change", renderTour);
    setPickMode("from");
    // Area names looked up for map pins earlier in this session.
    try { var pn = JSON.parse(sessionStorage.getItem("cg_pin_names") || "{}"); if (pn && typeof pn === "object") pinNames = pn; } catch (e) {}
    if (activeTourPlan) restoreTourPlan(activeTourPlan);
    renderTour();
    var rc = $("roomCode");
    // No auto-filled code: the field stays empty until the user taps
    // "নতুন কোড" or presses START (which generates a fresh real code),
    // so no code ever appears on its own looking like a fixed demo value.
    if (currentSession.riderName) { var rn = $("riderName"); if (rn) rn.value = currentSession.riderName; }
    if (currentSession.roomCode && rc) rc.value = currentSession.roomCode;
    if (currentSession.isLeader) {
      captainWanted = true;
      var cap = $("captainToggle"); if (cap) cap.setAttribute("aria-pressed", "true");
    }
    var chip = $("roomChip");
    if (chip && currentSession.roomCode) chip.textContent = currentSession.roomCode + " · সংযুক্ত";
    if (activeTourPlan && activeTourPlan.places) {
      buildChain($("groupRouteChain"), activeTourPlan.places, "live");
      var gnp = $("groupNextPlace");
      if (gnp && activeTourPlan.stops && activeTourPlan.stops[0]) {
        gnp.textContent = placeLabel(activeTourPlan.stops[0]) + " — সবাই মিলব এখানে";
      }
    }
    // hide the police card until a real report is near
    var pc = $("policeCard"); if (pc) pc.style.display = "none";
    fetchPoliceReports();
    if (currentSession.riderId && currentSession.roomCode) {
      fetchActiveTourPlan();
    }
    // Show the room code the user is about to join with — never a fake demo code.
    if (!currentSession.roomCode && rc && rc.value) {
      var gs = $("groupSub");
      if (gs) gs.textContent = "রুম " + rc.value + " · Ride শুরু করলে গ্রুপ দেখাবে";
      var chip0 = $("roomChip");
      if (chip0) chip0.textContent = "রুম " + rc.value + " · এখনো যোগ দাওনি";
    }
    // GPS starts on load so the Riding map shows the real location even before
    // START is pressed; a saved session also resumes its live sync.
    startGps();
    if (currentSession.riderId && currentSession.roomCode) { startSyncLoops(); subscribeRealtime(); }
    openScreen("screen-join");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
