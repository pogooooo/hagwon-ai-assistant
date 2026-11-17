(() => {
  const form = document.querySelector('[data-voice-form]');
  const status = document.querySelector('[data-voice-status]');
  const start = document.querySelector('[data-record]');
  const stop = document.querySelector('[data-stop]');
  let stream,
    context,
    node,
    timer,
    chunks = [],
    recording = false,
    starting = false,
    captureEpoch = 0;
  const cleanup = () => {
    captureEpoch++;
    starting = false;
    recording = false;
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    node?.disconnect();
    if (context && context.state !== 'closed') void context.close();
    if (start) start.hidden = false;
    if (start) start.disabled = false;
    if (stop) stop.hidden = true;
  };
  function wav(samples, rate) {
    const length = Math.min(
      960000,
      Math.floor((samples.length * 16000) / rate),
    );
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    const text = (at, value) =>
      [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, length * 2, true);
    for (let i = 0; i < length; i++) {
      const from = Math.floor((i * rate) / 16000),
        to = Math.max(from + 1, Math.floor(((i + 1) * rate) / 16000));
      let total = 0;
      for (let n = from; n < to; n++) total += samples[n] || 0;
      view.setInt16(
        44 + i * 2,
        Math.max(-1, Math.min(1, total / (to - from))) * 32767,
        true,
      );
    }
    return new File([buffer], 'question.wav', { type: 'audio/wav' });
  }
  const finish = () => {
    if (!recording) return;
    const rate = context.sampleRate;
    const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    cleanup();
    chunks = [];
    if (samples.length < rate / 3) {
      status.textContent = '조금 더 길게 말씀해 주세요.';
      return;
    }
    const files = new DataTransfer();
    files.items.add(wav(samples, rate));
    form.querySelector('[data-voice-file]').files = files.files;
    status.textContent = '음성을 인식하고 있습니다.';
    form.requestSubmit();
  };
  start?.addEventListener('click', async () => {
    if (starting || recording) return;
    starting = true;
    start.disabled = true;
    const epoch = ++captureEpoch;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error();
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (epoch !== captureEpoch) {
        nextStream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = nextStream;
      context = new AudioContext();
      await context.audioWorklet.addModule('/voice-worklet.js');
      if (epoch !== captureEpoch) return;
      node = new AudioWorkletNode(context, 'axr-voice-recorder');
      chunks = [];
      recording = true;
      node.port.onmessage = ({ data }) => {
        if (recording) chunks.push(data);
      };
      const mute = context.createGain();
      mute.gain.value = 0;
      context
        .createMediaStreamSource(stream)
        .connect(node)
        .connect(mute)
        .connect(context.destination);
      await context.resume();
      if (epoch !== captureEpoch) return;
      starting = false;
      start.hidden = true;
      stop.hidden = false;
      status.textContent = '말씀해 주세요. 최대 60초 후 자동 종료됩니다.';
      timer = setTimeout(finish, 60000);
    } catch {
      if (epoch !== captureEpoch) return;
      cleanup();
      status.textContent =
        '마이크를 사용할 수 없습니다. 질문을 글로 입력해 주세요.';
    }
  });
  stop?.addEventListener('click', finish);
  window.addEventListener('pagehide', cleanup);
  document.querySelectorAll('[data-speak]').forEach((button) =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      let playbackUrl;
      try {
        const body = new FormData();
        body.set('action', 'audio');
        body.set('turnId', button.dataset.speak);
        const response = await fetch('/voice', { method: 'POST', body });
        if (
          !response.ok ||
          !response.headers.get('content-type')?.startsWith('audio/')
        )
          throw new Error();
        const url = URL.createObjectURL(await response.blob()),
          audio = new Audio(url);
        playbackUrl = url;
        const done = () => {
          URL.revokeObjectURL(url);
          button.disabled = false;
        };
        audio.onended = done;
        audio.onerror = done;
        await audio.play();
      } catch {
        if (playbackUrl) URL.revokeObjectURL(playbackUrl);
        status.textContent =
          '음성을 재생하지 못했습니다. 화면의 글 답변을 확인해 주세요.';
        button.disabled = false;
      }
    }),
  );
})();
