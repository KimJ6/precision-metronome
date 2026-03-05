// app.js

let audioContext = null;
let metronomeNode = null;
let isPlaying = false;
let wakeLock = null;

let currentVolume = 1.0;
let currentBPM = 60;
let beatsPerBar = 4;
let currentDenominator = 4;
let isAccentEnabled = true;

const QUANTIZE_MODE = 'bar';

let noteQueue = [];
let visualState = {
  lastBeatTime: 0,
  currentBeatIndex: 0,
  duration: 1.0,
  flashAlpha: 0,
  targetBPM: 60,
  playingBPM: 60,
  playingNumerator: 4,
  playingDenominator: 4,
};
let pendingLabel = null;

let metricState = { driftMs: 0.0, jitterMs: 0.0, errors: [] };

// DOM 요소
const canvasContainer = document.getElementById('canvas-container');
const volumeInput = document.getElementById('volume-input');
const volumeSlider = document.getElementById('volume-slider');
const bpmInput = document.getElementById('bpm-input');
const bpmSlider = document.getElementById('bpm-slider');
const bpmUpBtn = document.getElementById('bpm-up');
const bpmDownBtn = document.getElementById('bpm-down');
const stepInput = document.getElementById('step-input');
const beatNumerator = document.getElementById('beat-numerator');
const beatDenominator = document.getElementById('beat-denominator');
const accToggle = document.getElementById('acc-toggle');
const statusText = document.getElementById('status-text');
const keepAwakeToggle = document.getElementById('keep-awake-toggle');

function updateVolume(val) {
  val = Math.max(0, Math.min(500, parseInt(val) || 0));
  volumeInput.value = val;
  volumeSlider.value = val;
  currentVolume = val / 100;

  const volPercent = (val / 500) * 100;
  let trackBg =
    val <= 300
      ? `linear-gradient(to right, #999 ${volPercent}%, #444 ${volPercent}%)`
      : `linear-gradient(to right, #999 60%, #f44336 ${volPercent}%, #444 ${volPercent}%)`;
  volumeSlider.style.setProperty('--track-bg', trackBg);
  if (isPlaying) sendQuantizedSettings();
}

function updateBPM(val) {
  val = Math.max(30, Math.min(300, parseInt(val) || 60));
  currentBPM = val;
  visualState.targetBPM = val;
  bpmInput.value = val;
  bpmSlider.value = val;

  const bpmPercent = ((val - 30) / 270) * 100;
  bpmSlider.style.setProperty(
    '--track-bg',
    `linear-gradient(to right, #999 ${bpmPercent}%, #444 ${bpmPercent}%)`
  );
  if (isPlaying) sendQuantizedSettings();
}

function updateTimeSignature() {
  let n = Math.max(1, Math.min(32, parseInt(beatNumerator.value) || 4));
  beatNumerator.value = n;
  beatsPerBar = n;

  let d = parseInt(beatDenominator.value) || 4;
  currentDenominator = d;

  if (isPlaying) sendQuantizedSettings();
}

async function toggleWakeLock() {
  if (keepAwakeToggle.checked && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      keepAwakeToggle.checked = false;
    }
  } else if (wakeLock) {
    await wakeLock.release();
    wakeLock = null;
  }
}

volumeSlider.addEventListener('input', (e) => updateVolume(e.target.value));
volumeInput.addEventListener('change', (e) => updateVolume(e.target.value));
bpmSlider.addEventListener('input', (e) => updateBPM(e.target.value));
bpmInput.addEventListener('change', (e) => updateBPM(e.target.value));
bpmUpBtn.addEventListener('click', () =>
  updateBPM(currentBPM + (parseInt(stepInput.value) || 1))
);
bpmDownBtn.addEventListener('click', () =>
  updateBPM(currentBPM - (parseInt(stepInput.value) || 1))
);
beatNumerator.addEventListener('change', updateTimeSignature);
beatDenominator.addEventListener('change', updateTimeSignature);
keepAwakeToggle.addEventListener('change', toggleWakeLock);
canvasContainer.addEventListener('click', () =>
  !isPlaying ? startMetronome() : stopMetronome()
);
accToggle.addEventListener('change', (e) => {
  isAccentEnabled = e.target.checked;
  if (isPlaying) sendQuantizedSettings();
});

async function ensureAudio() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    audioContext.onstatechange = () => {
      if (audioContext.state !== 'running' && isPlaying) stopMetronome();
    };
  }
  if (audioContext.state === 'suspended') await audioContext.resume();
  if (!metronomeNode) {
    await audioContext.audioWorklet.addModule(
      new URL('./metronome-worklet.js', import.meta.url).href
    );
    metronomeNode = new AudioWorkletNode(audioContext, 'metronome-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    metronomeNode.connect(audioContext.destination);
    metronomeNode.port.onmessage = (e) => handleWorkletMessage(e.data);
  }
}

function handleWorkletMessage(msg) {
  if (msg.type === 'tick') {
    noteQueue.push(msg);
    if (noteQueue.length > 200) noteQueue.shift();

    metricState.driftMs = msg.driftMs;

    if (msg.appliedPending) {
      metricState.errors = [];
      pendingLabel = null;
      renderStatus();
    }

    if (typeof msg.intervalMs === 'number' && Number.isFinite(msg.intervalMs)) {
      let expected = (60.0 / msg.bpm) * (4.0 / msg.denominator) * 1000;
      let err = msg.intervalMs - expected;

      metricState.errors.push(err);
      if (metricState.errors.length > 50) metricState.errors.shift();

      let sumSq = metricState.errors.reduce((a, b) => a + b * b, 0);
      metricState.jitterMs =
        metricState.errors.length > 0
          ? Math.sqrt(sumSq / metricState.errors.length)
          : 0;
    }
  }
  if (msg.type === 'pending') {
    pendingLabel = msg.pending;
    renderStatus();
  }
}

function renderStatus() {
  if (!statusText) return;
  if (!isPlaying) {
    statusText.innerHTML = '<span>Ready</span>';
    canvasContainer.classList.add('ready-pulse');
    return;
  }
  canvasContainer.classList.remove('ready-pulse');
  statusText.innerHTML = pendingLabel
    ? `<span>Pending</span> <span>${pendingLabel.bpm} BPM, ${pendingLabel.numerator}/${pendingLabel.denominator}</span>`
    : `<span>Running</span> <span>${currentBPM} BPM, ${beatsPerBar}/${currentDenominator}</span>`;
}

function sendQuantizedSettings() {
  if (!metronomeNode) return;
  metronomeNode.port.postMessage({
    type: 'set',
    bpm: currentBPM,
    numerator: beatsPerBar,
    denominator: currentDenominator,
    volume: currentVolume,
    accentEnabled: isAccentEnabled,
  });
}

async function startMetronome() {
  await ensureAudio();
  noteQueue = [];
  visualState.flashAlpha = 0;
  pendingLabel = null;
  visualState.playingBPM = currentBPM;
  visualState.playingNumerator = beatsPerBar;
  visualState.playingDenominator = currentDenominator;
  metricState.errors = [];
  sendQuantizedSettings();
  metronomeNode.port.postMessage({
    type: 'start',
    startDelaySec: 0.05,
    align: true,
  });
  isPlaying = true;
  renderStatus();
  if (keepAwakeToggle.checked) toggleWakeLock();
}

function stopMetronome() {
  if (metronomeNode) metronomeNode.port.postMessage({ type: 'stop' });
  isPlaying = false;
  pendingLabel = null;
  renderStatus();
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

updateVolume(100);
updateBPM(60);
renderStatus();

window.setup = function () {
  const canvas = createCanvas(400, 300);
  canvas.parent('canvas-container');
  angleMode(RADIANS);
};

window.draw = function () {
  background('#1a1a1a');
  const currentTime = audioContext ? audioContext.currentTime : 0;

  while (noteQueue.length > 0 && noteQueue[0].audioTime <= currentTime) {
    const q = noteQueue.shift();
    visualState.lastBeatTime = q.audioTime;
    visualState.currentBeatIndex = q.beatIndex;
    visualState.duration = (60.0 / q.bpm) * (4.0 / q.denominator);
    visualState.flashAlpha = 255;
    visualState.playingBPM = q.bpm;
    visualState.playingNumerator = q.numerator;
    visualState.playingDenominator = q.denominator;
  }

  let P =
    isPlaying && visualState.lastBeatTime > 0
      ? constrain(
          (currentTime - visualState.lastBeatTime) / visualState.duration,
          0,
          1
        )
      : 0;
  let maxAngle = PI / 4;
  let angle =
    maxAngle *
    Math.sin(Math.PI * P) *
    (visualState.currentBeatIndex % 2 === 0 ? 1 : -1);

  // --- 개선: 상단 LED 비트 인디케이터 (레이어링 및 크기 확장 적용) ---
  const dNum = isPlaying ? visualState.playingNumerator : beatsPerBar;
  const maxSwingX = Math.sin(PI / 4) * 205;
  const startX = width / 2 - maxSwingX;
  const endX = width / 2 + maxSwingX;
  const ledY = 25;

  // 1단계: 비활성 도트(꺼진 도트)들을 먼저 렌더링
  for (let i = 0; i < dNum; i++) {
    const isLit = isPlaying && i === visualState.currentBeatIndex;
    if (isLit) continue; // 켜진 도트는 최상단에 그리기 위해 1단계에서는 생략

    const x =
      dNum === 1 ? width / 2 : startX + (i * (endX - startX)) / (dNum - 1);
    noStroke();
    // 꺼진 도트는 반투명하게 처리하여 활성 도트가 더 돋보이게 함
    fill(51, 51, 51, 150);
    ellipse(x, ledY, 14, 14);
  }

  // 2단계: 점등된 도트(켜진 도트)를 최상단에 렌더링
  if (isPlaying && visualState.currentBeatIndex < dNum) {
    const i = visualState.currentBeatIndex;
    const x =
      dNum === 1 ? width / 2 : startX + (i * (endX - startX)) / (dNum - 1);
    const isAcc = i === 0 && isAccentEnabled;

    noStroke();
    // 활성 도트는 기본 크기(14px)보다 살짝 더 큰 17px로 스케일업(팝업 효과)
    fill(isAcc ? '#f44336' : '#d1d1d1');
    ellipse(x, ledY, 17, 17);

    // 활성 도트의 빛나는 코어 부분도 비율에 맞춰 스케일업
    fill(isAcc ? '#ff8a80' : '#ffffff');
    ellipse(x, ledY, isAcc ? 12 : 11, isAcc ? 12 : 11);
  }
  // -----------------------------------------------------------------

  translate(width / 2, height - 40);
  stroke(255);
  strokeWeight(4);
  push();
  rotate(-maxAngle);
  line(0, -200, 0, -210);
  pop();
  push();
  rotate(maxAngle);
  line(0, -200, 0, -210);
  pop();
  noStroke();
  fill(255, 50, 50);
  triangle(-6, -215, 6, -215, 0, -205);

  push();
  rotate(angle);
  stroke(255);
  strokeWeight(3);
  line(0, 0, 0, -190);
  fill(100);
  ellipse(0, -140, 24, 24);
  if (visualState.flashAlpha > 0) {
    let isAcc = isAccentEnabled && visualState.currentBeatIndex === 0;
    noStroke();
    fill(
      isAcc ? 244 : 209,
      isAcc ? 67 : 209,
      isAcc ? 54 : 209,
      visualState.flashAlpha
    );
    ellipse(0, -140, 21, 21);
    fill(255, isAcc ? 138 : 255, isAcc ? 128 : 255, visualState.flashAlpha);
    ellipse(0, -140, isAcc ? 15 : 14, isAcc ? 15 : 14);
    visualState.flashAlpha -= 15;
  }
  fill(255);
  noStroke();
  ellipse(0, 0, 20, 20);
  fill(100);
  ellipse(0, 0, 8, 8);
  pop();

  resetMatrix();

  // --- 우측 텍스트 ---
  let rightMargin = width - 15;
  fill(255);
  textSize(24);
  textAlign(RIGHT, BOTTOM);
  text(
    `${isPlaying ? visualState.playingBPM : currentBPM} BPM`,
    rightMargin,
    height - 60
  );
  textSize(12);
  fill(200);
  text(
    `Time Sig : ${isPlaying ? visualState.playingNumerator : beatsPerBar}/${
      isPlaying ? visualState.playingDenominator : currentDenominator
    }`,
    rightMargin,
    height - 35
  );
  fill(150);
  text(`Quantize : ${QUANTIZE_MODE}`, rightMargin, height - 15);

  // --- 좌측 텍스트 ---
  let leftMargin = 15;
  fill(100);
  textSize(10);
  textAlign(LEFT, BOTTOM);
  text('Engine', leftMargin, height - 55);

  fill(150);
  textSize(12);
  let leftLbl1 = 'Jitter :';
  let leftLbl2 = 'Drift :';

  let maxLeftLblWidth = Math.max(textWidth(leftLbl1), textWidth(leftLbl2));
  let leftColonX = leftMargin + maxLeftLblWidth;

  textAlign(RIGHT, BOTTOM);
  text(leftLbl1, leftColonX, height - 35);
  text(leftLbl2, leftColonX, height - 15);

  let leftValueX = leftColonX + 70;
  textAlign(RIGHT, BOTTOM);
  text(`${metricState.jitterMs.toFixed(3)} ms`, leftValueX, height - 35);
  text(`${metricState.driftMs.toFixed(3)} ms`, leftValueX, height - 15);
};
