/* soapcopy.js（欄埋め込み版）— 元の「SOAP下書き」欄に S/O/A/P 別のコピーボタンを付ける
 * app.js の末尾（settings.js の後ろ）に追記して使う。app.js 本体は書き換えない。
 *  - S・O・A・P それぞれの見出しの横に「コピー」ボタン。押すとその欄だけがクリップボードへ
 *  - 右上の「コピー」は「全体コピー」になり、S: …／O: …／A: …／P: … の形で全部をコピー（元と同じ書式）
 *  - 欄の文章はクリックしてその場で直せる。直した後の文面がコピーされる
 *  - カルテに貼りやすいよう、** や # などの記号を除き、行頭の「- 」は「・」にする
 *  - 評価(A)の「（※AI生成・要確認）」は、コピーするときだけ取り除く（画面の表示は残る）
 *    → 取り除きたくない場合は、下の STRIP_AI_MARK を false にする
 *  - ショートカット: Alt+1=S  Alt+2=O  Alt+3=A  Alt+4=P  Alt+0=全体
 */
(function () {
  "use strict";
  if (window.__soapCopyInlineLoaded) return;
  window.__soapCopyInlineLoaded = true;

  var STRIP_AI_MARK = true;
  var KEYS = ["S", "O", "A", "P"];

  /* ---------- 文面の整形 ---------- */
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

  function clean(s, key) {
    var t = String(s)
      .replace(/\r\n?/g, "\n")
      .replace(/ /g, " ")
      .replace(/\*\*|__|`/g, "")
      .replace(/^[ \t]*#{1,6}[ \t]*/gm, "")
      .replace(/^[ \t]*[-*•][ \t]+/gm, "・");
    if (STRIP_AI_MARK && key === "A") {
      t = t.replace(/[（(][ \t]*※[ \t]*AI生成[^）)\n]*[）)]/g, "");
    }
    return t
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
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

  function say(text) {
    var st = document.getElementById("status");
    if (st) st.textContent = text;
  }

  /* ---------- 各欄の現在の文面（直した場合は直した後） ---------- */
  function items() {
    var box = document.getElementById("soap");
    return box ? Array.prototype.slice.call(box.querySelectorAll(".soap-item")) : [];
  }
  function bodyEl(item) {
    return item.querySelector(".soap-text, .warn-a");
  }
  function sectionText(i) {
    var item = items()[i];
    if (!item) return "";
    var el = bodyEl(item);
    var key = KEYS[i];
    if (el && el.dataset.scDirty === "1") return clean(el.innerText || el.textContent || "", key);
    var raw = window._soap ? window._soap[key] : null;
    if (raw != null) return clean(toText(raw), key);
    return el ? clean(el.innerText || el.textContent || "", key) : "";
  }

  /* ---------- コピー動作 ---------- */
  function markDone(btn) {
    btn.textContent = "✓ コピー済";
    btn.classList.add("sc-done");
  }

  function copySection(i, btn) {
    var t = sectionText(i);
    if (!t) { say(KEYS[i] + " は空です"); return; }
    copyText(t).then(function () {
      if (btn) markDone(btn);
      say(KEYS[i] + " をコピーしました");
    }, function () { say("コピーできませんでした。文章を選択して Ctrl+C を押してください"); });
  }

  function copyAll() {
    if (!window._soap && !items().length) return;
    var lines = [];
    KEYS.forEach(function (k, i) { lines.push(k + ": " + sectionText(i)); });
    copyText(lines.join("\n")).then(function () {
      items().forEach(function (it) {
        var b = it.querySelector(".sc-btn");
        if (b) markDone(b);
      });
      say("SOAPをコピーしました");
    }, function () { say("コピーできませんでした"); });
  }

  /* ---------- 画面への埋め込み ---------- */
  function addStyle() {
    if (document.getElementById("sc-style")) return;
    var st = document.createElement("style");
    st.id = "sc-style";
    st.textContent =
      ".sc-btn{background:#E2E8F0;color:#334155;border:0;border-radius:6px;padding:2px 10px;margin-left:10px;font-size:12px;cursor:pointer;vertical-align:middle}" +
      ".sc-btn:hover{background:#CBD5E1}" +
      ".sc-btn.sc-done{background:#DCFCE7;color:#166534}" +
      "#soap .soap-text,#soap .warn-a{white-space:pre-wrap}" +
      "#soap [contenteditable]:focus{outline:2px solid #93C5FD;outline-offset:2px;border-radius:4px}";
    document.head.appendChild(st);
  }

  function enhance() {
    addStyle();
    items().forEach(function (item, i) {
      if (i > 3 || item.querySelector(".sc-btn")) return;
      var label = item.querySelector(".soap-label");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sc-btn";
      btn.textContent = "コピー";
      btn.title = KEYS[i] + " だけをコピー（Alt+" + (i + 1) + "）";
      btn.addEventListener("click", function () { copySection(i, btn); });
      if (label) label.insertAdjacentElement("afterend", btn); else item.insertBefore(btn, item.firstChild);

      var el = bodyEl(item);
      if (el) {
        el.setAttribute("contenteditable", "true");
        el.setAttribute("spellcheck", "false");
        el.title = "クリックして直せます（直した後の文面がコピーされます）";
        el.addEventListener("input", function () {
          el.dataset.scDirty = "1";
          btn.textContent = "コピー";
          btn.classList.remove("sc-done");
        });
      }
    });
    relabelTop();
  }

  // 元の右上ボタンは「全体コピー」と分かる表示にする
  function relabelTop() {
    var top = document.querySelector(".panel h2 .copy-btn");
    if (top) { top.textContent = "全体コピー"; top.title = "S・O・A・P をまとめてコピー（Alt+0）"; }
  }
  relabelTop();

  /* ---------- 元の関数を包む（元の処理はそのまま呼ぶ） ---------- */
  var origRender = window.renderSOAP;
  if (typeof origRender === "function") {
    window.renderSOAP = function () {
      var r = origRender.apply(this, arguments);
      try { enhance(); } catch (e) { /* 埋め込みに失敗しても本来の表示は変えない */ }
      return r;
    };
  }
  window.copySOAP = function () { copyAll(); };

  document.addEventListener("keydown", function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!items().length) return;
    var map = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3 };
    if (map[e.code] !== undefined) {
      e.preventDefault();
      var b = items()[map[e.code]] && items()[map[e.code]].querySelector(".sc-btn");
      copySection(map[e.code], b);
    } else if (e.code === "Digit0" || e.code === "Numpad0") {
      e.preventDefault();
      copyAll();
    }
  });
})();
