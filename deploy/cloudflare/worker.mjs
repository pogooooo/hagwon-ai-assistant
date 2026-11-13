const worker = {
  fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('새 학원 데모 주소에서 다시 로그인해 주세요.', {
        status: 405,
        headers: {
          Allow: 'GET, HEAD',
          'Content-Type': 'text/plain; charset=utf-8',
        },
      });
    }
    return Response.redirect(new URL('/login', env.AXR_HOSTED_ORIGIN), 302);
  },
};

export default worker;
