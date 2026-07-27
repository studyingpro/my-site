importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDKWorker.js");
// 予習ProMaster用の最小限のService Worker
// 「アプリをインストール」を可能にするためだけに存在し、
// 意図的にキャッシュは行わない（config.json等を常に最新の状態で取得するため）。

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// installableの条件を満たすためのfetchハンドラ。
// 特別なキャッシュ処理はせず、そのままネットワークから取得する。
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
