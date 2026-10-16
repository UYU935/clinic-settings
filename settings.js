/* ===== 外来診療アシスト 設定機能（ルール／カスタムプロンプト） =====
   app.js の末尾に追記して使います（app.js 本体は書き換えません）。
   ・右下の「設定」ボタンから、行為漏れチェックのルールとAIへの追加指示を編集できます。
   ・設定はこのブラウザ(端末)に保存されます。
   ・/analyze への送信時に、保存した設定へ自動で差し替えます。 */
(function () {
  "use strict";

  var RULES_KEY = "clinic-rules";
  var PROMPT_KEY = "clinic-custom-prompt";
  var CATEGORIES = ["処方", "検査", "処置", "指示", "連携", "その他"];

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  // app.js に書かれている既定ルールをそのまま初期値として使う
  var DEFAULT_RULES = [];
  try { DEFAULT_RULES = clone(RULES); } catch (e) { DEFAULT_RULES = []; }

  function loadRules() {
    try {
      var s = localStorage.getItem(RULES_KEY);
      if (s) {
        var p = JSON.parse(s);
        if (Array.isArray(p)) return p;
      }
    } catch (e) {}
    return clone(DEFAULT_RULES);
  }
  function saveRules(rules) {
    try { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); return true; } catch (e) { return false; }
  }
  function loadPrompt() {
    try { return localStorage.getItem(PROMPT_KEY) || ""; } catch (e) { return ""; }
  }
  function savePrompt(t) {
    try { localStorage.setItem(PROMPT_KEY, t); return true; } catch (e) { return false; }
  }

  // ---- /analyze 送信時に、保存済みの設定へ差し替える ----
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === "string" ? input : ((input && input.url) || "");
      if (/\/analyze(\?|$)/.test(url) && init && typeof FormData !== "undefined" && init.body instanceof FormData) {
        init.body.set("rules", JSON.stringify(loadRules()));
        init.body.set("custom_prompt", loadPrompt());
      }
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  // ---- 画面部品 ----
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") n.textContent = attrs[k];
        else if (k === "style") n.style.cssText = attrs[k];
        else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), attrs[k]);
        else n.setAttribute(k, attrs[k]);
      });
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  var css =
    "#cs-open{position:fixed;right:16px;bottom:16px;z-index:9998;padding:10px 16px;border:1px solid #cbd5e1;border-radius:999px;background:#fff;color:#334155;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15)}" +
    "#cs-open:hover{background:#f1f5f9}" +
    "#cs-overlay{position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);display:none;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px}" +
    "#cs-modal{background:#fff;color:#0f172a;width:100%;max-width:760px;border-radius:12px;padding:20px 22px;box-shadow:0 10px 40px rgba(0,0,0,.3);font-size:14px;line-height:1.5}" +
    "#cs-modal h2{margin:0 0 4px;font-size:20px}" +
    "#cs-modal h3{margin:20px 0 4px;font-size:16px}" +
    "#cs-modal .cs-note{color:#64748b;font-size:12.5px;margin:0 0 8px}" +
    "#cs-modal input[type=text],#cs-modal textarea,#cs-modal select{box-sizing:border-box;width:100%;border:1px solid #cbd5e1;border-radius:6px;padding:7px 9px;font-size:14px;font-family:inherit;background:#fff;color:#0f172a}" +
    "#cs-modal textarea{resize:vertical}" +
    ".cs-rule{border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin:8px 0;background:#f8fafc}" +
    ".cs-rule label{display:block;font-size:12px;color:#475569;margin:6px 0 2px}" +
    ".cs-row{display:flex;gap:10px;align-items:flex-end}" +
    ".cs-row>div{flex:1}" +
    ".cs-btn{padding:8px 14px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;color:#334155;font-size:14px;cursor:pointer}" +
    ".cs-btn:hover{background:#f1f5f9}" +
    ".cs-primary{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}" +
    ".cs-primary:hover{background:#1d4ed8}" +
    ".cs-danger{color:#b91c1c;border-color:#fecaca}" +
    ".cs-danger:hover{background:#fef2f2}" +
    "#cs-msg{min-height:20px;margin-top:10px;font-size:13px;font-weight:600}" +
    ".cs-foot{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;margin-top:14px}";

  var draft = [];
  var overlay, listBox, promptBox, msgBox;

  function setMsg(text, ok) {
    msgBox.textContent = text || "";
    msgBox.style.color = ok ? "#15803d" : "#b91c1c";
  }

  function ruleCard(rule, idx) {
    var kw = el("input", { type: "text", placeholder: "例：ロキソニン、痛み止め、NSAID" });
    kw.value = (rule.keywords || []).join("、");
    kw.addEventListener("input", function () {
      rule.keywords = kw.value.split(/[、,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      rule._kwRaw = kw.value;
    });

    var warn = el("textarea", { rows: "2", placeholder: "例：消炎鎮痛剤：腎機能・胃潰瘍・妊婦の確認" });
    warn.value = rule.warning || "";
    warn.addEventListener("input", function () { rule.warning = warn.value; });

    var cat = el("select");
    var cur = rule.category || "処方";
    var cats = CATEGORIES.indexOf(cur) >= 0 ? CATEGORIES : CATEGORIES.concat([cur]);
    cats.forEach(function (c) {
      var o = el("option", { value: c, text: c });
      if (c === cur) o.selected = true;
      cat.appendChild(o);
    });
    cat.addEventListener("change", function () { rule.category = cat.value; });

    var del = el("button", { type: "button", class: "cs-btn cs-danger", text: "削除", onclick: function () {
      draft.splice(draft.indexOf(rule), 1);
      render();
    } });

    return el("div", { class: "cs-rule" }, [
      el("label", { text: "ルール " + (idx + 1) + "　キーワード（、で区切る。どれかが会話に出ると警告を表示）" }),
      kw,
      el("label", { text: "警告文（チェックリストに表示される文）" }),
      warn,
      el("div", { class: "cs-row", style: "margin-top:6px" }, [
        el("div", {}, [el("label", { text: "分類" }), cat]),
        el("div", { style: "flex:0 0 auto" }, [del])
      ])
    ]);
  }

  function render() {
    listBox.textContent = "";
    if (draft.length === 0) {
      listBox.appendChild(el("p", { class: "cs-note", text: "ルールがありません。「＋ルールを追加」を押してください。" }));
    }
    draft.forEach(function (r, i) { listBox.appendChild(ruleCard(r, i)); });
  }

  function open() {
    draft = clone(loadRules());
    promptBox.value = loadPrompt();
    setMsg("");
    render();
    overlay.style.display = "flex";
    overlay.scrollTop = 0;
  }
  function close() { overlay.style.display = "none"; }

  function nextId() {
    var max = 0;
    draft.forEach(function (r) { var n = parseInt(r.id, 10); if (!isNaN(n) && n > max) max = n; });
    return String(max + 1);
  }

  function save() {
    var out = [];
    for (var i = 0; i < draft.length; i++) {
      var r = draft[i];
      var kws = (r.keywords || []).filter(Boolean);
      var w = (r.warning || "").trim();
      if (kws.length === 0 && !w) continue; // 空の行は無視
      if (kws.length === 0 || !w) {
        setMsg("ルール " + (i + 1) + "：キーワードと警告文の両方を入力してください。", false);
        return;
      }
      out.push({ id: String(r.id), keywords: kws, warning: w, category: r.category || "処方" });
    }
    var seen = {};
    out.forEach(function (r) { if (seen[r.id]) r.id = "x" + Date.now() + Math.random().toString(36).slice(2, 5); seen[r.id] = 1; });
    if (saveRules(out) && savePrompt(promptBox.value.trim())) {
      setMsg("保存しました。次の解析から反映されます。", true);
      setTimeout(close, 700);
    } else {
      setMsg("保存できませんでした（ブラウザの保存が無効の可能性があります）。", false);
    }
  }

  function resetDefault() {
    if (!window.confirm("ルールを初期値（app.js に書かれている内容）に戻します。追加・編集した内容は消えます。よろしいですか？")) return;
    draft = clone(DEFAULT_RULES);
    promptBox.value = "";
    render();
    setMsg("初期値に戻しました。「保存」を押すと確定します。", true);
  }

  function build() {
    var style = el("style", { text: css });
    document.head.appendChild(style);

    var openBtn = el("button", { id: "cs-open", type: "button", text: "⚙ 設定", onclick: open });
    document.body.appendChild(openBtn);

    listBox = el("div");
    promptBox = el("textarea", { rows: "5", placeholder: "例：\n・診断名を断定する表現は使わない\n・薬の用量は推測して書かない\n・略語は展開せずそのまま書く" });
    msgBox = el("div", { id: "cs-msg" });

    var modal = el("div", { id: "cs-modal", role: "dialog", "aria-modal": "true", "aria-label": "設定" }, [
      el("h2", { text: "設定" }),
      el("p", { class: "cs-note", text: "この端末のブラウザに保存されます。解析のたびに、ここで保存した内容が使われます。" }),
      el("h3", { text: "行為漏れチェックのルール" }),
      el("p", { class: "cs-note", text: "会話にキーワードが含まれると、チェックリストに警告文が出ます（キーワード一致のみで判定し、医学的判断はしません）。" }),
      listBox,
      el("button", { type: "button", class: "cs-btn", text: "＋ ルールを追加", onclick: function () {
        draft.push({ id: nextId(), keywords: [], warning: "", category: "処方" });
        render();
        var cards = listBox.querySelectorAll(".cs-rule input[type=text]");
        if (cards.length) cards[cards.length - 1].focus();
      } }),
      el("h3", { text: "AIへの追加指示・禁止事項（カスタムプロンプト）" }),
      el("p", { class: "cs-note", text: "SOAP作成のAIへの指示の末尾に追記されます。「〜しない」といった禁止事項もここに書けます。" }),
      promptBox,
      msgBox,
      el("div", { class: "cs-foot" }, [
        el("button", { type: "button", class: "cs-btn cs-danger", text: "初期値に戻す", onclick: resetDefault }),
        el("div", { style: "display:flex;gap:8px" }, [
          el("button", { type: "button", class: "cs-btn", text: "キャンセル", onclick: close }),
          el("button", { type: "button", class: "cs-btn cs-primary", text: "保存", onclick: save })
        ])
      ])
    ]);

    overlay = el("div", { id: "cs-overlay" }, [modal]);
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.style.display === "flex") close();
    });
  }

  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build);

  // 確認用（コンソールから getRules() 等で現在の設定を見られる）
  window.getRules = loadRules;
  window.getCustomPrompt = loadPrompt;
})();
