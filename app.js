/*
 * 画像報告アプリ（Google Chat Webhook 経由）
 * 使い方:
 *   1) Node.js をインストールしたPCで  node app.js  を実行
 *   2) ブラウザで http://localhost:3000 を開く（同じWi-Fiならスマホからも http://<PCのIP>:3000 で可）
 *   3) 報告内容を選択 → 画像を選ぶ → 報告ボタン
 * 仕組み:
 *   画像を外部画像ホストにアップロードし、そのURLを Google Chat のカードに載せて Webhook に投稿します。
 *   （Webhook 自体は画像ファイルの直接アップロードに対応していないため）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ============================================================
// Webhook 設定（変更する場合はここを編集）
// ============================================================
const REPORT_TYPES = [
  {
    id: 'kanban',
    label: '看板報告',
    emoji: '📢',
    color: '#0f6b5c',
    webhook:
      'https://chat.googleapis.com/v1/spaces/AAAARidKbVQ/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=qhSPYGDqywsPutx8dj28eYSzzqE_bwxQczgcHC3OMnw',
  },
  {
    id: 'softcream',
    label: 'ソフトクリーム報告',
    emoji: '🍦',
    color: '#d6658a',
    webhook:
      'https://chat.googleapis.com/v1/spaces/AAQAt5vZijM/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=DiEm00nUVrdmkD9VvKbEaGq-P76WU99i_KERCxLY30U',
  },
  {
    id: 'grist',
    label: 'グリスト報告',
    emoji: '🛢️',
    color: '#8a6d1f',
    webhook:
      'https://chat.googleapis.com/v1/spaces/AAQAr8EVDu8/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=VSo8grpz3enfUcJwQsQ3WYiyJaT2-65800CioZ5WXwU',
  },
  {
    id: 'beer',
    label: 'ビール報告',
    emoji: '🍺',
    color: '#b07810',
    webhook:
      'https://chat.googleapis.com/v1/spaces/AAQAo9Z2dnU/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=Hqs0Rp9gXexQYJzV8t2q7qREARh-5FNK2FIy9e0un_Y',
  },
];

// ============================================================
// 画像アップロード先（上から順に試し、成功したところを使う）
//  - catbox.moe     … 無期限（推奨・ネット環境によっては失敗）
//  - litterbox      … 72時間
//  - uguu.se        … 24〜48時間
//  - tmpfiles.org   … 60分
// ============================================================
async function uploadImage(buffer, filename, mime) {
  const attempts = [
    {
      name: 'catbox.moe（無期限）',
      run: async () => {
        const fd = new FormData();
        fd.append('reqtype', 'fileupload');
        fd.append('fileToUpload', new Blob([buffer], { type: mime }), filename);
        const res = await fetch('https://catbox.moe/user/api.php', {
          method: 'POST',
          body: fd,
          signal: AbortSignal.timeout(30000),
        });
        const text = (await res.text()).trim();
        if (!res.ok || !/^https?:\/\//.test(text)) throw new Error('catbox: ' + text.slice(0, 100));
        return text;
      },
    },
    {
      name: 'litterbox（72時間）',
      run: async () => {
        const fd = new FormData();
        fd.append('reqtype', 'fileupload');
        fd.append('time', '72h');
        fd.append('fileToUpload', new Blob([buffer], { type: mime }), filename);
        const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
          method: 'POST',
          body: fd,
          signal: AbortSignal.timeout(30000),
        });
        const text = (await res.text()).trim();
        if (!res.ok || !/^https?:\/\//.test(text)) throw new Error('litterbox: ' + text.slice(0, 100));
        return text;
      },
    },
    {
      name: 'uguu.se（24〜48時間）',
      run: async () => {
        const fd = new FormData();
        fd.append('files[]', new Blob([buffer], { type: mime }), filename);
        const res = await fetch('https://uguu.se/upload', {
          method: 'POST',
          body: fd,
          signal: AbortSignal.timeout(30000),
        });
        const json = await res.json();
        if (!json.success || !json.files || !json.files[0]) throw new Error('uguu: upload failed');
        return json.files[0].url;
      },
    },
    {
      name: 'tmpfiles.org（60分）',
      run: async () => {
        const fd = new FormData();
        fd.append('file', new Blob([buffer], { type: mime }), filename);
        const res = await fetch('https://tmpfiles.org/api/v1/upload', {
          method: 'POST',
          body: fd,
          signal: AbortSignal.timeout(30000),
        });
        const json = await res.json();
        if (!json.data || !json.data.url) throw new Error('tmpfiles: upload failed');
        return json.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
      },
    },
  ];
  const errors = [];
  for (const a of attempts) {
    try {
      const url = await a.run();
      return { url, host: a.name };
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error('すべての画像ホストでアップロードに失敗しました: ' + errors.join(' / '));
}

// ============================================================
// multipart/form-data パーサー（依存ライブラリ不要）
// ============================================================
function parseMultipart(body, boundary) {
  const results = {};
  const delim = Buffer.from('--' + boundary);
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    const afterDelim = pos + delim.length;
    if (body.slice(afterDelim, afterDelim + 2).toString() === '--') break;
    const headerStart = body.indexOf(Buffer.from('\r\n'), afterDelim) + 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerStart < 2 || headerEnd === -1) break;
    const headers = body.slice(headerStart, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const nextPos = body.indexOf(delim, contentStart);
    if (nextPos === -1) break;
    const content = body.slice(contentStart, nextPos - 2); // 末尾 \r\n を除去
    const nameMatch = headers.match(/name="([^"]*)"/);
    const fileMatch = headers.match(/filename="([^"]*)"/);
    const typeMatch = headers.match(/Content-Type:\s*([^\r\n;]+)/i);
    if (nameMatch) {
      if (fileMatch && fileMatch[1]) {
        results[nameMatch[1]] = {
          filename: fileMatch[1],
          mime: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
          data: content,
        };
      } else {
        results[nameMatch[1]] = content.toString('utf8');
      }
    }
    pos = nextPos;
  }
  return results;
}

// ============================================================
// Google Chat への投稿
// ============================================================
function buildCardMessage(type, comment, imageUrl, timestampJst) {
  return {
    text: type.emoji + ' ' + type.label + ' が送信されました',
    cardsV2: [
      {
        cardId: 'report-card',
        card: {
          header: {
            title: type.emoji + ' ' + type.label,
            subtitle: '報告日時: ' + timestampJst,
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text:
                      '<b>報告内容:</b> ' +
                      type.label +
                      (comment ? '<br><b>コメント:</b> ' + comment.replace(/</g, '&lt;').replace(/\n/g, '<br>') : ''),
                  },
                },
                {
                  image: {
                    imageUrl: imageUrl,
                    onClick: { openLink: { url: imageUrl } },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

// ============================================================
// フロントエンド（HTML）
// ============================================================
const HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>画像報告アプリ</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#e35f3f">
<link rel="icon" type="image/png" href="/icons/icon-192.png">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<style>
  :root {
    --ink: #22303a;
    --sub: #6b7a85;
    --line: #dde4e8;
    --paper: #ffffff;
    --bg: #eef1f3;
    --accent: #e35f3f;
    --ok: #0f6b5c;
    --err: #b3362a;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", Meiryo, system-ui, sans-serif;
    background: var(--bg);
    color: var(--ink);
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 24px 16px 48px;
  }
  .app { width: 100%; max-width: 480px; }
  header.app-header { text-align: center; margin-bottom: 20px; }
  header.app-header h1 { font-size: 20px; letter-spacing: 0.06em; }
  header.app-header p { font-size: 12px; color: var(--sub); margin-top: 4px; }
  .card {
    background: var(--paper);
    border-radius: 14px;
    border: 1px solid var(--line);
    padding: 22px 20px;
    box-shadow: 0 2px 10px rgba(34,48,58,0.06);
  }
  label.field-label {
    display: block;
    font-size: 13px;
    font-weight: 700;
    margin: 18px 0 6px;
  }
  label.field-label:first-child { margin-top: 0; }
  label.field-label .req { color: var(--accent); }
  select, textarea {
    width: 100%;
    font-size: 16px;
    padding: 12px 14px;
    border: 1.5px solid var(--line);
    border-radius: 10px;
    background: #fbfcfc;
    color: var(--ink);
    font-family: inherit;
  }
  select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .dest-note {
    margin-top: 6px;
    font-size: 12px;
    color: var(--sub);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dest-chip {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    color: #fff;
    font-weight: 700;
    font-size: 11px;
  }
  .photo-drop {
    border: 2px dashed #b9c4cb;
    border-radius: 12px;
    padding: 18px;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .photo-drop:hover { border-color: var(--accent); }
  .photo-drop .ph-icon { font-size: 30px; }
  .photo-drop .ph-text { font-size: 14px; font-weight: 700; margin-top: 4px; }
  .photo-drop .ph-sub { font-size: 11.5px; color: var(--sub); margin-top: 2px; }
  #photoInput { display: none; }
  .preview-wrap { position: relative; display: none; }
  .preview-wrap img {
    width: 100%;
    max-height: 340px;
    object-fit: contain;
    border-radius: 10px;
    background: #f2f4f5;
  }
  .preview-clear {
    position: absolute;
    top: 8px;
    right: 8px;
    background: rgba(34,48,58,0.85);
    color: #fff;
    border: none;
    border-radius: 999px;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
  }
  .submit-btn {
    width: 100%;
    margin-top: 22px;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 12px;
    padding: 16px;
    font-size: 17px;
    font-weight: 700;
    letter-spacing: 0.08em;
    cursor: pointer;
  }
  .submit-btn:hover { filter: brightness(0.95); }
  .submit-btn:disabled { opacity: 0.55; cursor: wait; }
  .status { margin-top: 14px; font-size: 14px; text-align: center; min-height: 20px; }
  .status.ok { color: var(--ok); font-weight: 700; }
  .status.err { color: var(--err); font-weight: 700; }
  .done-view { display: none; text-align: center; padding: 26px 10px; }
  .done-view .done-icon { font-size: 46px; }
  .done-view h2 { font-size: 18px; margin: 10px 0 4px; color: var(--ok); }
  .done-view p { font-size: 13px; color: var(--sub); }
  .done-view .again-btn {
    margin-top: 18px;
    background: var(--paper);
    color: var(--ink);
    border: 1.5px solid var(--line);
    border-radius: 10px;
    padding: 12px 26px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
  }
  footer.app-footer { text-align: center; font-size: 11px; color: var(--sub); margin-top: 18px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
  <div class="app">
    <header class="app-header">
      <h1>📷 画像報告アプリ</h1>
      <p>報告内容を選んで、写真を添えて送信します</p>
    </header>

    <div class="card">
      <form id="reportForm">
        <label class="field-label" for="typeSelect">報告内容 <span class="req">※必須</span></label>
        <select id="typeSelect" required>
          <option value="" disabled selected>選択してください</option>
          <option value="kanban">看板報告</option>
          <option value="softcream">ソフトクリーム報告</option>
          <option value="grist">グリスト報告</option>
          <option value="beer">ビール報告</option>
        </select>
        <div class="dest-note">送信先: <span class="dest-chip" id="destChip" style="background:#9aa7af">未選択</span><span id="destText">報告内容に合わせて自動で切り替わります</span></div>

        <label class="field-label">画像 <span class="req">※必須</span></label>
        <div class="photo-drop" id="photoDrop" role="button" tabindex="0" aria-label="画像を選択または撮影">
          <div class="ph-icon">🖼️</div>
          <div class="ph-text">タップして画像を選択</div>
          <div class="ph-sub">カメラ撮影も可（スマホの場合）</div>
        </div>
        <input type="file" id="photoInput" accept="image/*" capture="environment">
        <div class="preview-wrap" id="previewWrap">
          <img id="previewImg" alt="選択した画像のプレビュー">
          <button type="button" class="preview-clear" id="previewClear">削除</button>
        </div>

        <label class="field-label" for="commentInput">一言コメント（任意）</label>
        <textarea id="commentInput" rows="2" placeholder="例）右側の看板が落ちています"></textarea>

        <button type="submit" class="submit-btn" id="submitBtn">📤 報告する</button>
        <div class="status" id="status" aria-live="polite"></div>
      </form>

      <div class="done-view" id="doneView">
        <div class="done-icon">✅</div>
        <h2>報告を送信しました</h2>
        <p id="doneDetail"></p>
        <button type="button" class="again-btn" id="againBtn">新しい報告を書く</button>
      </div>
    </div>

    <footer class="app-footer">画像は外部画像ホストにアップロードされ、そのURLを Google Chat に送信します</footer>
  </div>

<script>
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }
  var TYPES = {
    kanban:   { label: '看板報告',         emoji: '📢', color: '#0f6b5c' },
    softcream:{ label: 'ソフトクリーム報告', emoji: '🍦', color: '#d6658a' },
    grist:    { label: 'グリスト報告',      emoji: '🛢️', color: '#8a6d1f' },
    beer:     { label: 'ビール報告',        emoji: '🍺', color: '#b07810' }
  };
  var form = document.getElementById('reportForm');
  var typeSelect = document.getElementById('typeSelect');
  var destChip = document.getElementById('destChip');
  var destText = document.getElementById('destText');
  var photoDrop = document.getElementById('photoDrop');
  var photoInput = document.getElementById('photoInput');
  var previewWrap = document.getElementById('previewWrap');
  var previewImg = document.getElementById('previewImg');
  var previewClear = document.getElementById('previewClear');
  var commentInput = document.getElementById('commentInput');
  var submitBtn = document.getElementById('submitBtn');
  var status = document.getElementById('status');
  var doneView = document.getElementById('doneView');
  var doneDetail = document.getElementById('doneDetail');
  var againBtn = document.getElementById('againBtn');

  typeSelect.addEventListener('change', function () {
    var t = TYPES[typeSelect.value];
    if (t) {
      destChip.textContent = t.emoji + ' ' + t.label + ' チャンネル';
      destChip.style.background = t.color;
      destText.textContent = 'へ送信します';
    }
  });

  photoDrop.addEventListener('click', function () { photoInput.click(); });
  photoDrop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); photoInput.click(); }
  });
  photoInput.addEventListener('change', function () {
    var f = photoInput.files && photoInput.files[0];
    if (f) showPreview(f);
  });
  previewClear.addEventListener('click', function () {
    photoInput.value = '';
    previewWrap.style.display = 'none';
    photoDrop.style.display = 'block';
  });

  function showPreview(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      previewImg.src = e.target.result;
      previewWrap.style.display = 'block';
      photoDrop.style.display = 'none';
    };
    reader.readAsDataURL(file);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    status.className = 'status';
    status.textContent = '';
    var typeVal = typeSelect.value;
    var file = photoInput.files && photoInput.files[0];
    if (!typeVal) { status.className = 'status err'; status.textContent = '報告内容を選択してください'; return; }
    if (!file) { status.className = 'status err'; status.textContent = '画像を選択してください'; return; }
    if (file.size > 15 * 1024 * 1024) { status.className = 'status err'; status.textContent = '画像は15MBまでです'; return; }

    var fd = new FormData();
    fd.append('type', typeVal);
    fd.append('comment', commentInput.value);
    fd.append('image', file);

    submitBtn.disabled = true;
    status.className = 'status';
    status.textContent = '送信中…（画像アップロードに10〜30秒かかることがあります）';

    fetch('/report', { method: 'POST', body: fd })
      .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
      .then(function (r) {
        if (r.ok && r.j.ok) {
          var t = TYPES[typeVal];
          form.style.display = 'none';
          doneDetail.textContent = t.emoji + ' ' + t.label + ' のチャンネルに送信しました（画像ホスト: ' + r.j.host + '）';
          doneView.style.display = 'block';
        } else {
          status.className = 'status err';
          status.textContent = '送信に失敗しました: ' + (r.j && r.j.error ? r.j.error : 'HTTP ' + r.status);
        }
      })
      .catch(function () {
        status.className = 'status err';
        status.textContent = 'サーバーに接続できませんでした';
      })
      .finally(function () { submitBtn.disabled = false; });
  });

  againBtn.addEventListener('click', function () {
    form.reset();
    previewWrap.style.display = 'none';
    photoDrop.style.display = 'block';
    destChip.textContent = '未選択';
    destChip.style.background = '#9aa7af';
    destText.textContent = '報告内容に合わせて自動で切り替わります';
    doneView.style.display = 'none';
    form.style.display = 'block';
    status.textContent = '';
  });
})();
</script>
</body>
</html>`;

// ============================================================
// 静的ファイル（PWA用: manifest / sw.js / アイコン）
// ============================================================
const STATIC_FILES = {
  '/manifest.json': { path: 'public/manifest.json', type: 'application/manifest+json; charset=utf-8', cache: 'no-cache' },
  '/sw.js': { path: 'public/sw.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
  '/icons/icon-192.png': { path: 'public/icons/icon-192.png', type: 'image/png', cache: 'public, max-age=86400' },
  '/icons/icon-512.png': { path: 'public/icons/icon-512.png', type: 'image/png', cache: 'public, max-age=86400' },
};

function serveStatic(req, res) {
  const f = STATIC_FILES[req.url.split('?')[0]];
  if (!f) return false;
  try {
    const data = fs.readFileSync(path.join(__dirname, f.path));
    res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': f.cache });
    res.end(data);
    return true;
  } catch (e) {
    return false;
  }
}

// ============================================================
// HTTP サーバー
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    if (serveStatic(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'POST' && req.url === '/report') {
    try {
      const ct = req.headers['content-type'] || '';
      const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (!bm) throw new Error('不正なリクエストです');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      if (body.length > 20 * 1024 * 1024) throw new Error('画像が大きすぎます（20MBまで）');

      const fields = parseMultipart(body, (bm[1] || bm[2]).trim());
      const typeId = fields.type;
      const comment = (fields.comment || '').trim();
      const image = fields.image;

      const type = REPORT_TYPES.find((t) => t.id === typeId);
      if (!type) throw new Error('報告内容の選択が不正です');
      if (!image || !image.data || image.data.length === 0) throw new Error('画像が選択されていません');

      // 1) 画像ホストへアップロード
      const ext = (image.filename.match(/\.([a-zA-Z0-9]+)$/) || [, 'png'])[1].toLowerCase();
      const safeName = 'report_' + Date.now() + '.' + ext;
      const uploaded = await uploadImage(image.data, safeName, image.mime);

      // 2) Google Chat へカード投稿
      const timestampJst = new Date().toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const payload = buildCardMessage(type, comment, uploaded.url, timestampJst);
      const chatRes = await fetch(type.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      if (!chatRes.ok) {
        const t = await chatRes.text();
        throw new Error('Google Chat への送信に失敗しました（HTTP ' + chatRes.status + '）');
      }

      console.log('[OK] ' + timestampJst + ' → ' + type.label + '（' + uploaded.host + '）');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, host: uploaded.host, imageUrl: uploaded.url }));
    } catch (e) {
      console.error('[NG]', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================================');
  console.log('  画像報告アプリが起動しました');
  console.log('  このPCから     → http://localhost:' + PORT);
  console.log('  同じWi-Fiの端末 → http://<このPCのIP>:' + PORT);
  console.log('  終了するには Ctrl+C');
  console.log('==========================================================');
});
