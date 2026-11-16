export const geminiEndpoint =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const geminiWorker = {
  fetch(request) {
    if (request.method !== 'POST' || request.url !== geminiEndpoint) {
      return new Response(null, { status: 404 });
    }
    const authorization = request.headers.get('authorization');
    if (!authorization) return new Response(null, { status: 401 });

    return fetch(geminiEndpoint, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: request.body,
      signal: request.signal,
      redirect: 'manual',
    });
  },
};

export default geminiWorker;
