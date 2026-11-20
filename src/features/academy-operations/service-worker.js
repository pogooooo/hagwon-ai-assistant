// Network only: private pages, documents and answers must never enter a cache.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET')
    return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>연결 확인 · 온답</title><main><h1>인터넷 연결을 확인해 주세요.</h1><p>학원 자료와 상담은 연결된 상태에서 이용할 수 있습니다. 작성 중인 내용의 저장 여부는 연결 후 확인해 주세요.</p><a href="/">다시 연결</a></main></html>',
          {
            status: 503,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'Content-Security-Policy':
                "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            },
          },
        ),
    ),
  );
});
