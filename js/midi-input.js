// MIDI 컨트롤러 입력(Web MIDI): 컨트롤 체인지(CC) 값을 기억해 파라미터 연결(links.js)의 'MIDI' 소스가 읽는다.
// 처음 쓸 때 start()로 권한을 받는다(브라우저가 물을 수 있다). 모든 입력 장치의 메시지를 받는다.
//   value(channel, cc) → 0~1(아직 그 컨트롤러가 움직인 적 없으면 null). channel 0 = 아무 채널(마지막으로 받은 값)
//   learn(callback) → 다음으로 움직인 컨트롤러 {channel, cc}를 한 번 알려 준다(연결의 '학습' 버튼)
// 메시지를 해석하는 일(parse)은 순수 함수라 node에서 검사한다.
const parse = data => {
  if (!data || data.length < 3) return null;
  const status = data[0] & 0xf0,
    channel = (data[0] & 0x0f) + 1;
  return status === 0xb0 ? { channel, cc: data[1] & 0x7f, value: (data[2] & 0x7f) / 127 } : null;
};

const create = ({ onChange = () => {}, requestAccess = () => navigator.requestMIDIAccess?.() } = {}) => {
  const values = new Map(); // "채널:cc" → 0~1, "0:cc" → 그 cc의 마지막 값(아무 채널)
  let access = null,
    state = "off", // off · starting · on · error
    error = "",
    learner = null,
    last = null; // 마지막으로 받은 CC { channel, cc, value } — 연결 시트의 상태 표시
  const receive = event => {
    const message = parse(event.data);
    if (!message) return;
    values.set(`${message.channel}:${message.cc}`, message.value);
    values.set(`0:${message.cc}`, message.value);
    last = message;
    if (learner) {
      const callback = learner;
      learner = null;
      callback({ channel: message.channel, cc: message.cc });
    }
  };
  const attach = () => {
    for (const input of access.inputs.values()) input.onmidimessage = receive;
  };
  const start = async () => {
    if (state === "on" || state === "starting") return state === "on";
    state = "starting";
    onChange();
    try {
      const granted = await requestAccess();
      if (!granted) throw new Error("이 브라우저는 Web MIDI를 지원하지 않습니다(Chrome · Edge에서 쓸 수 있습니다).");
      access = granted;
      attach();
      access.onstatechange = () => {
        attach(); // 새로 꽂은 장치
        onChange();
      };
      state = "on";
      error = "";
    } catch (failure) {
      state = "error";
      error = failure?.name === "SecurityError" ? "MIDI 권한이 거부되었습니다." : String(failure?.message || failure);
    }
    onChange();
    return state === "on";
  };
  const value = (channel, cc) => values.get(`${channel || 0}:${cc}`) ?? null;
  const learn = callback => {
    learner = callback;
  };
  const cancelLearn = () => {
    learner = null;
  };
  const devices = () => (access ? [...access.inputs.values()].map(input => input.name || "MIDI 장치") : []);
  return {
    start,
    value,
    learn,
    cancelLearn,
    status: () => ({ state, error, devices: devices(), last: last && { ...last } }),
  };
};

export { create, parse };
