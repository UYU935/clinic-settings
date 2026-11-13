#!/bin/bash
# install_chunk.sh — 小分け文字起こしを入れる／戻す
#   入れる: bash install_chunk.sh
#   戻す  : bash install_chunk.sh --rollback
# 場所を変える場合: APP=/path/to/clinic-app bash install_chunk.sh
set -e
APP="${APP:-$HOME/clinic-app}"
cd "$APP" || { echo "NG: $APP がありません"; exit 1; }
PY="$APP/venv/bin/python"; [ -x "$PY" ] || PY=python3
MARK="chunk_api.register"
TS=$(date +%Y%m%d_%H%M%S)

if [ "$1" = "--rollback" ]; then
  [ -f main.py.pre_chunk ] && cp main.py.pre_chunk main.py && echo "main.py を元に戻しました"
  [ -f static/app.js.pre_chunk ] && cp static/app.js.pre_chunk static/app.js && echo "app.js を元に戻しました"
  echo "次を実行: sudo systemctl restart clinic"
  exit 0
fi

[ -f main.py ] && [ -f static/app.js ] || { echo "NG: main.py か static/app.js がありません"; exit 1; }
grep -q '^app\.mount(' main.py || { echo "NG: main.py に app.mount( の行が見つかりません。中止します"; exit 1; }
grep -qE '^model *=' main.py || { echo "NG: main.py に model = の行が見つかりません。中止します"; exit 1; }
grep -qE '^app *=' main.py || { echo "NG: main.py に app = の行が見つかりません。中止します"; exit 1; }

[ -f main.py.pre_chunk ] || cp main.py main.py.pre_chunk
[ -f static/app.js.pre_chunk ] || cp static/app.js static/app.js.pre_chunk
cp main.py "main.py.$TS.bak"; cp static/app.js "static/app.js.$TS.bak"

cat > chunk_api.py <<'PYEOF'
"""chunk_api.py — 小分け文字起こし用の受け口 /transcribe_chunk を足す追加モジュール。

main.py には「app.mount(...) の直前に1行」足すだけで使えます（install_chunk.sh が自動で行います）:
    import chunk_api; chunk_api.register(app)

- 画面（chunk.js）が録音中に 16kHz・モノラル・16bit の WAV を数十秒ごとに送ってくる
- main.py の model（faster-whisper）と hint（薬剤名のヒント）をそのまま使う
- 1つずつ順番に処理する（ロックで直列化）。ディスクには何も書かない
- 失敗しても画面側が従来方式（録音全体を送る）へ自動で戻るので、既存の /transcribe は触らない
"""
import io
import sys
import threading
import wave

import numpy as np
from fastapi import File, Form, HTTPException, UploadFile

_lock = threading.Lock()
MAX_BYTES = 8 * 1024 * 1024      # 1回の送信は8MBまで（16kHz/16bitで約4分）
PROMPT_TAIL = 80                 # 直前の文章のうち文脈に使う文字数


def _main_attr(name, default=None):
    m = sys.modules.get("main") or sys.modules.get("__main__")
    return getattr(m, name, default) if m else default


def _decode_wav(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != 16000:
            raise ValueError("WAV は 16kHz・モノラル・16bit のみ対応です")
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def register(app):
    @app.post("/transcribe_chunk")
    def transcribe_chunk(file: UploadFile = File(...), prev: str = Form("")):
        model = _main_attr("model")
        if model is None:
            raise HTTPException(status_code=503, detail="model not ready")
        data = file.file.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="chunk too large")
        try:
            audio = _decode_wav(data)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(e))
        if audio.size < 1600:     # 0.1秒未満は何もしない
            return {"text": ""}

        hint = _main_attr("hint", "") or ""
        tail = (prev or "")[-PROMPT_TAIL:]
        prompt = (str(hint) + " " + tail).strip() or None
        with _lock:
            segments, _info = model.transcribe(
                audio, language="ja", initial_prompt=prompt,
                beam_size=1, vad_filter=True,
                condition_on_previous_text=False,
            )
            text = "".join(s.text for s in segments).strip()
        return {"text": text}
PYEOF

cat > static/chunk.js <<'JSEOF'
/* chunk.js — 小分け文字起こし（app.js の末尾に追記して使う。app.js 本体は書き換えない）
 *
 * しくみ
 *  1. 録音ボタンで MediaRecorder が start() されたのを検知し、同じマイク音声を別系統で取り込む
 *  2. 無音のところ（10〜25秒ごと）で区切り、16kHz・モノラルの WAV にしてサーバーの /transcribe_chunk へ順に送る
 *  3. 録音停止後、元のアプリが /transcribe を呼ぶと、ここで横取りして「小分けの結果」を即座に返す
 *     → 待つのは最後の区間だけ（数秒）
 *  4. 小分けのどこかで失敗した場合や、結果が空の場合は、元のアプリの動き（録音全体を送る）にそのまま戻る
 *     → 最悪でも「今まで通りの速さ」。情報が失われることはない
 *
 * 切り替え: 画面左下の「小分け文字起こし: ON/OFF」ボタンで、いつでも切り替えられる（その端末のブラウザに保存）
 * サーバー側（main.py）に /transcribe_chunk が無い場合も、自動で従来方式になる
 */
(function () {
  "use strict";
  if (window.__chunkAsrLoaded) return;
  window.__chunkAsrLoaded = true;

  var AC = window.AudioContext || window.webkitAudioContext;
  if (!window.MediaRecorder || !AC) return;

  var KEY = "clinic-chunk-asr";          // "off" のとき無効
  var MIN_SEC = 10;                      // これ以上たまったら、無音を見つけて区切る
  var MAX_SEC = 25;                      // 無音が見つからなくてもここで区切る
  var SILENCE_SEC = 0.4;                 // この長さ以上の無音を「区切り」とみなす
  var MIN_TAIL_SEC = 0.25;               // 最後の端数がこれより短ければ捨てる
  var SKIP_RMS = 0.0015;                 // 区間全体がこれより小さければ送らない（無音）
  var SEND_TIMEOUT_MS = 90000;
  var TARGET_SR = 16000;

  var origFetch = window.fetch;
  var current = null;                    // 録音中のセッション
  var last = null;                       // 直近に終わった録音（/transcribe で使う）
  var sid = 0;
  var badge = null;

  function enabled() {
    try { return localStorage.getItem(KEY) !== "off"; } catch (e) { return true; }
  }
  function setEnabled(v) {
    try { localStorage.setItem(KEY, v ? "on" : "off"); } catch (e) { /* 保存できなくても動作は変えない */ }
  }
  function log() {
    try { console.log.apply(console, ["[小分け]"].concat([].slice.call(arguments))); } catch (e) { /* noop */ }
  }

  /* ---------- 画面左下の表示（ON/OFF 切り替えを兼ねる） ---------- */
  function ensureBadge() {
    if (badge || !document.body) return badge;
    var st = document.createElement("style");
    st.textContent =
      "#ck-badge{position:fixed;left:12px;bottom:12px;z-index:9980;max-width:70vw;padding:4px 10px;border:1px solid #cbd5e1;border-radius:999px;background:rgba(255,255,255,.92);color:#475569;font:12px/1.4 -apple-system,'Segoe UI','Yu Gothic UI','Meiryo',sans-serif;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.12)}" +
      "#ck-badge.ck-off{color:#94a3b8;background:#f1f5f9}" +
      "#ck-badge.ck-rec{color:#b91c1c;border-color:#fca5a5}" +
      "#ck-badge.ck-ok{color:#166534;border-color:#86efac}" +
      "#ck-badge.ck-fb{color:#92400e;border-color:#fcd34d}";
    document.head.appendChild(st);
    badge = document.createElement("button");
    badge.id = "ck-badge";
    badge.type = "button";
    badge.addEventListener("click", function () {
      if (current) return;                       // 録音中は切り替えない
      setEnabled(!enabled());
      say();
    });
    document.body.appendChild(badge);
    say();
    return badge;
  }
  function say(text, kind) {
    if (!ensureBadge()) return;
    if (!text) {
      var on = enabled();
      text = "小分け文字起こし: " + (on ? "ON" : "OFF（クリックでON）");
      kind = on ? "" : "ck-off";
    }
    badge.textContent = text;
    badge.className = kind || "";
    badge.id = "ck-badge";
    if (kind) badge.classList.add(kind);
  }

  /* ---------- 音声の処理 ---------- */
  function concat(blocks, total) {
    var out = new Float32Array(total), o = 0;
    for (var i = 0; i < blocks.length; i++) { out.set(blocks[i], o); o += blocks[i].length; }
    return out;
  }
  function resample(buf, inRate) {
    if (inRate === TARGET_SR) return buf;
    var ratio = inRate / TARGET_SR, n = Math.floor(buf.length / ratio), out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var si = Math.floor(i * ratio), ei = Math.min(buf.length, Math.ceil((i + 1) * ratio)), sum = 0, cnt = 0;
      for (var j = si; j < ei; j++) { sum += buf[j]; cnt++; }
      out[i] = cnt ? sum / cnt : 0;
    }
    return out;
  }
  function toWav(f32) {
    var n = f32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function s(o, str) { for (var i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); }
    s(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); s(8, "WAVE"); s(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, TARGET_SR, true); v.setUint32(28, TARGET_SR * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) {
      var x = Math.max(-1, Math.min(1, f32[i]));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  /* ---------- セッション（1回の録音） ---------- */
  function Session(stream) {
    var self = this;
    this.id = ++sid;
    this.ctx = new AC();
    this.sr = this.ctx.sampleRate;
    this.blocks = [];            // 今の区間のブロック
    this.chunkSamples = 0;
    this.maxRms = 0;
    this.silentSamples = 0;
    this.peak = 0.01;
    this.totalSamples = 0;
    this.idx = 0;
    this.sent = 0;
    this.texts = [];
    this.failed = null;
    this.chain = Promise.resolve();
    this.stoppedAt = 0;

    if (this.ctx.resume) this.ctx.resume();
    this.src = this.ctx.createMediaStreamSource(stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.src.connect(this.proc);
    this.proc.connect(this.mute);
    this.mute.connect(this.ctx.destination);
    this.proc.onaudioprocess = function (e) {
      try { self.feed(new Float32Array(e.inputBuffer.getChannelData(0))); }
      catch (err) { self.failed = self.failed || "音声の取り込みでエラー"; }
    };
  }

  Session.prototype.feed = function (block) {
    var sum = 0;
    for (var i = 0; i < block.length; i++) sum += block[i] * block[i];
    var rms = Math.sqrt(sum / block.length);
    this.peak = Math.max(this.peak * 0.998, rms);
    var silent = rms < Math.max(0.004, 0.15 * this.peak);

    this.blocks.push(block);
    this.chunkSamples += block.length;
    this.totalSamples += block.length;
    if (rms > this.maxRms) this.maxRms = rms;
    this.silentSamples = silent ? this.silentSamples + block.length : 0;

    var sec = this.chunkSamples / this.sr;
    if ((sec >= MIN_SEC && this.silentSamples / this.sr >= SILENCE_SEC) || sec >= MAX_SEC) {
      this.cut(false);
    }
  };

  Session.prototype.cut = function (final) {
    var self = this;
    var total = this.chunkSamples, blocks = this.blocks, maxRms = this.maxRms;
    this.blocks = []; this.chunkSamples = 0; this.silentSamples = 0; this.maxRms = 0;
    if (!total || (final && total / this.sr < MIN_TAIL_SEC)) return;
    var idx = this.idx++;
    if (maxRms < SKIP_RMS) { this.texts[idx] = ""; return; }      // 完全な無音は送らない
    var wav = toWav(resample(concat(blocks, total), this.sr));
    var secs = Math.round(total / this.sr * 10) / 10;
    this.chain = this.chain.then(function () {
      if (self.failed) return;
      var t0 = Date.now();
      return sendChunk(wav, self.texts.join("")).then(function (text) {
        self.texts[idx] = text;
        self.sent++;
        log("区間", idx + 1, secs + "秒", "→", Math.round((Date.now() - t0) / 100) / 10 + "秒で完了");
        if (current === self) say("小分け: 録音中（" + self.sent + "区間 文字起こし済）", "ck-rec");
      });
    }).catch(function (e) {
      self.failed = self.failed || ("区間" + (idx + 1) + "で失敗: " + (e && e.message ? e.message : e));
      log(self.failed);
    });
  };

  Session.prototype.finish = function () {
    try { this.proc.onaudioprocess = null; this.src.disconnect(); this.proc.disconnect(); this.mute.disconnect(); } catch (e) { /* noop */ }
    if (this.totalSamples === 0) this.failed = this.failed || "音声が取り込めませんでした";
    this.cut(true);
    this.stoppedAt = Date.now();
    try { this.ctx.close(); } catch (e) { /* noop */ }
  };

  function sendChunk(blob, prev) {
    var fd = new FormData();
    fd.append("file", blob, "chunk.wav");
    fd.append("prev", prev || "");
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, SEND_TIMEOUT_MS) : null;
    return origFetch("/transcribe_chunk", { method: "POST", body: fd, signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error("サーバー応答 " + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d || typeof d.text !== "string") throw new Error("応答の形式が違います");
        return d.text;
      }, function (e) {
        if (timer) clearTimeout(timer);
        throw e;
      });
  }

  /* ---------- 録音の開始・停止を検知（元の動作はそのまま呼ぶ） ---------- */
  var origStart = MediaRecorder.prototype.start;
  var origStop = MediaRecorder.prototype.stop;

  MediaRecorder.prototype.start = function () {
    var r = origStart.apply(this, arguments);
    try {
      if (enabled() && !current && this.stream && this.stream.getAudioTracks().length) {
        last = null;
        current = new Session(this.stream);
        say("小分け: 録音中", "ck-rec");
      }
    } catch (e) {
      current = null;
      log("開始できませんでした（従来方式で動きます）", e && e.message);
    }
    return r;
  };

  MediaRecorder.prototype.stop = function () {
    try {
      if (current) {
        var s = current;
        current = null;
        s.finish();
        last = s;
        say("小分け: 最後の区間を処理中…", "ck-rec");
      }
    } catch (e) {
      log("停止処理でエラー（従来方式で動きます）", e && e.message);
      last = null; current = null;
    }
    return origStop.apply(this, arguments);
  };

  /* ---------- /transcribe の横取り（失敗時は元の送信にそのまま戻す） ---------- */
  window.fetch = function (input) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (!/\/transcribe(\?|$)/.test(url) || !last) return origFetch.apply(this, arguments);

    var s = last, args = arguments, self = this;
    last = null;
    return s.chain.then(function () {
      var waited = Math.round((Date.now() - s.stoppedAt) / 100) / 10;
      if (s.failed) {
        say("従来方式で実行（" + s.failed + "）", "ck-fb");
        return origFetch.apply(self, args);
      }
      var text = s.texts.join("");
      if (!text && s.totalSamples / s.sr > 5) {
        say("従来方式で実行（小分けの結果が空でした）", "ck-fb");
        return origFetch.apply(self, args);
      }
      log("小分け方式で完了。停止後の待ち", waited + "秒", "区間数", s.idx);
      say("小分け方式で完了（停止後の待ち " + waited + " 秒）", "ck-ok");
      return new Response(JSON.stringify({ transcript: text }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }).catch(function (e) {
      say("従来方式で実行（予期せぬエラー）", "ck-fb");
      log("予期せぬエラー", e && e.message);
      return origFetch.apply(self, args);
    });
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { say(); });
  else say();

  window.__chunkAsr = { enabled: enabled, setEnabled: setEnabled };
})();
JSEOF

if ! grep -q "$MARK" main.py; then
  sed -i '/^app\.mount(/i import chunk_api; chunk_api.register(app)' main.py
fi
if ! grep -q '__chunkAsrLoaded' static/app.js; then
  printf '\n' >> static/app.js
  cat static/chunk.js >> static/app.js
fi
rm -f static/chunk.js

"$PY" -m py_compile main.py chunk_api.py || { echo "NG: 構文エラー。--rollback で戻してください"; exit 1; }
echo "OK: 取り付け完了。次を実行してください"
echo "  sudo systemctl restart clinic"
echo "戻す場合: bash install_chunk.sh --rollback"
