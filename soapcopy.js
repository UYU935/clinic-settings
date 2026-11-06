/* soapcopy.js — SOAP を S/O/A/P 別にコピーできる浮動パネル（app.js の末尾に追記して使う）
 * - /analyze の応答に含まれる soap を受け取り、画面左下にパネルを出す
 * - 各欄の「コピー」ボタンでその欄だけをクリップボードへ（電子カルテの欄ごとに貼り付けられる）
 * - 「全部コピー」は見出し付きで S→O→A→P をまとめてコピー
 * - ショートカット: Alt+1=S  Alt+2=O  Alt+3=A  Alt+4=P  Alt+0=全部
 * - 欄の中身は編集できる（編集後の文面がコピーされる）
 * - main.py の変更・サービスの再起動は不要。settings.js とは独立して動く
 */
(function () {
  "use strict";
  if (window.__soapCopyLoaded) return;
  window.__soapCopyLoaded = true;

  var COLLAPSE_KEY = "clinic-soapcopy-collapsed";
  var SECTIONS = [
    { k: "S", label: "S 主観" },
    { k: "O", label: "O 客観" },
    { k: "A", label: "A 評価" },
    { k: "P", label: "P 計画" }
  ];

  /* ---------- 文面の整形 ---------- */
  function secOfKey(key) {
    var k = String(key).toLowerCase().trim();
    if (/^(s($|[^a-z])|subj)|主観/.test(k)) return "S";
    if (/^(o($|[^a-z])|obj)|客観/.test(k)) return "O";
    if (/^(a($|[^a-z])|assess)|評価|アセスメント/.test(k)) return "A";
    if (/^(p($|[^a-z])|plan)|計画|プラン|方針/.test(k)) return "P";
    return "";
  }

  function toText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      return v.map(function (x) {
        var t = toText(x).trim();
        return /^[・\-*•]/.test(t) ? t : (t ? "・" + t : "");
      }).filter(Boolean).join("\n");
    }
    if (typeof v === "object") {
      return Object.keys(v).map(function (kk) {
        var t = toText(v[kk]).trim();
        return t ? kk + "：" + t : "";
      }).filter(Boolean).join("\n");
    }
    return String(v);
  }

  // カルテの自由記載欄に貼りやすいプレーンテキストにする
  function clean(s) {
    return String(s)
      .replace(/\r\n?/g, "\n")
      .replace(/\*\*|__|`/g, "")
      .replace(/^[ \t]*#{1,6}[ \t]*/gm, "")
      .replace(/^[ \t]*[-*•][ \t]+/gm, "・")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function parseSoap(soap) {
    var out = { S: "", O: "", A: "", P: "" };
    if (soap == null) return out;
    if (typeof soap === "string") { out.S = clean(soap); return out; }
    var keys = Object.keys(soap);
    var unmapped = [];
    keys.forEach(function (key) {
      var sec = secOfKey(key);
      if (sec && !out[sec]) out[sec] = clean(toText(soap[key]));
      else if (sec) out[sec] += "\n" + clean(toText(soap[key]));
      else unmapped.push(key);
    });
    // キー名が想定外（4つで S/O/A/P と読めない）の場合は並び順で割り当てる
    if (unmapped.length && keys.length === 4 && unmapped.length === 4) {
      keys.forEach(function (key, i) { out[SECTIONS[i].k] = clean(toText(soap[key])); });
    }
    return out;
  }

  /* ---------- クリップボード ---------- */
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) resolve(); else reject(new Error("copy failed"));
      } catch (e) {
        document.body.removeChild(ta);
        reject(e);
      }
    });
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }

  /* ---------- パネル ---------- */
  var panel, body, msg, areas = {}, btns = {}, collapsedBtn;

  function getCollapsed() { try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch (e) { return false; } }
  function setCollapsed(v) { try { localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0"); } catch (e) {} }

  function flash(text, bad) {
    msg.textContent = text;
    msg.style.color = bad ? "#b91c1c" : "#15803d";
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { msg.textContent = ""; }, 2500);
  }

  function markCopied(k) {
    var b = btns[k];
    if (!b) return;
    b.textContent = "✓ コピー済";
    b.classList.add("sc-done");
  }
  function resetMarks() {
    SECTIONS.forEach(function (s) {
      btns[s.k].textContent = "コピー";
      btns[s.k].classList.remove("sc-done");
    });
  }

  function copySection(k) {
    var t = areas[k].value.trim();
    if (!t) { flash(k + " は空です", true); return; }
    copyText(t).then(function () {
      markCopied(k);
      flash(k + " をコピーしました");
    }, function () { flash("コピーできませんでした。欄を選択して Ctrl+C を押してください", true); });
  }

  function copyAll() {
    var parts = [];
    SECTIONS.forEach(function (s) {
      var t = areas[s.k].value.trim();
      if (t) parts.push("【" + s.k + "】\n" + t);
    });
    if (!parts.length) { flash("コピーする内容がありません", true); return; }
    copyText(parts.join("\n\n")).then(function () {
      SECTIONS.forEach(function (s) { if (areas[s.k].value.trim()) markCopied(s.k); });
      flash("全部をコピーしました");
    }, function () { flash("コピーできませんでした", true); });
  }

  function applyCollapsed() {
    var c = getCollapsed();
    body.style.display = c ? "none" : "block";
    collapsedBtn.textContent = c ? "＋" : "－";
    collapsedBtn.title = c ? "開く" : "たたむ";
  }

  function build() {
    if (panel) return;
    var st = document.createElement("style");
    st.textContent =
      "#sc-panel{position:fixed;left:16px;bottom:16px;z-index:9990;width:360px;max-width:calc(100vw - 32px);max-height:80vh;overflow:auto;background:#fff;color:#0f172a;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.22);font:14px/1.5 -apple-system,'Segoe UI','Yu Gothic UI','Meiryo',sans-serif;display:none}" +
      "#sc-panel *{box-sizing:border-box}" +
      "#sc-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #e2e8f0;position:sticky;top:0;background:#f8fafc;border-radius:12px 12px 0 0}" +
      "#sc-head b{flex:1;font-size:14px}" +
      "#sc-panel button{font:inherit;cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:8px;padding:4px 10px}" +
      "#sc-panel button:hover{background:#f1f5f9}" +
      "#sc-panel button.sc-all{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}" +
      "#sc-panel button.sc-all:hover{background:#1d4ed8}" +
      "#sc-panel button.sc-done{background:#dcfce7;border-color:#86efac;color:#166534}" +
      "#sc-body{padding:8px 10px 10px}" +
      ".sc-row{margin-bottom:8px}" +
      ".sc-row-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:3px}" +
      ".sc-row-h span{font-weight:700;font-size:13px}" +
      "#sc-panel textarea{width:100%;min-height:58px;resize:vertical;border:1px solid #cbd5e1;border-radius:8px;padding:6px 8px;font:inherit;line-height:1.45;color:#0f172a;background:#fff}" +
      "#sc-msg{min-height:18px;font-size:12px;margin-top:2px}" +
      "#sc-hint{font-size:11px;color:#64748b}";
    document.head.appendChild(st);

    panel = document.createElement("div");
    panel.id = "sc-panel";

    var head = document.createElement("div");
    head.id = "sc-head";
    var title = document.createElement("b");
    title.textContent = "SOAP をコピー";
    var allBtn = document.createElement("button");
    allBtn.className = "sc-all";
    allBtn.textContent = "全部コピー";
    allBtn.title = "Alt+0";
    allBtn.addEventListener("click", copyAll);
    collapsedBtn = document.createElement("button");
    collapsedBtn.addEventListener("click", function () { setCollapsed(!getCollapsed()); applyCollapsed(); });
    var closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.title = "閉じる";
    closeBtn.addEventListener("click", hide);
    head.appendChild(title); head.appendChild(allBtn); head.appendChild(collapsedBtn); head.appendChild(closeBtn);

    body = document.createElement("div");
    body.id = "sc-body";
    SECTIONS.forEach(function (s, i) {
      var row = document.createElement("div");
      row.className = "sc-row";
      var h = document.createElement("div");
      h.className = "sc-row-h";
      var lb = document.createElement("span");
      lb.textContent = s.label;
      var b = document.createElement("button");
      b.textContent = "コピー";
      b.title = "Alt+" + (i + 1);
      b.addEventListener("click", function () { copySection(s.k); });
      h.appendChild(lb); h.appendChild(b);
      var ta = document.createElement("textarea");
      ta.setAttribute("aria-label", s.label);
      ta.addEventListener("input", function () { b.textContent = "コピー"; b.classList.remove("sc-done"); });
      row.appendChild(h); row.appendChild(ta);
      body.appendChild(row);
      areas[s.k] = ta; btns[s.k] = b;
    });
    msg = document.createElement("div");
    msg.id = "sc-msg";
    var hint = document.createElement("div");
    hint.id = "sc-hint";
    hint.textContent = "Alt+1〜4 で S・O・A・P、Alt+0 で全部。欄は直接編集できます。";
    body.appendChild(msg); body.appendChild(hint);

    panel.appendChild(head); panel.appendChild(body);
    document.body.appendChild(panel);
    applyCollapsed();
  }

  function show(soap) {
    build();
    var d = parseSoap(soap);
    SECTIONS.forEach(function (s) { areas[s.k].value = d[s.k]; });
    resetMarks();
    msg.textContent = "";
    panel.style.display = "block";
  }
  function hide() { if (panel) panel.style.display = "none"; }

  /* ---------- /analyze の応答を横取りして表示 ---------- */
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var p = origFetch.apply(this, arguments);
    if (!/\/analyze(\?|$)/.test(url)) return p;
    return p.then(function (res) {
      try {
        if (res && res.ok) {
          res.clone().json().then(function (data) {
            if (data && (data.soap || data.SOAP)) show(data.soap || data.SOAP);
          }).catch(function () {});
        }
      } catch (e) { /* 失敗しても本来の動作は変えない */ }
      return res;
    });
  };

  /* ---------- ショートカットと「次の患者」での片付け ---------- */
  document.addEventListener("keydown", function (e) {
    if (!panel || panel.style.display === "none") return;
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var map = { Digit1: "S", Digit2: "O", Digit3: "A", Digit4: "P", Numpad1: "S", Numpad2: "O", Numpad3: "A", Numpad4: "P" };
    if (map[e.code]) { e.preventDefault(); copySection(map[e.code]); }
    else if (e.code === "Digit0" || e.code === "Numpad0") { e.preventDefault(); copyAll(); }
  });

  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button") : null;
    if (!b || (panel && panel.contains(b))) return;
    if (/次の患者|次へ/.test(b.textContent || "") || b.id === "nextBtn") hide();
  }, true);

  window.getSoapCopyText = function () {
    var o = {};
    SECTIONS.forEach(function (s) { o[s.k] = areas[s.k] ? areas[s.k].value : ""; });
    return o;
  };
})();
