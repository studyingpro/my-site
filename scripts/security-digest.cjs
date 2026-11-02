// （このファイルは .cjs です。scripts/package.json が "type": "module" のため、.js だと require が使えず動きません）
// 毎朝のセキュリティ日報 → オーナーだけの「お知らせ」（Firestore の inbox）に書き込む
// 実行：GitHub Actions（毎日 08:00 JST）。手元で試すときは  node scripts/security-digest.cjs --dry
//   --dry … お知らせには書き込まず、内容を画面に出すだけ
// 必要な環境変数：FIREBASE_SERVICE_ACCOUNT（サービスアカウントのJSON）, OWNER_UID（あなたのFirebaseユーザーID）
// あれば使う：GITHUB_TOKEN と GITHUB_REPOSITORY（Actions が自動で入れる）, FIREBASE_WEB_API_KEY / WORKER_BASE（index.html から自動で読むので通常は不要）
'use strict';
const fs = require('fs');
const admin = require('firebase-admin');

const DRY = process.argv.includes('--dry') || process.env.DRY === 'true';
const OWNER_UID = (process.env.OWNER_UID || '').trim();
const DAY = 24 * 3600 * 1000;
const FROM_LABEL = 'セキュリティ日報';
const LEGACY_USER_FIELDS = ['lastName', 'firstName', 'lastNameKana', 'firstNameKana', 'grade', 'gradeVisibility', 'highSchool', 'highSchoolVisibility', 'achievementGoals', 'phoneNumber'];
const EVENT_LABEL = {
  rate_limited: 'アクセスが多すぎて、制限した', ai_daily_limit: 'AIの1日の上限に達した', bad_request: '不正な形式の送信を、拒否した',
  auto_corrected: 'AIが、内容を自動で訂正した', report_error: '報告の処理に失敗した', admin_denied: '管理用の画面に、権限のない人が入ろうとした'
};

const items = [];
const add = (level, title, detail = '') => items.push({ level, title, detail });
const failed = [];
async function safe(name, fn) { try { await fn(); } catch (e) { failed.push(name); console.warn('[' + name + ']', e && e.message || e); } }

const jstDay = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
const jstWeekday = (ms) => new Date(ms + 9 * 3600 * 1000).getUTCDay(); // 0=日 1=月
const short = (u) => String(u || '').slice(0, 8) + '…';

// ---------- 文章にまとめる（外部に頼らない関数。テストしやすいように分けてある） ----------
function compose(list, failedNames, now) {
  const by = (lv) => list.filter(x => x.level === lv);
  const fmt = (x) => '・' + x.title + (x.detail ? '\n  ' + String(x.detail).split('\n').join('\n  ') : '');
  const bad = by('bad'), warn = by('warn'), info = by('info');
  const d = new Date(now + 9 * 3600 * 1000);
  const date = (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
  const head = (bad.length || warn.length) ? `要対応 ${bad.length}・注意 ${warn.length}` : '異常なし';
  const parts = [];
  if (!bad.length && !warn.length) parts.push('異常は見つかりませんでした。');
  if (bad.length) parts.push('【要対応】\n' + bad.map(fmt).join('\n'));
  if (warn.length) parts.push('【注意】\n' + warn.map(fmt).join('\n'));
  if (info.length) parts.push('【状況】\n' + info.map(fmt).join('\n'));
  if (failedNames.length) parts.push('【取得できなかった項目】\n' + failedNames.join('、'));
  let body = parts.join('\n\n');
  if (body.length > 3000) body = body.slice(0, 2990) + '\n…（長いので省略）';
  return { title: `${date} ${FROM_LABEL}（${head}）`, body, severity: bad.length ? 'bad' : warn.length ? 'warn' : 'ok' };
}

// ---------- index.html から設定を読む ----------
function readConfig() {
  let apiKey = process.env.FIREBASE_WEB_API_KEY || '', worker = process.env.WORKER_BASE || '';
  try {
    const html = fs.readFileSync(process.env.INDEX_HTML || 'index.html', 'utf8');
    if (!apiKey) { const m = html.match(/apiKey:\s*"([^"]+)"/); if (m) apiKey = m[1]; }
    if (!worker) { const m = html.match(/PM_REPORT_URL\s*=\s*'([^']+)'/); if (m) worker = m[1].replace(/\/report$/, ''); }
  } catch (e) { /* index.html が無くても続ける */ }
  return { apiKey, worker };
}

// Workerの管理用の入り口は「公式アカウントのIDトークン」で守られている。オーナー本人のトークンを、サービスアカウントから作って使う。
async function ownerIdToken(apiKey) {
  const custom = await admin.auth().createCustomToken(OWNER_UID);
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=' + encodeURIComponent(apiKey), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true })
  });
  if (!r.ok) throw new Error('IDトークンを作れませんでした（' + r.status + '）');
  return (await r.json()).idToken;
}

async function main() {
  if (!OWNER_UID) throw new Error('OWNER_UID が設定されていません');
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT が設定されていません');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  const now = Date.now();
  const cfg = readConfig();
  const stateRef = db.doc('private/securityDigest');
  const prev = (await stateRef.get()).data() || {};
  const next = { at: now };

  // 1) アカウントの増え方
  await safe('アカウント数', async () => {
    let total = 0, guests = 0, fresh = 0, freshGuests = 0, tok;
    do {
      const r = await admin.auth().listUsers(1000, tok);
      r.users.forEach(u => {
        total++; const isGuest = !u.providerData || u.providerData.length === 0; if (isGuest) guests++;
        if (Date.parse(u.metadata.creationTime) > now - DAY) { fresh++; if (isGuest) freshGuests++; }
      });
      tok = r.pageToken;
    } while (tok);
    const lv = freshGuests >= 200 ? 'bad' : freshGuests >= 50 ? 'warn' : 'info';
    add(lv, `新しいアカウント：24時間で ${fresh} 件（うちゲスト ${freshGuests}）`, `全体 ${total} 件（ゲスト ${guests}）` + (lv !== 'info' ? '\nゲストが急に増えています。自動プログラムの可能性があります。' : ''));
  });

  // 2) Workerが記録した不審なアクセス
  await safe('不審なアクセスの記録', async () => {
    const snap = await db.collection('security_events').orderBy('t', 'desc').limit(400).get();
    const ms = (v) => (v && v.toDate) ? v.toDate().getTime() : Date.parse(v);
    const recent = snap.docs.map(d => d.data()).filter(e => now - ms(e.t) < DAY);
    const cnt = {}; recent.forEach(e => { cnt[e.type] = (cnt[e.type] || 0) + 1; });
    const thr = { admin_denied: [1, 5], bad_request: [20, 100], rate_limited: [30, 150], auto_corrected: [5, 15], report_error: [5, 20], ai_daily_limit: [20, 100] };
    let any = false;
    Object.keys(EVENT_LABEL).forEach(t => {
      const n = cnt[t] || 0; if (!n) return; any = true;
      const [w, b] = thr[t] || [20, 100];
      add(n >= b ? 'bad' : n >= w ? 'warn' : 'info', `${EVENT_LABEL[t]}：24時間で ${n} 件`,
        t === 'admin_denied' ? '管理用の画面を探っている人がいる可能性があります。' : t === 'auto_corrected' ? '内容が書き換えられていないか、「報告・訂正」の記録を確認してください。' : '');
    });
    if (!any) add('info', '不審なアクセスの記録：24時間でなし');
  });

  // 3) Workerの状態とアクセスログ（Workerが対応していて、鍵が使えるときだけ）
  await safe('Workerの状態・アクセスログ', async () => {
    if (!cfg.apiKey || !cfg.worker) throw new Error('WorkerのURLかAPIキーが分かりません');
    const idToken = await ownerIdToken(cfg.apiKey);
    const get = async (p) => { const r = await fetch(cfg.worker + p, { headers: { Authorization: 'Bearer ' + idToken }, cache: 'no-store' }); if (!r.ok) throw new Error(p + ' → ' + r.status); return r.json(); };
    try {
      const w = await get('/admin/status'), st = w.settings || {};
      if (!st.GITHUB_TOKEN) add('bad', 'WorkerにGITHUB_TOKENがありません');
      if (!st.GEMINI_API_KEY) add('bad', 'WorkerにGEMINI_API_KEYがありません');
      if (!st.RATE_LIMIT_KV) add('bad', 'WorkerのAI回数制限（KV）が無効です', 'AIを不正に使われて、料金が増える恐れがあります。');
      if (w.github && w.github.config && w.github.config !== 'ok') add('warn', 'WorkerからGitHubのconfig.jsonを読めません', String(w.github.config));
      if (st.FIREBASE_SERVICE_ACCOUNT && w.firestore && w.firestore !== 'ok') add('warn', 'WorkerからFirestoreに接続できません', String(w.firestore));
      if (w.ai && w.ai.available) {
        const a = w.ai, hot = a.atLimit >= 10 || a.calls >= 150;
        add(hot ? 'warn' : 'info', `今日のAI利用：${a.calls}回（${a.ips}接続元、上限に達した接続元 ${a.atLimit}）`, a.atLimit >= 10 ? '上限に達した接続元が多いです。不正利用の形跡かもしれません。' : '');
      }
      const al = w.alerts || {};
      if (al.secret && al.secret.open) add('warn', `GitHubの「秘密情報の検知」：未対応 ${al.secret.open} 件`);
      if (al.dependabot && al.dependabot.open) add('warn', `GitHubの「古い部品の警告」：未対応 ${al.dependabot.open} 件`);
    } catch (e) { failed.push('Workerの状態'); console.warn(e.message); }
    try {
      const ls = await get('/admin/log-summary');
      const who = (x) => (x.anon ? 'ゲスト ' : 'ユーザー ') + short(x.uid);
      (ls.manyIps || []).forEach(x => add(x.ips >= 8 ? 'bad' : 'warn', `ひとつのアカウントが24時間に ${x.ips} 個の別IPから使われています`, `${who(x)}　記録 ${x.events} 件\n共有や乗っ取りの可能性があります。`));
      (ls.sharedIps || []).forEach(x => { if (x.guests >= 10) add(x.guests >= 30 ? 'bad' : 'warn', `ひとつのIP（${x.ip}）からゲストが ${x.guests} 個使われています`, '自動プログラムの可能性があります。'); });
      (ls.heavy || []).forEach(x => add(x.events >= 1000 ? 'bad' : 'warn', `短時間に大量のアクセス（${x.events} 件）`, `${who(x)}　IP ${x.ip}`));
      const foreign = (ls.countries || []).filter(c => c.country && c.country !== 'JP');
      const known = new Set(ls.earlierCountries || []), haveHistory = (ls.days || []).length >= 2;
      (haveHistory ? foreign.filter(c => !known.has(c.country)) : []).forEach(c => add('warn', `初めての国（${c.country}）からのアクセス`, `${c.users} 人・${c.events} 件`));
      const before = (ls.days || []).slice(0, -1);
      const avg = before.length ? before.reduce((a, d) => a + d.events, 0) / before.length : 0;
      if (ls.last24h) {
        if (before.length >= 3 && avg >= 20 && ls.last24h.events > avg * 3) add('warn', `直近24時間のアクセスが普段の約 ${Math.round(ls.last24h.events / avg)} 倍です`, `普段は1日 ${Math.round(avg)} 件、いまは ${ls.last24h.events} 件`);
        add('info', `アクセス：24時間で ${ls.last24h.events} 件`);
      }
    } catch (e) { failed.push('アクセスログ'); console.warn(e.message); }
  });

  // 4) GitHub：見覚えのない人の変更
  await safe('GitHubの変更', async () => {
    const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
    if (!repo || !token) throw new Error('GITHUB_REPOSITORY / GITHUB_TOKEN がありません');
    const r = await fetch(`https://api.github.com/repos/${repo}/commits?since=${new Date(now - DAY).toISOString()}&per_page=50`, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'security-digest' }
    });
    if (!r.ok) throw new Error('GitHub API ' + r.status);
    const commits = await r.json();
    const owner = repo.split('/')[0].toLowerCase(), trusted = new Set([owner, 'github-actions[bot]', 'dependabot[bot]']);
    const who = (c) => String((c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.name) || '不明');
    const strangers = commits.filter(c => !trusted.has(who(c).toLowerCase()));
    if (strangers.length) add('bad', `見覚えのない人によるGitHubの変更が ${strangers.length} 件あります`, strangers.slice(0, 5).map(c => `${who(c)}　${(c.commit.message || '').split('\n')[0].slice(0, 60)}`).join('\n') + '\nindex.html を書き換えられると、全利用者のアプリが乗っ取られます。すぐ確認してください。');
    else add('info', `GitHubの変更：24時間で ${commits.length} 件（すべて自分・自動処理）`);
  });

  // 5) 公式マーク・管理者の増減
  await safe('公式マーク・管理者', async () => {
    const off = await db.collection('publicProfiles').where('isOfficial', '==', true).get();
    const offList = off.docs.map(d => ({ uid: d.id, name: (d.data().nickname || '') + (d.data().username ? ' @' + d.data().username : '') }));
    next.officialUids = offList.map(x => x.uid);
    if (Array.isArray(prev.officialUids)) {
      const added = offList.filter(x => !prev.officialUids.includes(x.uid));
      if (added.length) add('warn', `公式マークが付いたアカウントが増えました（${added.length} 件）`, added.map(x => x.name || short(x.uid)).join('\n') + '\n開発者モードに入れる人が増えています。心当たりがあるか確認してください。');
    }
    add('info', `公式マークのアカウント：${offList.length} 件`);
    const ad = await db.collection('admins').get();
    next.adminUids = ad.docs.map(d => d.id);
    if (Array.isArray(prev.adminUids)) {
      const added = next.adminUids.filter(u => !prev.adminUids.includes(u));
      if (added.length) add('bad', `管理者（admins）が増えました（${added.length} 件）`, added.map(short).join('、') + '\nFirebaseコンソールを操作できる人が追加した可能性があります。心当たりがなければ、すぐ確認してください。');
    }
  });

  // 6) 限定番号を入力した人・フィードバック・昨日の利用
  await safe('利用状況・フィードバック', async () => {
    const mem = (await db.collection('members').count().get()).data().count;
    next.memberCount = mem;
    if (typeof prev.memberCount === 'number' && mem - prev.memberCount >= 20) add('warn', `限定番号を入力した人が、前回から ${mem - prev.memberCount} 人増えました`, `現在 ${mem} 人。想定外の人に広まっていないか確認してください。`);
    else add('info', `限定番号を入力して認められた人：${mem} 人`);
    const y = jstDay(now - DAY);
    const visits = (await db.collection('usage_visits').where('d', '==', y).count().get()).data().count;
    add('info', `昨日（${y}）の利用者：${visits} 人`);
    const fb = (await db.collection('feedback').where('status', '==', 'new').count().get()).data().count;
    add('info', `未対応のフィードバック：${fb} 件`);
  });

  // 7) 週に1回（月曜）：個人情報が残っていないかの点検
  if (jstWeekday(now) === 1) {
    await safe('個人情報の点検', async () => {
      const un = await db.collection('usernames').select('email').get();
      const withEmail = un.docs.filter(d => d.get('email') !== undefined).length;
      if (withEmail) add('bad', `ユーザーネームの表に、メールアドレスが ${withEmail} 件残っています`, '公開で読める場所です。purge_legacy_user_data.js を実行して消してください。');
      const us = await db.collection('users').select(...LEGACY_USER_FIELDS).get();
      const legacy = us.docs.filter(d => LEGACY_USER_FIELDS.some(k => d.get(k) !== undefined)).length;
      if (legacy) add('warn', `古い個人情報（氏名・学年など）が残っているユーザーが ${legacy} 人います`, 'purge_legacy_user_data.js で一括削除できます。');
      if (!withEmail && !legacy) add('info', '個人情報の点検（週1回）：問題なし');
    });
  }

  // ---------- まとめて、オーナーのお知らせに書く ----------
  const msg = compose(items, failed, now);
  console.log(msg.title + '\n\n' + msg.body);
  if (DRY) { console.log('\n（--dry なので、お知らせには書き込みません）'); return; }

  await db.collection('inbox').add({
    toUid: OWNER_UID, from: FROM_LABEL, title: msg.title, body: msg.body, feedbackId: '', ref: '',
    severity: msg.severity, read: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await stateRef.set({ ...prev, ...next }, { merge: true });

  // 古い日報は7日ぶんだけ残す
  const old = await db.collection('inbox').where('toUid', '==', OWNER_UID).where('from', '==', FROM_LABEL).get();
  const batch = db.batch(); let n = 0;
  old.docs.forEach(d => { const c = d.get('createdAt'); if (c && c.toMillis && c.toMillis() < now - 7 * DAY) { batch.delete(d.ref); n++; } });
  if (n) await batch.commit();
  console.log('お知らせに書き込みました。');
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { compose };
