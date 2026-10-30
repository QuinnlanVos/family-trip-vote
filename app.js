(function () {
  "use strict";
  var CFG = window.TRIP_CONFIG;
  var SEED = window.SEED_CITIES;
  var LIMITS = { name: 60, note: 240, photo: 400, todo: 120, who: 30 };
  var RATE = { max: 6, windowMs: 10 * 60 * 1000 }; // adds per device per 10 min

  // ---------- device identity ----------
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function rid(n) { var a = "abcdefghijkmnpqrstuvwxyz23456789", s = ""; var r = new Uint8Array(n); (window.crypto || window.msCrypto).getRandomValues(r); for (var i = 0; i < n; i++) s += a[r[i] % a.length]; return s; }
  var DEVICE = lsGet("ftv.device", null);
  if (!DEVICE) { DEVICE = rid(10); lsSet("ftv.device", DEVICE); }
  var mine = lsGet("ftv.mine", {}); // keys I created

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"'`]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c]; }); }
  function clean(s, max) { return String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
  function safeUrl(u) { u = clean(u, LIMITS.photo); if (!/^https:\/\/[^\s"'<>]+$/i.test(u)) return ""; return u; }
  function safeId(s) { return /^[a-z0-9-]{1,40}$/.test(s) ? s : null; }
  var toastT;
  function toast(msg) { var t = document.getElementById("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("show"); }, 2600); }
  function myName() { return clean(document.getElementById("myname").value, LIMITS.who); }
  function rateOk() {
    var now = Date.now(), log = lsGet("ftv.rate", []).filter(function (t) { return now - t < RATE.windowMs; });
    if (log.length >= RATE.max) { toast("Whoa, slow down! Try again in a few minutes."); return false; }
    log.push(now); lsSet("ftv.rate", log); return true;
  }

  // ---------- backend (textdb.dev: one shared JSON document, no accounts) ----------
  // Every change is an idempotent "entry" with a timestamp. We merge local pending entries into the
  // latest server copy (newest timestamp wins), write, then re-read to confirm, so two people
  // tapping at the same moment don't wipe each other's votes.
  var DOC_URL = "https://textdb.dev/api/data/" + CFG.DOC_ID;
  var CAPS = { todosPerCity: 40, spots: 40 };
  var pending = lsGet("ftv.pending", []); // [{t:'vote'|'todo'|'spot', k:..., city?:..., val:{...,ts}}]
  var serverDoc = emptyDoc();

  function emptyDoc() { return { v: 1, votes: {}, todos: {}, spots: {} }; }
  function normalize(d) {
    if (!d || typeof d !== "object") return emptyDoc();
    return { v: 1, votes: d.votes && typeof d.votes === "object" ? d.votes : {}, todos: d.todos && typeof d.todos === "object" ? d.todos : {}, spots: d.spots && typeof d.spots === "object" ? d.spots : {} };
  }
  function getDoc() {
    return fetch(DOC_URL + "?_=" + Date.now(), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status); return r.text();
    }).then(function (t) { if (!t) return emptyDoc(); try { return normalize(JSON.parse(t)); } catch (e) { return emptyDoc(); } });
  }
  function putDoc(doc) {
    // text/plain is a CORS "simple" request (no preflight); textdb stores the raw text.
    return fetch(DOC_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(doc) })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); });
  }
  function slot(doc, p) {
    if (p.t === "vote") { doc.votes[p.city] = doc.votes[p.city] || {}; return [doc.votes[p.city], p.k]; }
    if (p.t === "todo") return [doc.todos, p.k];
    return [doc.spots, p.k];
  }
  function applyPending(doc) { // returns true if doc changed
    var changed = false;
    pending.forEach(function (p) {
      var s = slot(doc, p), cur = s[0][s[1]];
      if (!cur || (+cur.ts || 0) < p.val.ts) { s[0][s[1]] = p.val; changed = true; }
    });
    return changed;
  }
  function confirmed(doc) {
    pending = pending.filter(function (p) { var s = slot(doc, p), cur = s[0][s[1]]; return !(cur && (+cur.ts || 0) >= p.val.ts); });
    lsSet("ftv.pending", pending);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var syncing = null;
  function sync() {
    if (syncing) return syncing.then(function () { return pending.length ? sync() : null; });
    var tries = 0;
    function round() {
      tries++;
      return getDoc().then(function (doc) {
        if (!applyPending(doc)) { confirmed(doc); return doc; }
        return putDoc(doc).then(function () { return wait(900 + Math.random() * 900); }).then(getDoc).then(function (doc2) {
          confirmed(doc2);
          if (pending.length && tries < 5) return wait(Math.random() * 1200).then(round);
          return doc2;
        });
      });
    }
    syncing = round().then(function (doc) { serverDoc = doc; return doc; }).then(function (d) { syncing = null; return d; }, function (e) { syncing = null; throw e; });
    return syncing;
  }
  function queue(p) { pending = pending.filter(function (x) { return !(x.t === p.t && x.k === p.k && x.city === p.city); }); pending.push(p); lsSet("ftv.pending", pending); }

  var state = { votes: {}, voters: {}, todos: {}, spots: [], loaded: false };

  function derive(doc) {
    doc = JSON.parse(JSON.stringify(doc)); applyPending(doc); // show my unsynced changes too
    var s = { votes: {}, voters: {}, todos: {}, spots: [] };
    Object.keys(doc.votes).forEach(function (city) {
      if (!safeId(city)) return;
      var m = doc.votes[city] || {};
      Object.keys(m).forEach(function (dev) {
        var e = m[dev]; if (!e || !e.on) return;
        s.votes[city] = (s.votes[city] || 0) + 1;
        (s.voters[city] = s.voters[city] || []).push({ device: dev, by: clean(e.by, LIMITS.who) });
      });
    });
    Object.keys(doc.todos).forEach(function (k) {
      var e = doc.todos[k]; if (!e || e.gone || !safeId(e.city)) return;
      var text = clean(e.text, LIMITS.todo); if (!text) return;
      (s.todos[e.city] = s.todos[e.city] || []).push({ key: k, text: text, by: clean(e.by, LIMITS.who), ts: +e.made || +e.ts || 0 });
    });
    Object.keys(doc.spots).forEach(function (id) {
      var e = doc.spots[id]; if (!e || e.gone || !safeId(id)) return;
      var name = clean(e.name, LIMITS.name); if (!name) return;
      s.spots.push({ id: id, key: id, name: name, note: clean(e.note, LIMITS.note), photo: safeUrl(e.photo), by: clean(e.by, LIMITS.who), ts: +e.made || +e.ts || 0, user: true, todos: [], emoji: "📍" });
    });
    Object.keys(s.todos).forEach(function (c) { s.todos[c].sort(function (a, b) { return a.ts - b.ts; }); s.todos[c] = s.todos[c].slice(0, CAPS.todosPerCity); });
    s.spots.sort(function (a, b) { return a.ts - b.ts; }); s.spots = s.spots.slice(0, CAPS.spots);
    return s;
  }

  var loading = false;
  function load(manual) {
    if (loading) return; loading = true;
    var st = document.getElementById("status");
    if (manual) st.textContent = "Refreshing…";
    (pending.length ? sync() : getDoc().then(function (d) { serverDoc = d; confirmed(d); return d; }))
      .then(function (doc) {
        state = derive(doc); state.loaded = true;
        render();
        st.textContent = "Live · updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + (pending.length ? " · saving…" : "");
      })
      .catch(function () { st.textContent = "Couldn't reach the vote server, retrying…"; if (!state.loaded) render(); })
      .then(function () { loading = false; });
  }
  function commit(msg) {
    state = derive(serverDoc); render();
    sync().then(function (doc) { state = derive(doc); render(); toast(pending.length ? "Still saving… we'll keep trying" : msg); })
      .catch(function () { toast("Offline? We'll save it when the connection is back"); });
  }

  // ---------- rendering ----------
  var lastOrder = "";
  function allCities() {
    var list = SEED.map(function (c) { return Object.assign({}, c); });
    return list.concat(state.spots);
  }
  function render() {
    var myVotes = lsGet("ftv.votes", {});
    var cities = allCities().map(function (c, i) { c.n = state.votes[c.id] || 0; c.i = i; return c; });
    cities.sort(function (a, b) { return b.n - a.n || a.i - b.i; });
    var order = cities.map(function (c) { return c.id; }).join(",");
    var reordered = lastOrder && lastOrder !== order; lastOrder = order;
    // keep typed text in to-do inputs
    var drafts = {}; document.querySelectorAll(".addtodo input").forEach(function (el) { if (el.value) drafts[el.dataset.city] = el.value; });
    var focusCity = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.city : null;

    var html = cities.map(function (c, idx) {
      var photos = (c.user ? (c.photo ? [c.photo] : []) : c.photos).map(function (p) { return typeof p === "string" ? { src: p, credit: "" } : p; });
      var ph = photos.length ? photos.map(function (p, pi) { return '<figure><img ' + (idx > 1 || pi > 0 ? 'loading="lazy" ' : "") + 'src="' + esc(p.src) + '" alt="' + esc(c.name) + '" referrerpolicy="no-referrer" onerror="this.parentNode.innerHTML=\'<div class=nophoto>' + esc(c.emoji) + '</div>\'">' + (p.credit ? "<figcaption>📷 " + esc(p.credit) + "</figcaption>" : "") + "</figure>"; }).join("") : '<div class="nophoto">' + esc(c.emoji) + "</div>";
      var dots = photos.length > 1 ? '<div class="dots">' + photos.map(function () { return "<i></i>"; }).join("") + "</div>" : "";
      var seedTodos = (c.todos || []).map(function (t) { return '<li><span class="ico">✅</span><span>' + esc(t) + "</span></li>"; }).join("");
      var userTodos = (state.todos[c.id] || []).map(function (t) {
        var del = mine[t.key] ? ' <button class="ghost del" data-del="' + esc(t.key) + '" aria-label="Remove">✕</button>' : "";
        return '<li class="user"><span class="ico">💡</span><span>' + esc(t.text) + (t.by ? '<span class="by">— ' + esc(t.by) + "</span>" : "") + del + "</span></li>";
      }).join("");
      var voted = !!myVotes[c.id];
      var names = (state.voters[c.id] || []).map(function (v) { return v.by; }).filter(Boolean);
      var voterLine = names.length ? '<div class="voters">❤️ ' + esc(names.slice(0, 8).join(", ")) + (names.length > 8 ? " +" + (names.length - 8) : "") + "</div>" : "";
      var sub = c.user ? (c.by ? '<span class="suggested">Suggested by ' + esc(c.by) + "</span>" : '<span class="suggested">Family suggestion</span>') : '<div class="country">' + esc(c.country) + "</div>";
      var tag = c.user ? (c.note ? '<p class="tagline">' + esc(c.note) + "</p>" : "") : '<p class="tagline">' + esc(c.tagline) + "</p>";
      var delSpot = c.user && mine[c.key] ? ' <button class="ghost del" data-del="' + esc(c.key) + '">Remove my spot</button>' : "";
      return '<article class="card' + (idx === 0 && c.n > 0 ? " first" : "") + (reordered ? " moved" : "") + '" id="c-' + esc(c.id) + '">' +
        '<span class="rank' + (idx === 0 && c.n > 0 ? " gold" : "") + '">' + (idx === 0 && c.n > 0 ? "🏆 #1" : "#" + (idx + 1)) + "</span>" +
        '<div class="photos">' + ph + "</div>" + dots +
        '<div class="body"><div class="title-row"><div><h3>' + esc(c.emoji) + " " + esc(c.name) + "</h3>" + sub + "</div>" +
        '<button class="vote' + (voted ? " on" : "") + '" data-vote="' + esc(c.id) + '" aria-pressed="' + voted + '" aria-label="Vote for ' + esc(c.name) + '"><span class="heart">' + (voted ? "❤️" : "🤍") + '</span><span class="count">' + c.n + "</span></button></div>" +
        tag + '<ul class="todos">' + seedTodos + userTodos + "</ul>" +
        '<form class="addtodo" data-city="' + esc(c.id) + '"><input data-city="' + esc(c.id) + '" maxlength="' + LIMITS.todo + '" placeholder="Add a thing to do…" aria-label="Add a thing to do in ' + esc(c.name) + '"><button type="submit">Add</button></form>' +
        voterLine + delSpot + "</div></article>";
    }).join("");
    var root = document.getElementById("cards");
    root.innerHTML = html;
    document.querySelectorAll(".addtodo input").forEach(function (el) { if (drafts[el.dataset.city]) el.value = drafts[el.dataset.city]; if (focusCity && el.dataset.city === focusCity) el.focus(); });
  }

  // ---------- actions ----------
  function vote(id) {
    if (!safeId(id)) return;
    var myVotes = lsGet("ftv.votes", {});
    var on = !myVotes[id];
    if (on) myVotes[id] = 1; else delete myVotes[id];
    lsSet("ftv.votes", myVotes);
    queue({ t: "vote", city: id, k: DEVICE, val: { on: on, by: myName(), ts: Date.now() } });
    commit(on ? "Vote counted ❤️" : "Vote removed");
    var b = document.querySelector('[data-vote="' + id + '"]'); if (b) b.classList.add("bump");
  }

  function addTodo(form) {
    var id = form.dataset.city, input = form.querySelector("input");
    var text = clean(input.value, LIMITS.todo);
    if (!safeId(id) || text.length < 2) { toast("Type a thing to do first"); return; }
    if ((state.todos[id] || []).length >= CAPS.todosPerCity) { toast("This card is full of ideas already!"); return; }
    if (!rateOk()) return;
    var key = "t-" + Date.now().toString(36) + rid(4), now = Date.now();
    input.value = "";
    mine[key] = 1; lsSet("ftv.mine", mine);
    queue({ t: "todo", k: key, val: { city: id, text: text, by: myName(), made: now, ts: now } });
    commit("Added 💡");
  }

  function addSpot(form) {
    var name = clean(form.name.value, LIMITS.name), note = clean(form.note.value, LIMITS.note), photoRaw = form.photo.value.trim(), photo = safeUrl(photoRaw);
    if (name.length < 2) { toast("Add a place name"); return; }
    if (photoRaw && !photo) { toast("Photo link must start with https://"); return; }
    var dupe = allCities().some(function (c) { return c.name.toLowerCase() === name.toLowerCase(); });
    if (dupe) { toast("That spot is already on the list, vote for it!"); return; }
    if (state.spots.length >= CAPS.spots) { toast("The list is full!"); return; }
    if (!rateOk()) return;
    var id = "s-" + Date.now().toString(36) + rid(4), now = Date.now();
    mine[id] = 1; lsSet("ftv.mine", mine);
    form.reset();
    queue({ t: "spot", k: id, val: { name: name, note: note, photo: photo, by: myName(), made: now, ts: now } });
    commit("New spot added ✨");
    setTimeout(function () { var el = document.getElementById("c-" + id); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }, 300);
  }

  function del(key) {
    if (!mine[key]) return;
    if (!confirm("Remove this?")) return;
    var isSpot = /^s-/.test(key);
    var cur = isSpot ? serverDoc.spots[key] : serverDoc.todos[key];
    var pend = pending.filter(function (p) { return p.k === key; })[0];
    var base = (pend && pend.val) || cur || {};
    var val = Object.assign({}, base, { gone: true, ts: Date.now() });
    queue({ t: isSpot ? "spot" : "todo", k: key, val: val });
    commit("Removed");
  }

  // ---------- wiring ----------
  document.addEventListener("click", function (e) {
    var v = e.target.closest("[data-vote]"); if (v) { vote(v.dataset.vote); return; }
    var d = e.target.closest("[data-del]"); if (d) { e.preventDefault(); del(d.dataset.del); }
  });
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (f.classList.contains("addtodo")) { e.preventDefault(); addTodo(f); }
    else if (f.id === "addSpot") { e.preventDefault(); addSpot(f); }
  });
  var nameEl = document.getElementById("myname");
  nameEl.value = lsGet("ftv.name", "");
  nameEl.addEventListener("change", function () { lsSet("ftv.name", myName()); });
  document.getElementById("refresh").addEventListener("click", function () { load(true); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
  setInterval(function () {
    if (document.hidden) return;
    var a = document.activeElement; if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && a.value) return; // don't re-render while typing
    load();
  }, CFG.POLL_MS);
  render();
  load();
})();
