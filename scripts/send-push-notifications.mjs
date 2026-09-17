// scripts/send-push-notifications.mjs
//
// 5〜10分おきにGitHub Actionsから実行され、Firestoreの notifications コレクションを見て
// まだプッシュ送信していないもの（pushSent: false）を探し、OneSignal経由で本人宛てに送る。
//
// 必要なGitHub Secrets:
//   FIREBASE_SERVICE_ACCOUNT_JSON … Firebaseサービスアカウントの秘密鍵（JSON全体をそのまま貼り付け）
//   ONESIGNAL_APP_ID              … OneSignalのApp ID
//   ONESIGNAL_REST_API_KEY        … OneSignalのREST APIキー（絶対に公開しないこと）

import admin from 'firebase-admin';

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

if (!serviceAccountJson || !ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
    console.error('必要な環境変数（Secrets）が設定されていません。処理を中止します。');
    process.exit(1);
}

const serviceAccount = JSON.parse(serviceAccountJson);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TITLE_BY_TYPE = {
    follow: '新しいフォロワー',
    like: 'いいねされました',
    message: '新しいメッセージ',
};

function bodyFor(n) {
    const name = n.actorName || '誰か';
    if (n.type === 'follow') return `${name}さんにフォローされました`;
    if (n.type === 'like') return `${name}さんがあなたの投稿にいいねしました${n.postTextSnippet ? '：' + n.postTextSnippet : ''}`;
    if (n.type === 'message') return `${name}さん：${n.postTextSnippet || 'メッセージが届きました'}`;
    return `${name}さんから通知が届きました`;
}

async function sendPush(notification) {
    const res = await fetch('https://api.onesignal.com/notifications', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`,
        },
        body: JSON.stringify({
            app_id: ONESIGNAL_APP_ID,
            // Firebase UIDを「External ID」として指定するだけで、本人だけに届く
            include_aliases: { external_id: [notification.recipientUid] },
            target_channel: 'push',
            headings: { ja: TITLE_BY_TYPE[notification.type] || '学習ProMaster', en: TITLE_BY_TYPE[notification.type] || '学習ProMaster' },
            contents: { ja: bodyFor(notification), en: bodyFor(notification) },
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OneSignal APIエラー: ${res.status} ${text}`);
    }
    return res.json();
}

async function main() {
    // where + orderBy の組み合わせは複合インデックスが必要になるため、
    // ここでは意図的に orderBy を使わず、シンプルな絞り込みだけにしている
    // （送信順序は多少前後しても実用上問題ないため）。
    const snap = await db.collection('notifications')
        .where('pushSent', '==', false)
        .limit(200)
        .get();

    if (snap.empty) {
        console.log('送信対象の通知はありません。');
        return;
    }

    console.log(`${snap.size}件の通知を処理します。`);
    let successCount = 0;
    let failCount = 0;

    for (const docSnap of snap.docs) {
        const data = docSnap.data();
        try {
            await sendPush(data);
            await docSnap.ref.update({
                pushSent: true,
                pushSentAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            successCount++;
        } catch (e) {
            failCount++;
            console.error(`送信失敗（${docSnap.id}）:`, e.message);
            // 失敗した場合は pushSent を true にしない（次回の実行で再試行される）
        }
    }
    console.log(`完了：成功 ${successCount}件 / 失敗 ${failCount}件`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('予期しないエラーが発生しました:', err);
        process.exit(1);
    });
