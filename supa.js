/* SMM Tracking Pengadaan — lapisan Supabase.
   Menyediakan window.claude.use(...) (db, user, sample, assets, downloads) di atas Supabase,
   plus layar login username/password, halaman Pengguna, ganti password dan keluar. */
(function () {
  "use strict";
  const CFG = window.SMM_CONFIG || {};
  const DOMAIN = "users.smm-tracking.app";
  const FN = (n) => CFG.url.replace(/\/$/, "") + "/functions/v1/" + n;
  const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "smm-auth" } });
  window.__sb = sb;
  const ROLE_LBL = { owner: "Pemilik", approver: "Pimpinan / penyetuju", admin: "Admin", gudang: "Gudang" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rid = () => { const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(20)); for (const x of r) s += a[x % a.length]; return s; };
  const parentOf = (p) => p.split("/").slice(0, -1).join("/");
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const errOf = (e) => {
    const m = String(e?.message || e || "");
    if (e?.code === "42501" || /row-level security|forbidden|tidak boleh/i.test(m)) return Object.assign(new Error("Akun ini tidak punya izin untuk perubahan ini."), { code: "invalid_argument" });
    if (e?.code === "P0002" || /not_found/.test(m)) return Object.assign(new Error("Data tidak ditemukan."), { code: "not_found" });
    if (/JWT|session|401/i.test(m)) return Object.assign(new Error("Sesi login berakhir. Silakan login ulang."), { code: "unauthenticated" });
    return Object.assign(new Error(m || "Gagal menyimpan."), { code: e?.code || "unknown" });
  };

  let me = null;           // {id, username, name, role}
  let profiles = [];       // all profiles
  let readyResolve; const ready = new Promise((r) => (readyResolve = r));

  /* ---------------- profiles → virtual config/roles & members ---------------- */
  const virt = { "config/roles": null };
  function rolesDoc() {
    const act = profiles.filter((p) => p.active);
    const owner = act.find((p) => p.role === "owner");
    return { ownerId: owner?.id || "", approvers: act.filter((p) => p.role === "approver").map((p) => p.id), gudang: act.filter((p) => p.role === "gudang").map((p) => p.id), updatedAt: Date.now() };
  }
  async function loadProfiles() {
    const { data, error } = await sb.from("profiles").select("id,username,name,role,active,created_at").order("created_at");
    if (error) throw errOf(error);
    profiles = data || [];
    me = profiles.find((p) => p.id === me?.id) || me;
    virt["config/roles"] = rolesDoc();
    emitDoc("config/roles"); emitCol("members");
  }

  /* ---------------- document store ---------------- */
  const cols = new Map();   // col → {docs:Map(path→data), loaded, loading, subs:Set}
  const docSubs = new Map(); // path → Set(cb)
  const isGudang = () => me?.role === "gudang";
  const GUD_COLS = new Set(["items", "sorders", "rfqs"]);
  const colState = (c) => { if (!cols.has(c)) cols.set(c, { docs: new Map(), loaded: false, loading: null, subs: new Set() }); return cols.get(c); };
  const snapDoc = (path, data) => ({ id: path.split("/").pop(), ref: { path }, exists: data != null, data: () => clone(data) ?? undefined });

  async function fetchCol(c) {
    const st = colState(c);
    if (isGudang()) { await gudangLoad(); return; }
    const out = new Map(); let from = 0;
    for (;;) {
      const { data, error } = await sb.from("docs").select("path,data").eq("col", c).order("path").range(from, from + 999);
      if (error) throw errOf(error);
      (data || []).forEach((r) => out.set(r.path, r.data));
      if (!data || data.length < 1000) break; from += 1000;
    }
    st.docs = out; st.loaded = true;
  }
  let gudTimer = null, gudLoading = null;
  async function gudangLoad() {
    if (gudLoading) return gudLoading;
    gudLoading = (async () => {
      const { data, error } = await sb.rpc("gudang_docs");
      if (error) throw errOf(error);
      const by = { items: new Map(), sorders: new Map(), rfqs: new Map() };
      (data || []).forEach((r) => by[r.col]?.set(r.path, r.data));
      for (const c of GUD_COLS) { const st = colState(c); st.docs = by[c]; st.loaded = true; emitCol(c); }
    })().finally(() => { gudLoading = null; });
    return gudLoading;
  }
  function ensure(c) { const st = colState(c); if (st.loaded) return Promise.resolve(); if (!st.loading) st.loading = fetchCol(c).finally(() => (st.loading = null)); return st.loading; }

  const pending = new Set(); let flushT = null;
  function emitCol(c) { pending.add(c); if (!flushT) flushT = setTimeout(flush, 25); }
  function emitDoc(path) { const s = docSubs.get(path); if (!s) return; const d = getLocal(path); s.forEach((cb) => { try { cb(snapDoc(path, d)); } catch (e) { console.error(e); } }); }
  function flush() {
    flushT = null; const list = [...pending]; pending.clear();
    for (const c of list) {
      if (c === "members") { const docs = profiles.filter((p) => p.active).map((p) => snapDoc("members/" + p.id, { at: Date.parse(p.created_at) || 0 })); colState("members").subs.forEach((cb) => cb({ docs, size: docs.length, empty: !docs.length })); continue; }
      const st = cols.get(c); if (!st) continue;
      const docs = [...st.docs.entries()].map(([p, d]) => snapDoc(p, d));
      st.subs.forEach((cb) => { try { cb({ docs, size: docs.length, empty: !docs.length }); } catch (e) { console.error(e); } });
      for (const p of st.docs.keys()) if (docSubs.has(p)) emitDoc(p);
    }
  }
  function getLocal(path) { if (path in virt) return virt[path]; const st = cols.get(parentOf(path)); return st ? st.docs.get(path) ?? null : null; }
  function applyLocal(path, data) { const c = parentOf(path); const st = colState(c); if (data == null) st.docs.delete(path); else st.docs.set(path, data); emitCol(c); emitDoc(path); }

  function onRealtime(ev) {
    const row = ev.new && ev.new.path ? ev.new : null; const old = ev.old && ev.old.path ? ev.old : null;
    const path = row?.path || old?.path; if (!path) return;
    const c = parentOf(path); const st = cols.get(c); if (!st || !st.loaded) return;
    if (ev.eventType === "DELETE") { st.docs.delete(path); } else if (row) st.docs.set(path, row.data);
    emitCol(c); emitDoc(path);
  }
  let chan = null, lastSeen = Date.now();
  function startSync() {
    if (isGudang()) { clearInterval(gudTimer); gudTimer = setInterval(() => gudangLoad().catch(() => {}), 30000); return; }
    chan = sb.channel("docs-all").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, onRealtime)
      .subscribe((status) => { if (status === "SUBSCRIBED") refreshAll(); });
  }
  async function refreshAll() { for (const c of cols.keys()) { const st = cols.get(c); if (st.loaded && c !== "members") { try { await fetchCol(c); emitCol(c); } catch {} } } if (isGudang()) gudangLoad().catch(() => {}); loadProfiles().catch(() => {}); }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { if (Date.now() - lastSeen > 60000) refreshAll(); } else lastSeen = Date.now(); });

  function docRef(path) {
    return {
      id: path.split("/").pop(), path,
      async get() { if (path in virt) return snapDoc(path, virt[path]); const st = cols.get(parentOf(path)); if (st?.loaded) return snapDoc(path, st.docs.get(path) ?? null);
        if (isGudang()) { await gudangLoad(); return snapDoc(path, getLocal(path)); }
        const { data, error } = await sb.from("docs").select("data").eq("path", path).maybeSingle(); if (error) throw errOf(error); return snapDoc(path, data ? data.data : null); },
      async set(data) {
        if (path in virt) return; // peran diatur lewat halaman Pengguna
        if (path.startsWith("members/")) return;
        if (isGudang()) throw errOf({ code: "42501" });
        const d = clone(data);
        const { error } = await sb.from("docs").upsert({ path, col: parentOf(path), data: d, updated_at: new Date().toISOString() });
        if (error) throw errOf(error); applyLocal(path, d);
      },
      async update(patch) {
        const p = clone(patch);
        if (isGudang()) { const { error } = await sb.rpc("gudang_receive", { p: path, patch: p }); if (error) throw errOf(error); }
        else { const { error } = await sb.rpc("doc_update", { p: path, patch: p }); if (error) throw errOf(error); }
        const cur = getLocal(path); applyLocal(path, { ...(cur || {}), ...p });
      },
      async delete() { if (isGudang()) throw errOf({ code: "42501" }); const { error } = await sb.from("docs").delete().eq("path", path); if (error) throw errOf(error); applyLocal(path, null); },
      onSnapshot(cb, onErr) {
        if (!docSubs.has(path)) docSubs.set(path, new Set()); docSubs.get(path).add(cb);
        if (path in virt) { setTimeout(() => cb(snapDoc(path, virt[path]))); }
        else ensure(parentOf(path)).then(() => emitDoc(path)).catch((e) => onErr && onErr(e));
        return () => docSubs.get(path)?.delete(cb);
      },
    };
  }
  function colRef(c) {
    return {
      path: c,
      doc: (id) => docRef(c + "/" + (id || rid())),
      onSnapshot(cb, onErr) {
        const st = colState(c); st.subs.add(cb);
        if (c === "members") emitCol(c);
        else if (isGudang() && !GUD_COLS.has(c)) setTimeout(() => cb({ docs: [], size: 0, empty: true }));
        else ensure(c).then(() => emitCol(c)).catch((e) => onErr && onErr(e));
        return () => st.subs.delete(cb);
      },
      async get() { await ensure(c); const st = colState(c); const docs = [...st.docs.entries()].map(([p, d]) => snapDoc(p, d)); return { docs, size: docs.length, empty: !docs.length }; },
    };
  }
  const db = { collection: colRef, doc: docRef };

  /* ---------------- user ---------------- */
  const user = {
    me: async () => ({ name: me?.name || me?.username || "", username: me?.username }),
    isOwner: async () => me?.role === "owner",
    id: async () => me?.id,
    can: async () => true,
    profiles: async (ids) => { const m = {}; ids.forEach((id) => { const p = profiles.find((x) => x.id === id); if (p) m[id] = { name: p.name || p.username }; }); return m; },
  };

  /* ---------------- AI (Edge Function "ai") ---------------- */
  const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
  async function token() { const { data } = await sb.auth.getSession(); return data?.session?.access_token || ""; }
  function parseJ(t) { if (typeof window.parseJsonText === "function") return window.parseJsonText(t);
    const s = String(t).replace(/^```(?:json)?\s*|\s*```$/g, "").trim(); try { return JSON.parse(s); } catch { const a = s.indexOf("{"), b = s.lastIndexOf("}"); const a2 = s.indexOf("["), b2 = s.lastIndexOf("]"); if (a2 >= 0 && (a < 0 || a2 < a)) return JSON.parse(s.slice(a2, b2 + 1)); return JSON.parse(s.slice(a, b + 1)); } }
  async function aiCall(input, opts = {}) {
    let imgs = opts.images ? (Array.isArray(opts.images) ? opts.images : [opts.images]) : [];
    const images = []; for (const im of imgs) images.push({ type: im.type || "image/jpeg", data: await b64(im) });
    let r;
    try {
      r = await fetch(FN("ai"), { method: "POST", signal: opts.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + (await token()), apikey: CFG.key }, body: JSON.stringify({ prompt: String(input), images, tier: opts.modelTier === "quick" ? "quick" : "" }) });
    } catch (e) { if (e?.name === "AbortError") throw Object.assign(new Error("Dibatalkan"), { code: "cancelled" }); throw Object.assign(new Error("Tidak bisa menghubungi server AI."), { code: "network" }); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "AI gagal membaca."), { code: j.code || "ai_error" });
    return j.text || "";
  }
  const sample = async (input, opts) => ({ text: await aiCall(input, opts) });
  sample.json = async (input, opts) => parseJ(await aiCall(input, opts));
  sample.limits = async () => ({ images: true });

  /* ---------------- files ---------------- */
  const assets = {
    async upload(file) {
      if (file.size > 20 * 1024 * 1024) throw Object.assign(new Error("too large"), { code: "too_large" });
      const name = `${me.id}/${Date.now()}-${String(file.name || "file").replace(/[^\w.\-]+/g, "_")}`;
      const { error } = await sb.storage.from("files").upload(name, file, { contentType: file.type || "application/octet-stream" });
      if (error) throw errOf(error); return { id: name };
    },
  };
  document.addEventListener("click", async (e) => {
    const a = e.target.closest && e.target.closest('a[href^="#file="]'); if (!a) return;
    e.preventDefault(); const id = decodeURIComponent(a.getAttribute("href").slice(6));
    const w = window.open("", "_blank");
    const { data, error } = await sb.storage.from("files").createSignedUrl(id, 300);
    if (error || !data?.signedUrl) { w && w.close(); alertToast("File tidak bisa dibuka."); return; }
    if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
  }, true);
  const downloads = {
    async save({ filename, data }) { const u = URL.createObjectURL(data instanceof Blob ? data : new Blob([data])); const a = document.createElement("a"); a.href = u; a.download = filename || "file"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 30000); },
  };

  /* ---------------- tanda tangan (tidak ada di repo publik) ---------------- */
  let ttdUrl = null;
  async function loadTtd() {
    if (ttdUrl || isGudang()) return ttdUrl;
    try { const r = await fetch(FN("brand"), { headers: { Authorization: "Bearer " + (await token()), apikey: CFG.key } }); if (!r.ok) return null; const j = await r.json(); ttdUrl = "data:image/png;base64," + j.ttd; } catch {}
    document.querySelectorAll('img[src="assets/ttd.png"]').forEach((i) => ttdUrl && (i.src = ttdUrl)); return ttdUrl;
  }
  const _fetch = window.fetch.bind(window);
  window.fetch = async (u, o) => { if (typeof u === "string" && /(^|\/)assets\/ttd\.png$/.test(u)) { const d = await loadTtd(); if (!d) return new Response("", { status: 404 }); return _fetch(d); } return _fetch(u, o); };
  new MutationObserver((ms) => { if (!ttdUrl) return; for (const m of ms) m.addedNodes.forEach((n) => { if (n.nodeType !== 1) return; (n.matches?.('img[src="assets/ttd.png"]') ? [n] : n.querySelectorAll?.('img[src="assets/ttd.png"]') || []).forEach((i) => (i.src = ttdUrl)); }); }).observe(document.documentElement, { childList: true, subtree: true });

  /* ---------------- window.claude shim ---------------- */
  window.claude = { use: async (name) => { await ready; return { db, user, sample, assets, downloads }[name] || null; } };

  /* ---------------- UI: login / setup ---------------- */
  function alertToast(msg) { const t = document.getElementById("toast"); if (t) { t.textContent = msg; t.hidden = false; clearTimeout(alertToast.h); alertToast.h = setTimeout(() => (t.hidden = true), 4000); } }
  async function callFn(body) {
    const r = await fetch(FN("admin-users"), { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.key, Authorization: "Bearer " + ((await token()) || CFG.key) }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || "Gagal (" + r.status + ")"); return j;
  }
  const pwField = (id, ph, ac) => `<div class="lg-pw"><input id="${id}" type="password" autocomplete="${ac}" placeholder="${ph}" required><button type="button" class="lg-eye" data-eye="${id}" aria-label="Tampilkan password">Lihat</button></div>`;
  function shell(inner) {
    let el = document.getElementById("smmLogin");
    if (!el) { el = document.createElement("div"); el.id = "smmLogin"; document.body.appendChild(el); }
    el.innerHTML = `<div class="lg-card"><div class="lg-brand"><img class="lg-logo" src="logo.svg" alt="Logo SMM"><div><b>Tracking Pengadaan</b><span>PT Sentra Mulia Mandiri</span></div></div>${inner}</div>`;
    el.querySelectorAll("[data-eye]").forEach((b) => (b.onclick = () => { const i = document.getElementById(b.dataset.eye); i.type = i.type === "password" ? "text" : "password"; b.textContent = i.type === "password" ? "Lihat" : "Sembunyi"; }));
    document.body.classList.add("lg-on"); return el;
  }
  function showLogin(msg) {
    const el = shell(`<h1>Masuk</h1><p class="lg-sub">Gunakan username dan password dari pemilik aplikasi.</p>
      <form id="lgForm" autocomplete="on"><label>Username<input id="lgUser" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <label>Password${pwField("lgPass", "", "current-password")}</label>
      <p class="lg-err" id="lgErr" role="alert">${esc(msg || "")}</p><button class="primary lg-go" id="lgGo">Masuk</button></form>
      <p class="lg-foot">Lupa password? Minta pemilik aplikasi untuk meresetnya.</p>`);
    try { const u = localStorage.getItem("smm-last-user"); if (u) { el.querySelector("#lgUser").value = u; el.querySelector("#lgPass").focus(); } else el.querySelector("#lgUser").focus(); } catch {}
    el.querySelector("#lgForm").onsubmit = async (e) => {
      e.preventDefault(); const u = el.querySelector("#lgUser").value.trim().toLowerCase(); const p = el.querySelector("#lgPass").value; const btn = el.querySelector("#lgGo"); const er = el.querySelector("#lgErr");
      if (!u || !p) { er.textContent = "Isi username dan password."; return; }
      btn.disabled = true; btn.textContent = "Memeriksa…"; er.textContent = "";
      const { error } = await sb.auth.signInWithPassword({ email: u.includes("@") ? u : `${u}@${DOMAIN}`, password: p });
      if (error) { btn.disabled = false; btn.textContent = "Masuk"; er.textContent = /invalid|credentials/i.test(error.message) ? "Username atau password salah." : /banned/i.test(error.message) ? "Akun ini dinonaktifkan. Hubungi pemilik aplikasi." : "Gagal masuk: " + error.message; return; }
      try { localStorage.setItem("smm-last-user", u); } catch {}
      afterLogin();
    };
  }
  function showSetup() {
    const el = shell(`<h1>Setup pertama</h1><p class="lg-sub">Buat akun <b>pemilik</b> aplikasi. Setelah ini, akun untuk Pimpinan, Admin dan Gudang dibuat dari menu <b>Pengguna</b>.</p>
      <form id="suForm"><label>Nama<input id="suName" required placeholder="mis. Ray"></label>
      <label>Username<input id="suUser" required autocapitalize="none" spellcheck="false" placeholder="mis. ray"></label>
      <label>Password (min. 8 karakter)${pwField("suPass", "", "new-password")}</label>
      <label>Ulangi password<input id="suPass2" type="password" autocomplete="new-password" required></label>
      <p class="lg-err" id="suErr" role="alert"></p><button class="primary lg-go" id="suGo">Buat akun pemilik</button></form>`);
    el.querySelector("#suForm").onsubmit = async (e) => {
      e.preventDefault(); const g = (i) => el.querySelector(i).value; const er = el.querySelector("#suErr"); const btn = el.querySelector("#suGo");
      if (g("#suPass") !== g("#suPass2")) { er.textContent = "Password tidak sama."; return; }
      btn.disabled = true; er.textContent = "";
      try { await callFn({ action: "bootstrap", name: g("#suName"), username: g("#suUser").trim().toLowerCase(), password: g("#suPass") });
        const { error } = await sb.auth.signInWithPassword({ email: `${g("#suUser").trim().toLowerCase()}@${DOMAIN}`, password: g("#suPass") }); if (error) throw error; afterLogin();
      } catch (x) { btn.disabled = false; er.textContent = x.message; }
    };
  }
  async function afterLogin() {
    const { data } = await sb.auth.getSession(); const uid = data?.session?.user?.id;
    if (!uid) return showLogin();
    me = { id: uid };
    try { await loadProfiles(); } catch (e) { return showLogin("Tidak bisa memuat profil: " + e.message); }
    me = profiles.find((p) => p.id === uid);
    if (!me || !me.active) { await sb.auth.signOut(); return showLogin("Akun ini belum terdaftar atau sudah dinonaktifkan."); }
    document.getElementById("smmLogin")?.remove(); document.body.classList.remove("lg-on");
    if (me.role === "gudang") document.body.classList.add("gudang-mode");
    startSync(); readyResolve(); addAccountUi(); loadTtd();
  }

  /* ---------------- akun: ganti password, keluar, pengguna ---------------- */
  function modal(html) {
    const ov = document.getElementById("overlay");
    ov.innerHTML = `<div class="scrim" data-close="1"></div><div class="modal"><div class="box" role="dialog" style="width:min(720px,100%)">${html}</div></div>`;
    return ov;
  }
  function openAccount() {
    const ov = modal(`<div class="dh"><div><div class="sub">Akun</div><h2>${esc(me.name || me.username)}</h2><div class="sub">@${esc(me.username)} · ${esc(ROLE_LBL[me.role] || me.role)}</div></div><button type="button" class="ghost" data-close="1" aria-label="Tutup">✕</button></div>
      <div class="db"><div class="sec">Ganti password</div>
        <div class="g2"><label class="f">Password baru (min. 8 karakter)<input id="acP1" type="password" autocomplete="new-password"></label><label class="f">Ulangi password baru<input id="acP2" type="password" autocomplete="new-password"></label></div>
        <div class="bar"><button type="button" class="primary" id="acSave">Simpan password</button><span class="sub" id="acMsg"></span></div></div>
      <div class="df">${me.role === "owner" ? `<button type="button" id="acUsers" style="margin-right:auto">Kelola pengguna</button>` : `<span style="margin-right:auto"></span>`}<button type="button" class="danger" id="acOut">Keluar</button></div>`);
    ov.querySelector("#acSave").onclick = async () => { const a = ov.querySelector("#acP1").value, b = ov.querySelector("#acP2").value, m = ov.querySelector("#acMsg");
      if (a.length < 8) { m.textContent = "Minimal 8 karakter."; return; } if (a !== b) { m.textContent = "Password tidak sama."; return; }
      try { await callFn({ action: "password", password: a }); m.textContent = "✓ Password diganti."; ov.querySelector("#acP1").value = ov.querySelector("#acP2").value = ""; } catch (e) { m.textContent = e.message; } };
    ov.querySelector("#acOut").onclick = async () => { await sb.auth.signOut(); location.reload(); };
    const u = ov.querySelector("#acUsers"); if (u) u.onclick = openUsers;
  }
  function genPass() { const a = "abcdefghjkmnpqrstuvwxyz23456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(10)); for (const x of r) s += a[x % a.length]; return s; }
  function openUsers() {
    if (me?.role !== "owner") return;
    const roleSel = (id, v, dis) => `<select data-urole="${id}" ${dis ? "disabled" : ""}>${dis ? `<option>Pemilik</option>` : ["approver", "admin", "gudang"].map((r) => `<option value="${r}" ${v === r ? "selected" : ""}>${ROLE_LBL[r]}</option>`).join("")}</select>`;
    const ov = modal(`<div class="dh"><div><div class="sub">Pemilik aplikasi</div><h2>Pengguna</h2></div><button type="button" class="ghost" data-close="1" aria-label="Tutup">✕</button></div>
      <div class="db">
       <p class="sub" style="margin:0"><b>Pimpinan</b>: mengisi harga tawar &amp; menyetujui quotation. <b>Admin</b>: input RFQ, harga supplier, quotation, PO, order supplier. <b>Gudang</b>: hanya daftar barang datang, tanpa harga.</p>
       <ul class="us-list" id="usList"></ul>
       <details class="us-add" id="usAddBox" ${profiles.length <= 1 ? "open" : ""}><summary>+ Tambah pengguna</summary>
        <div class="g2"><label class="f">Nama<input id="nuName" placeholder="mis. Andi Gudang"></label><label class="f">Username<input id="nuUser" autocapitalize="none" spellcheck="false" placeholder="mis. andi"></label>
         <label class="f">Password awal<span class="rpw"><input id="nuPass" style="text-align:left"><button type="button" class="ghost sm" id="nuGen">Buat acak</button></span></label>
         <label class="f">Peran<select id="nuRole"><option value="gudang">Gudang</option><option value="admin">Admin</option><option value="approver">Pimpinan / penyetuju</option></select></label></div>
        <div class="bar"><button type="button" class="primary" id="nuSave">Buat akun</button><span class="sub" id="nuMsg"></span></div></details>
      </div><div class="df"><button type="button" data-close="1">Selesai</button></div>`);
    const draw = () => {
      ov.querySelector("#usList").innerHTML = profiles.map((p) => `<li class="${p.active ? "" : "off"}"><div class="us-m"><b>${esc(p.name || p.username)}</b>${p.id === me.id ? " <span class=\"sub\">(Anda)</span>" : ""}<span class="sub">@${esc(p.username)}${p.active ? "" : " · nonaktif"}</span></div>
        <div class="us-a">${roleSel(p.id, p.role, p.role === "owner")}${p.role === "owner" ? "" : `<button type="button" class="sm" data-ureset="${p.id}">Reset password</button><button type="button" class="sm ${p.active ? "danger" : ""}" data-uact="${p.id}">${p.active ? "Nonaktifkan" : "Aktifkan"}</button>`}</div>
        <div class="us-r" id="ur_${p.id}"></div></li>`).join("");
      ov.querySelectorAll("[data-urole]").forEach((s) => (s.onchange = () => act({ action: "update", id: s.dataset.urole, role: s.value }, "Peran diubah.")));
      ov.querySelectorAll("[data-uact]").forEach((b) => (b.onclick = () => { const p = profiles.find((x) => x.id === b.dataset.uact); act({ action: "update", id: p.id, active: !p.active }, p.active ? "Akun dinonaktifkan." : "Akun diaktifkan."); }));
      ov.querySelectorAll("[data-ureset]").forEach((b) => (b.onclick = () => { const id = b.dataset.ureset; const box = ov.querySelector("#ur_" + id); const pw = genPass();
        box.innerHTML = `<div class="bar"><input id="rp_${id}" value="${pw}" style="max-width:200px"><button type="button" class="sm primary" id="rs_${id}">Simpan password baru</button><span class="sub">Berikan password ini ke orangnya.</span></div>`;
        box.querySelector("#rs_" + id).onclick = async () => { const v = box.querySelector("#rp_" + id).value; try { await callFn({ action: "password", id, password: v }); box.innerHTML = `<span class="ok-tag">✓ Password baru: <b>${esc(v)}</b></span>`; } catch (e) { box.innerHTML = `<span class="late-tag">${esc(e.message)}</span>`; } }; }));
    };
    const act = async (body, ok) => { try { await callFn(body); await loadProfiles(); draw(); alertToast(ok); } catch (e) { alertToast(e.message); await loadProfiles().catch(() => {}); draw(); } };
    ov.querySelector("#nuGen").onclick = () => (ov.querySelector("#nuPass").value = genPass());
    ov.querySelector("#nuPass").value = genPass();
    ov.querySelector("#nuSave").onclick = async () => {
      const g = (i) => ov.querySelector(i).value.trim(); const m = ov.querySelector("#nuMsg"); const b = ov.querySelector("#nuSave");
      if (!g("#nuName") || !g("#nuUser")) { m.textContent = "Isi nama dan username."; return; }
      b.disabled = true; m.textContent = "Membuat akun…";
      try { const u = g("#nuUser").toLowerCase(), pw = g("#nuPass"); await callFn({ action: "create", name: g("#nuName"), username: u, password: pw, role: g("#nuRole") }); await loadProfiles(); draw();
        m.innerHTML = `<span class="ok-tag">✓ Akun dibuat. Username: <b>${esc(u)}</b> · Password: <b>${esc(pw)}</b></span>`; ov.querySelector("#nuName").value = ""; ov.querySelector("#nuUser").value = ""; ov.querySelector("#nuPass").value = genPass();
      } catch (e) { m.innerHTML = `<span class="late-tag">${esc(e.message)}</span>`; } finally { b.disabled = false; }
    };
    draw(); loadProfiles().then(draw).catch(() => {});
  }
  function addAccountUi() {
    const acts = document.querySelector("header .actions");
    if (acts && !document.getElementById("btnAcct")) { const b = document.createElement("button"); b.type = "button"; b.id = "btnAcct"; b.textContent = "Akun"; b.onclick = openAccount; acts.insertBefore(b, acts.querySelector("#btnNew")); }
    const rb = document.getElementById("btnRoles"); if (rb) { rb.textContent = "Pengguna"; rb.onclick = openUsers; }
    window.openRoles = openUsers;
    const ms = document.querySelector("#moreSheet .mg:last-of-type");
    if (ms && !document.getElementById("msAcct")) { const b = document.createElement("button"); b.type = "button"; b.id = "msAcct"; b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>Akun &amp; keluar`; b.onclick = () => { document.getElementById("moreSheet").classList.remove("open"); openAccount(); }; ms.appendChild(b); }
    const msR = document.getElementById("msRoles"); if (msR) msR.lastChild.textContent = "Pengguna";
    if (me.role === "gudang") { // tombol akun untuk gudang (header aksi disembunyikan di mode gudang)
      const bar = document.createElement("button"); bar.type = "button"; bar.id = "gudAcct"; bar.className = "sm"; bar.textContent = (me.name || me.username) + " · Akun"; bar.onclick = openAccount; document.querySelector("header .app-top")?.appendChild(bar);
    }
  }

  /* ---------------- versi baru ---------------- */
  const BUILD = document.querySelector('meta[name="smm-build"]')?.content || "";
  async function checkUpdate() {
    if (!BUILD) return;
    try {
      const t = await _fetch("index.html?cb=" + Date.now(), { cache: "no-store" }).then((r) => r.text());
      const m = t.match(/name="smm-build" content="(\d+)"/);
      if (m && m[1] !== BUILD && !document.getElementById("smmUpd")) {
        const b = document.createElement("div"); b.id = "smmUpd";
        b.innerHTML = `<span>Versi baru aplikasi tersedia.</span><button type="button">Muat ulang</button>`;
        b.querySelector("button").onclick = () => location.reload();
        document.body.appendChild(b);
      }
    } catch {}
  }
  setInterval(checkUpdate, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkUpdate(); });

  /* ---------------- start ---------------- */
  (async () => {
    if (!CFG.url || !CFG.key) { shell(`<h1>Belum dikonfigurasi</h1><p class="lg-sub">Isi alamat dan kunci Supabase di config.js.</p>`); return; }
    const { data } = await sb.auth.getSession();
    if (data?.session) return afterLogin();
    let setup = false; try { const r = await sb.rpc("needs_setup"); setup = r.data === true; } catch {}
    setup ? showSetup() : showLogin();
  })();
  sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT" && me) location.reload(); });
})();
