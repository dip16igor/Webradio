"use strict";
// Базовый путь: за Caddy страница живёт под /scanner/, напрямую — под /.
const BASE = location.pathname.replace(/[^/]*$/, "");
const api = (p) => BASE + "api/" + p;
const $ = (id) => document.getElementById(id);
const state = { offset: 0, limit: 50, total: 0, selected: new Set(), playingId: null };
const player = $("player");

function showErr(msg) {
  const e = $("err");
  e.textContent = msg;
  e.classList.remove("hidden");
  setTimeout(() => e.classList.add("hidden"), 6000);
}

async function jget(path) {
  const r = await fetch(api(path));
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function jpost(path, body) {
  const r = await fetch(api(path), { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function filters() {
  const p = new URLSearchParams();
  if ($("q").value.trim()) p.set("q", $("q").value.trim());
  if ($("genre").value) p.set("genre", $("genre").value);
  if ($("approved").value) p.set("approved", $("approved").value);
  if ($("alive").checked) p.set("alive", "1");
  if ($("showHidden").checked) p.set("blacklisted", "1");
  p.set("sort", $("sort").value);
  p.set("limit", state.limit);
  p.set("offset", state.offset);
  return p.toString();
}

function streamCell(r) {
  const parts = [r.codec || "?", r.bitrate ? r.bitrate + "k" : "?"];
  if (r.samplerate) parts.push((r.samplerate / 1000).toFixed(1) + "кГц");
  if (r.channels === 2) parts.push("Stereo"); else if (r.channels === 1) parts.push("Mono");
  let s = `<span class="badge ${r.lastcheckok ? "ok" : "bad"}">${parts.join(" · ")}</span>`;
  if (r.auth_walled) s += ' <span class="badge warn">auth</span>';
  if (r.fail_count) s += ` <span class="badge bad">fail×${r.fail_count}</span>`;
  return s;
}
function normCountry(s) {
  const t = (s || "").toLowerCase().replace(/^the\s+/, "").trim();
  return { "russian federation": "russia", "united states of america": "united states",
           "republic of korea": "south korea", "republic of north macedonia": "north macedonia" }[t] || t;
}
function geoCell(r) {
  if (!r.country && !r.city) return '<span class="badge">?</span>';
  let s = esc([r.country, r.city].filter(Boolean).join(", "));
  if (r.station_country && normCountry(r.station_country) !== normCountry(r.country))
    s += `<br><small style="color:var(--mut)">заявл.: ${esc(r.station_country)}</small>`;
  return s;
}
function genreCell(r) {
  const WL = ["ambient", "chill", "chillout", "downtempo", "electronic", "jazz", "lofi",
              "lounge", "nature", "pop", "radio", "relax", "rock", "trip-hop"];
  const cur = r.genre || "";
  let opts = WL.map((g) => `<option value="${g}"${g === cur ? " selected" : ""}>${g}</option>`).join("");
  if (cur && !WL.includes(cur))
    opts += `<option value="${esc(cur)}" selected>${esc(cur)} ?</option>`;
  else if (!cur)
    opts = `<option value="" selected disabled>?</option>` + opts;
  return `<select class="genre-sel" data-id="${r.id}" data-prev="${esc(cur)}">${opts}</select>`;
}
function adsCell(r) {
  if (r.ads_score >= 60) return `<span class="badge bad">ads ${r.ads_score}</span>`;
  if (r.ads_score > 0) return `<span class="badge warn">ads ${r.ads_score}</span>`;
  return `<span class="badge ok">0</span>`;
}

function hostOf(url) { try { return new URL(url).hostname; } catch { return url; } }

async function load() {
  try {
    const d = await jget("stations?" + filters());
    state.total = d.total;
    const tb = $("rows");
    tb.innerHTML = "";
    for (const r of d.rows) {
      const tr = document.createElement("tr");
      if (r.id === state.playingId) tr.classList.add("playing");
      tr.innerHTML =
        `<td><input type="checkbox" data-id="${r.id}" ${state.selected.has(r.id) ? "checked" : ""}></td>` +
        `<td class="st"><b>${esc(r.name || r.url)}</b><small>${esc(hostOf(r.url))}</small>` +
        (r.streamtitle ? `<div class="track">♪ ${esc(r.streamtitle)}</div>` : "") +
        (r.approved ? ' <span class="badge appr">approved</span>' : "") +
        (r.blacklisted ? ' <span class="badge bad">скрыта</span>' : "") +
        (/\.m3u8($|\?)/i.test(r.url || "") ? ' <span class="badge warn">HLS</span>' : "") + `</td>` +
        `<td>${genreCell(r)}</td>` +
        `<td>${streamCell(r)}</td>` +
        `<td>${geoCell(r)}</td>` +
        `<td>${adsCell(r)}</td>` +
        `<td><small>${esc((r.lastcheck || "").replace("T", " "))}<br>${r.lastcheckok ? "OK" : "FAIL"}</small></td>` +
        `<td><button class="play ghost" data-id="${r.id}" data-url="${esc(r.play_url || r.url)}">▶</button> <button class="add ghost" data-id="${r.id}" title="Добавить в конец списка WebRadio">+</button></td>`;
      tb.appendChild(tr);
    }
    $("count").textContent = `Показано ${d.rows.length} из ${d.total} (отмечено: ${state.selected.size})`;
    const pages = Math.max(1, Math.ceil(d.total / state.limit));
    $("page").textContent = `${Math.floor(state.offset / state.limit) + 1} / ${pages}`;
  } catch (e) { showErr("Загрузка: " + e.message); }
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

async function loadStatus() {
  try {
    const s = await jget("status");
    $("chips").innerHTML =
      `<span class="chip">всего <b>${s.total}</b></span>` +
      `<span class="chip">живых <b>${s.alive}</b></span>` +
      `<span class="chip">жанров <b>${s.genres}</b></span>` +
      `<span class="chip">approved <b>${s.approved}</b></span>` +
      (s.last_check ? `<span class="chip">чек <b>${esc(s.last_check.replace("T", " "))}</b></span>` : "");
    const sc = s.scan;
    const pb = $("progress");
    if (sc.running) {
      pb.classList.remove("hidden");
      const pct = sc.total ? Math.round(100 * sc.done / sc.total) : 0;
      $("bar").style.width = pct + "%";
      $("plabel").textContent = `Скан${sc.mode ? " (" + sc.mode + ")" : ""}: ${sc.done}/${sc.total}`;
      $("scanBtn").disabled = true;
      setTimeout(loadStatus, 2000);
      if (sc.done === sc.total && sc.total > 0) setTimeout(load, 500);
    } else {
      pb.classList.add("hidden");
      $("scanBtn").disabled = false;
      if (sc.total) { load(); loadGenres(); }
    }
  } catch (e) { /* тихо */ }
}
async function loadGenres() {
  try {
    const g = await jget("genres");
    const sel = $("genre"), cur = sel.value;
    sel.innerHTML = '<option value="">Жанр: все</option>' +
      g.map((x) => `<option value="${esc(x.genre)}">${esc(x.genre)} (${x.n})</option>`).join("");
    sel.value = cur;
  } catch (e) { /* тихо */ }
}

$("scanBtn").onclick = async () => {
  try {
    await jpost("scan", { limit: parseInt($("limit").value) || 200 });
    loadStatus();
  } catch (e) { showErr("Скан: " + e.message); }
};
$("exportBtn").onclick = async () => {
  try {
    const p = new URLSearchParams(filters());
    p.delete("limit"); p.delete("offset"); p.set("limit", 500);
    const d = await jget("export?" + p.toString());
    $("expText").value = JSON.stringify(d.stations, null, 2);
    $("modal").classList.remove("hidden");
  } catch (e) { showErr("Экспорт: " + e.message); }
};
$("closeBtn").onclick = () => $("modal").classList.add("hidden");
$("copyBtn").onclick = async () => {
  $("expText").select();
  try { await navigator.clipboard.writeText($("expText").value); $("copyBtn").textContent = "Готово ✓"; }
  catch { document.execCommand("copy"); }
  setTimeout(() => ($("copyBtn").textContent = "Копировать"), 1500);
};
$("approveBtn").onclick = async () => {
  if (!state.selected.size) return showErr("Ничего не отмечено");
  try {
    const r = await jpost("approve", { ids: [...state.selected] });
    state.selected.clear();
    load();
    loadStatus();
  } catch (e) { showErr("Approve: " + e.message); }
};
function getToken() {
  // Station Manager кладёт токен в secret_token — origin общий, читаем его же.
  return localStorage.getItem("secret_token") || localStorage.getItem("webradio_token") || "";
}
function pushOne(id, btn) {
  const token = getToken();
  if (!token) { // токена ещё нигде нет — спросить один раз через модалку
    state.pendingPush = [id];
    $("pushText").textContent = "В конец списка WebRadio добавится 1 станция.";
    $("pushResult").textContent = "";
    $("pushToken").value = "";
    $("pushModal").classList.remove("hidden");
    return;
  }
  btn.disabled = true;
  jpost("push", { ids: [id], token }).then((r) => {
    if (r.added_n) { btn.textContent = "✓"; btn.title = "В списке WebRadio"; }
    else if (r.skipped_dup.length) { btn.textContent = "dup"; btn.title = "Уже в списке"; }
    else if (r.skipped_auth.length) { btn.textContent = "auth"; btn.title = "Auth-walled: на ESP32 не заиграет"; }
    else showErr("Push: " + (r.errors.map((e) => e.error).join("; ") || "отклонено"));
  }).catch((e) => { showErr("Push: " + e.message); btn.disabled = false; });
}
$("pushBtn").onclick = () => {
  if (!state.selected.size) return showErr("Ничего не отмечено");
  const token = getToken();
  if (token) { // токен уже есть (введён в Station Manager) — пушим молча
    const ids = [...state.selected];
    jpost("push", { ids, token }).then((r) => {
      const parts = [`добавлено: ${r.added_n}`];
      if (r.skipped_dup.length) parts.push(`дубли: ${r.skipped_dup.length}`);
      if (r.skipped_auth.length) parts.push(`auth-walled: ${r.skipped_auth.length}`);
      if (r.errors.length) parts.push(`ошибки: ${r.errors.map((e) => e.name + " — " + e.error).join("; ")}`);
      showErr(parts.join(" · ")); // та же плашка, но как отчёт
      state.selected.clear();
      load();
    }).catch((e) => showErr("Push: " + e.message));
    return;
  }
  state.pendingPush = null;
  $("pushText").textContent = `Отмечено: ${state.selected.size} — допишутся в конец списка WebRadio (дубли и auth-walled пропускаются).`;
  $("pushResult").textContent = "";
  $("pushToken").value = localStorage.getItem("webradio_token") || "";
  $("pushModal").classList.remove("hidden");
};
$("pushCancel").onclick = () => $("pushModal").classList.add("hidden");
$("pushGo").onclick = async () => {
  const token = $("pushToken").value.trim();
  if (!token) return showErr("Нужен токен WebRadio");
  if ($("pushRemember").checked) {
    localStorage.setItem("secret_token", token); // общий с Station Manager
    localStorage.setItem("webradio_token", token);
  }
  const ids = state.pendingPush || [...state.selected];
  state.pendingPush = null;
  $("pushGo").disabled = true;
  try {
    const r = await jpost("push", { ids, token });
    const parts = [`добавлено: ${r.added_n}`];
    if (r.skipped_dup.length) parts.push(`дубли: ${r.skipped_dup.length}`);
    if (r.skipped_auth.length) parts.push(`auth-walled: ${r.skipped_auth.length} (${r.skipped_auth.join("; ")})`);
    if (r.errors.length) parts.push(`ошибки: ${r.errors.map((e) => e.name + " — " + e.error).join("; ")}`);
    $("pushResult").textContent = parts.join(" · ");
    state.selected.clear();
    load();
  } catch (e) { showErr("Push: " + e.message); }
  $("pushGo").disabled = false;
};
$("recheckBtn").onclick = async () => {
  if (!state.selected.size) return showErr("Ничего не отмечено");
  try {
    await jpost("recheck", { ids: [...state.selected] });
    state.selected.clear();
    loadStatus();
  } catch (e) { showErr("Recheck: " + e.message); }
};

$("hideBtn").onclick = async () => {
  if (!state.selected.size) return showErr("Ничего не отмечено");
  const on = !$("showHidden").checked; // в обычном виде — скрыть; в виде скрытых — вернуть
  try {
    const r = await jpost("blacklist", { ids: [...state.selected], on });
    state.selected.clear();
    load();
  } catch (e) { showErr("Чёрный список: " + e.message); }
};
$("showHidden").addEventListener("change", () => {
  state.offset = 0; state.selected.clear();
  $("hideBtn").textContent = $("showHidden").checked ? "↩ Вернуть" : "✕ Скрыть";
  load();
});
["q", "genre", "approved", "alive", "sort"].forEach((id) => {
  $("" + id).addEventListener("change", () => { state.offset = 0; load(); });
});
let qTimer = null;
$("q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.offset = 0; load(); }, 400); });
$("prev").onclick = () => { state.offset = Math.max(0, state.offset - state.limit); load(); };
$("next").onclick = () => { if (state.offset + state.limit < state.total) { state.offset += state.limit; load(); } };
$("selAll").onchange = (e) => {
  document.querySelectorAll('#rows input[type="checkbox"]').forEach((c) => {
    const id = +c.dataset.id;
    c.checked = e.target.checked;
    e.target.checked ? state.selected.add(id) : state.selected.delete(id);
  });
  load();
};
$("rows").addEventListener("change", (e) => {
  const g = e.target.closest("select.genre-sel");
  if (g) {
    const id = +g.dataset.id, prev = g.dataset.prev || "";
    g.dataset.prev = g.value;
    jpost("genre", { id, genre: g.value }).catch((err) => {
      showErr("Жанр: " + err.message);
      g.value = prev;
    });
    return;
  }
  const c = e.target.closest('input[type="checkbox"]');
  if (!c) return;
  const id = +c.dataset.id;
  c.checked ? state.selected.add(id) : state.selected.delete(id);
  $("count").textContent = $("count").textContent.replace(/\(отмечено: \d+\)/, `(отмечено: ${state.selected.size})`);
});
function playUrl(id, url, mode) {
  const src = mode === "direct" ? url : BASE + "relay?url=" + encodeURIComponent(url);
  player.src = src;
  player.play().then(() => { state.playingId = id; load(); })
    .catch(() => {
      if (mode === "direct") playUrl(id, url, "relay"); // direct-first, затем свой релей
      else showErr("Не играет ни напрямую, ни через релей — битая ссылка или защита апстрима (HLS тоже пока не играется).");
    });
}
$("rows").addEventListener("click", (e) => {
  const a = e.target.closest("button.add");
  if (a) { pushOne(+a.dataset.id, a); return; }
  const b = e.target.closest("button.play");
  if (!b) return;
  const id = +b.dataset.id, url = b.dataset.url;
  if (state.playingId === id) { player.pause(); state.playingId = null; load(); return; }
  playUrl(id, url, url.startsWith("https://") ? "direct" : "relay");
});
player.onended = player.onerror = () => { state.playingId = null; load(); };

loadGenres();
load();
loadStatus();
