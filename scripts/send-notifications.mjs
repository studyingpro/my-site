// config.json の「予定・通知」に設定された notifyAt（通知日時）を見て、
// OneSignalに「その時刻に送信して」と予約するスクリプトです。
// GitHub Actions（.github/workflows/schedule-push-notifications.yml）から実行されます。
//
// 仕組み：
// - 予定ごとに、通知の予約状況を .github/data/notify-state.json に記録する
// - notifyAt が新しく設定された／変更された予定だけ、OneSignalに新規予約する
// - notifyAt が削除された、または予定自体が消えた場合は、既存の予約をキャンセルする
// - 一度送信された（notifyAtが過去になった）予定は、新規予約の対象から外す

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const APP_ID = process.env.ONESIGNAL_APP_ID;
const REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const STATE_PATH = ".github/data/notify-state.json";
const CONFIG_PATH = "config.json";

if (!APP_ID || !REST_API_KEY) {
    console.error(
        "ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY が設定されていません。" +
        "GitHubリポジトリの Settings → Secrets and variables → Actions に登録してください。"
    );
    process.exit(1);
}

async function loadJson(path, fallback) {
    if (!existsSync(path)) return fallback;
    try {
        return JSON.parse(await readFile(path, "utf-8"));
    } catch (e) {
        console.warn(`${path} の読み込みに失敗しました:`, e.message);
        return fallback;
    }
}

async function oneSignalRequest(method, path, body) {
    const res = await fetch(`https://onesignal.com/api/v1${path}`, {
        method,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            // ※ 401エラーになる場合は "Basic" を "Key" に変更して試してください
            //   （OneSignal側の仕様変更により、どちらが有効かが変わることがあります）
            "Authorization": `Basic ${REST_API_KEY}`,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) {
        throw new Error(`OneSignal APIエラー (${res.status}): ${text}`);
    }
    return json;
}

async function cancelNotification(id) {
    try {
        await oneSignalRequest("DELETE", `/notifications/${id}?app_id=${APP_ID}`);
        console.log(`  既存の予約 (${id}) をキャンセルしました`);
    } catch (e) {
        console.warn(`  既存の予約 (${id}) のキャンセルに失敗しました（送信済みの可能性があります）:`, e.message);
    }
}

async function scheduleNotification(schedule) {
    const typeLabel = schedule.type === "submission" ? "提出物" : "テスト";
    const bodyText = `${schedule.title}${schedule.subject ? "（" + schedule.subject + "）" : ""} - ${schedule.date}`;
    const payload = {
        app_id: APP_ID,
        headings: { ja: `予習ProMaster：${typeLabel}のお知らせ`, en: `Schedule reminder: ${typeLabel}` },
        contents: { ja: bodyText, en: bodyText },
        send_after: schedule.notifyAt, // ISO 8601形式の日時文字列
    };
    const classIds = Array.isArray(schedule.classIds) ? schedule.classIds.filter(Boolean) : [];
    if (classIds.length > 0) {
        // 対象クラスが指定されている場合は、そのクラスのタグを持つ購読者だけに送る
        const filters = [];
        classIds.forEach((id, i) => {
            if (i > 0) filters.push({ operator: "OR" });
            filters.push({ field: "tag", key: "classId", relation: "=", value: id });
        });
        payload.filters = filters;
    } else {
        // 未指定なら全購読者に送る
        payload.included_segments = ["Subscribed Users"];
    }
    const result = await oneSignalRequest("POST", "/notifications", payload);
    return result.id;
}

async function main() {
    const config = await loadJson(CONFIG_PATH, {});
    const schedules = Array.isArray(config.globalSchedules) ? config.globalSchedules : [];
    const state = await loadJson(STATE_PATH, {});
    const now = Date.now();
    let changed = false;
    const currentIds = new Set();

    for (const s of schedules) {
        if (!s.notifyAt || s.id == null) continue;
        const t = new Date(s.notifyAt).getTime();
        if (isNaN(t)) continue;
        const key = String(s.id);
        currentIds.add(key);

        if (t <= now) continue; // 通知時刻をすでに過ぎている予定は新規予約しない

        const existing = state[key];
        if (existing && existing.notifyAt === s.notifyAt) continue; // 変更なし

        console.log(`予約: [${s.title}] ${s.notifyAt}`);
        if (existing && existing.oneSignalId) {
            await cancelNotification(existing.oneSignalId);
        }
        try {
            const oneSignalId = await scheduleNotification(s);
            state[key] = { notifyAt: s.notifyAt, oneSignalId };
            changed = true;
            console.log(`  → OneSignal予約ID: ${oneSignalId}`);
        } catch (e) {
            console.error(`  予約に失敗しました: ${e.message}`);
        }
    }

    // config.jsonから消えた／通知日時が削除された予定は、既存の予約をキャンセルする
    for (const key of Object.keys(state)) {
        if (currentIds.has(key)) continue;
        const existing = state[key];
        if (existing && existing.oneSignalId) {
            console.log(`削除された予定の予約をキャンセル: ${key}`);
            await cancelNotification(existing.oneSignalId);
        }
        delete state[key];
        changed = true;
    }

    if (changed) {
        await mkdir(".github/data", { recursive: true });
        await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
        console.log("notify-state.json を更新しました");
    } else {
        console.log("変更はありませんでした");
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
