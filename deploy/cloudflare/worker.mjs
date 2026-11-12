const worker = {
  async fetch(request, env) {
    const upstream = new URL(request.url);
    if (upstream.origin !== env.AXR_PUBLIC_ORIGIN) {
      return new Response('주소를 확인해 주세요.', { status: 404 });
    }
    // The binding selects the private host and port. The URL supplies the Host
    // header used by the application to validate form origins and session cookies.
    upstream.protocol = 'http:';
    try {
      return await env.AXR_ORIGIN.fetch(new Request(upstream, request), {
        redirect: 'manual',
      });
    } catch {
      return new Response('학원 데모 서버에 연결할 수 없습니다.', {
        status: 502,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
  },
};

export default worker;
