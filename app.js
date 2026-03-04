// app.js

let audioContext = null;
let metronomeNode = null;
let isPlaying = false;
let wakeLock = null;

let currentVolume = 1.0;
let currentBPM = 60;
let beatsPerBar = 4;
let currentDenominator = 4;

const QUANTIZE_MODE = 'bar';

let noteQueue = [];
let visualState = {
  lastBeatTime: 0,
  currentBeatIndex: 0,
  duration: 1.0,
  flashAlpha: 0,
  targetBPM: 60,
};
let pendingLabel = null;

let metricState = {
  driftMs: 0.0,
  jitterMs: 0.0,
  errors: [],
};

// DOM
const playBtn = document.getElementById('play-btn');
const volumeInput = document.getElementById('volume-input');
const volumeSlider = document.getElementById('volume-slider');
const bpmInput = document.getElementById('bpm-input');
const bpmSlider = document.getElementById('bpm-slider');
const bpmUpBtn = document.getElementById('bpm-up');
const bpmDownBtn = document.getElementById('bpm-down');
const stepInput = document.getElementById('step-input');
const beatNumerator = document.getElementById('beat-numerator');
const beatDenominator = document.getElementById('beat-denominator');
const statusText = document.getElementById('status-text');
const keepAwakeToggle = document.getElementById('keep-awake-toggle');

function updateVolume(newVolumePercent) {
  newVolumePercent = Math.max(0, Math.min(300, newVolumePercent));
  volumeInput.value = newVolumePercent;
  volumeSlider.value = newVolumePercent;
  currentVolume = newVolumePercent / 100;
  if (isPlaying) sendQuantizedSettings();
}

function updateBPM(newBPM) {
  newBPM = Math.max(30, Math.min(300, newBPM));
  currentBPM = newBPM;
  visualState.targetBPM = currentBPM;
  bpmInput.value = currentBPM;
  bpmSlider.value = currentBPM;
  if (isPlaying) sendQuantizedSettings();
}

function updateTimeSignature() {
  let n = parseInt(beatNumerator.value);
  if (isNaN(n) || n < 1) n = 1;
  beatsPerBar = n;

  let d = parseInt(beatDenominator.value);
  if (isNaN(d)) d = 4;
  currentDenominator = d;

  if (isPlaying) sendQuantizedSettings();
}

async function toggleWakeLock() {
  if (keepAwakeToggle.checked) {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch (err) {
        keepAwakeToggle.checked = false;
      }
    } else {
      keepAwakeToggle.checked = false;
    }
  } else {
    if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  }
}

volumeSlider.addEventListener('input', (e) =>
  updateVolume(parseInt(e.target.value))
);
volumeInput.addEventListener('change', (e) => {
  let val = parseInt(e.target.value);
  if (isNaN(val)) val = Math.round(currentVolume * 100);
  updateVolume(val);
});
bpmSlider.addEventListener('input', (e) => updateBPM(parseInt(e.target.value)));
bpmInput.addEventListener('change', (e) => {
  let val = parseInt(e.target.value);
  if (isNaN(val)) val = currentBPM;
  updateBPM(val);
});
bpmUpBtn.addEventListener('click', () => {
  let step = parseInt(stepInput.value) || 1;
  updateBPM(currentBPM + step);
});
bpmDownBtn.addEventListener('click', () => {
  let step = parseInt(stepInput.value) || 1;
  updateBPM(currentBPM - step);
});
beatNumerator.addEventListener('change', updateTimeSignature);
beatDenominator.addEventListener('change', updateTimeSignature);
playBtn.addEventListener('click', () =>
  !isPlaying ? startMetronome() : stopMetronome()
);
keepAwakeToggle.addEventListener('change', toggleWakeLock);

async function ensureAudio() {
  if (!audioContext)
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') await audioContext.resume();

  if (!metronomeNode) {
    await audioContext.audioWorklet.addModule(new URL('./metronome-worklet.js', import.meta.url));

    metronomeNode = new AudioWorkletNode(audioContext, 'metronome-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    metronomeNode.connect(audioContext.destination);

    metronomeNode.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'tick') {
        noteQueue.push({
          noteTime: msg.audioTime,
          beatIndex: msg.beatIndex,
          bpm: msg.bpm,
          denominator: msg.denominator,
        });

        metricState.driftMs = msg.driftMs;

        let expectedIntervalMs =
          (60.0 / msg.bpm) * (4.0 / msg.denominator) * 1000;
        let error = msg.intervalMs - expectedIntervalMs;

        metricState.errors.push(error);
        if (metricState.errors.length > 50) metricState.errors.shift();

        let sumSq = 0;
        for (let err of metricState.errors) sumSq += err * err;
        metricState.jitterMs =
          metricState.errors.length > 0
            ? Math.sqrt(sumSq / metricState.errors.length)
            : 0;
      }
      if (msg.type === 'pending') {
        pendingLabel = msg.pending;
        renderStatus();
      }
      if (msg.type === 'applied') {
        pendingLabel = null;
        renderStatus();
      }
    };
  }
}

function renderStatus() {
  if (!statusText) return;

  if (!isPlaying) {
    statusText.textContent = 'Stopped';
    return;
  }

  if (pendingLabel) {
    const q = pendingLabel.quantize === 'bar' ? 'next bar' : 'next beat';
    statusText.textContent = `Pending: ${pendingLabel.bpm} BPM, ${pendingLabel.numerator}/${pendingLabel.denominator} (${q})`;
    return;
  }

  statusText.textContent = `Running: ${currentBPM} BPM, ${beatsPerBar}/${currentDenominator}`;
}

function sendQuantizedSettings() {
  if (!metronomeNode) return;
  metronomeNode.port.postMessage({
    type: 'set',
    bpm: currentBPM,
    numerator: beatsPerBar,
    denominator: currentDenominator,
    volume: currentVolume,
    quantize: QUANTIZE_MODE,
  });
}

async function startMetronome() {
  await ensureAudio();

  noteQueue = [];
  visualState.lastBeatTime = 0;
  visualState.currentBeatIndex = 0;
  visualState.flashAlpha = 0;
  pendingLabel = null;

  metricState.driftMs = 0;
  metricState.jitterMs = 0;
  metricState.errors = [];

  sendQuantizedSettings();
  metronomeNode.port.postMessage({
    type: 'start',
    startDelaySec: 0.05,
    align: true,
  });

  isPlaying = true;
  playBtn.textContent = 'Stop';
  playBtn.classList.add('stop');
  renderStatus();

  if (keepAwakeToggle.checked) {
    try {
      await toggleWakeLock();
    } catch (_) {}
  }
}

function stopMetronome() {
  if (metronomeNode) metronomeNode.port.postMessage({ type: 'stop' });

  isPlaying = false;
  playBtn.textContent = 'Play';
  playBtn.classList.remove('stop');
  pendingLabel = null;
  renderStatus();

  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if (keepAwakeToggle.checked && isPlaying && !wakeLock) {
      if ('wakeLock' in navigator) {
        try {
          wakeLock = await navigator.wakeLock.request('screen');
        } catch (_) {}
      }
    }
  }
});

// p5.js 시각화 렌더링
window.setup = function () {
  const canvas = createCanvas(400, 300);
  canvas.parent('canvas-container');
  angleMode(RADIANS);
};

window.draw = function () {
  background(30);
  const currentTime = audioContext ? audioContext.currentTime : 0;

  while (noteQueue.length > 0 && noteQueue[0].noteTime <= currentTime) {
    const currentNote = noteQueue.shift();
    visualState.lastBeatTime = currentNote.noteTime;
    visualState.currentBeatIndex = currentNote.beatIndex;
    visualState.duration =
      (60.0 / currentNote.bpm) * (4.0 / currentNote.denominator);
    visualState.flashAlpha = 255;
  }

  let P = 0;
  if (isPlaying && visualState.lastBeatTime > 0) {
    P = (currentTime - visualState.lastBeatTime) / visualState.duration;
    P = constrain(P, 0, 1);
  }

  let maxAngle = PI / 4;
  let directionMultiplier = visualState.currentBeatIndex % 2 === 0 ? 1 : -1;
  let angle = maxAngle * Math.sin(Math.PI * P) * directionMultiplier;

  translate(width / 2, height - 40);

  // 1. 양 끝 도달 지점 하얀색 기준선
  push();
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
  pop();

  // 2. 중앙 빨간 삼각형 표시기
  push();
  noStroke();
  fill(255, 50, 50);
  triangle(-6, -215, 6, -215, 0, -205);
  pop();

  // 3. 움직이는 롤리팝 바늘
  push();
  rotate(angle);

  let needleLength = 190;
  let lollipopY = -140;
  let lollipopSize = 24;

  let flashR = 255,
    flashG = 255,
    flashB = 255;
  if (visualState.currentBeatIndex === 0) {
    flashG = 50;
    flashB = 50;
  }

  if (visualState.flashAlpha > 0) {
    noStroke();
    fill(flashR, flashG, flashB, visualState.flashAlpha * 0.4);
    ellipse(0, lollipopY, lollipopSize * 2.5, lollipopSize * 2.5);
  }

  stroke(255);
  strokeWeight(3);
  line(0, 0, 0, -needleLength);

  stroke(255);
  strokeWeight(3);
  fill(100);
  ellipse(0, lollipopY, lollipopSize, lollipopSize);

  if (visualState.flashAlpha > 0) {
    noStroke();
    fill(flashR, flashG, flashB, visualState.flashAlpha);
    ellipse(0, lollipopY, lollipopSize - 3, lollipopSize - 3);
    visualState.flashAlpha -= 15;
  }

  noStroke();
  fill(255);
  ellipse(0, 0, 20, 20);
  fill(100);
  ellipse(0, 0, 8, 8);
  pop();

  resetMatrix();

  // 4. 우측 하단 텍스트 (설정 데이터 콜론 정렬)
  // BPM은 크게 강조하여 우측 끝 기준 정렬 유지
  textAlign(RIGHT, BOTTOM);
  fill(255);
  textSize(24);
  text(`${currentBPM} BPM`, width - 15, height - 60);

  // Time Sig와 Quantize는 사이즈를 통일하고 콜론(:) 기준으로 분할 정렬
  let rightColonX = width - 45; // 레이블이 끝나는(콜론) X좌표
  let rightValueX = width - 40; // 값이 시작되는 X좌표

  textSize(12);

  fill(200);
  textAlign(RIGHT, BOTTOM);
  text('Time Sig :', rightColonX, height - 35);
  textAlign(LEFT, BOTTOM);
  text(`${beatsPerBar}/${currentDenominator}`, rightValueX, height - 35);

  fill(150);
  textAlign(RIGHT, BOTTOM);
  text('Quantize :', rightColonX, height - 15);
  textAlign(LEFT, BOTTOM);
  text(`${QUANTIZE_MODE}`, rightValueX, height - 15);

  // 5. 좌측 하단 텍스트 (계측 데이터 콜론 정렬)
  let leftColonX = 55; // 레이블이 끝나는(콜론) X좌표
  let leftValueX = 60; // 값이 시작되는 X좌표

  fill(150);
  textSize(12);

  // 레이블 우측 정렬
  textAlign(RIGHT, BOTTOM);
  text('Jitter :', leftColonX, height - 35);
  text('Drift :', leftColonX, height - 15);

  // 값 좌측 정렬
  textAlign(LEFT, BOTTOM);
  text(`${metricState.jitterMs.toFixed(3)} ms`, leftValueX, height - 35);
  text(`${metricState.driftMs.toFixed(3)} ms`, leftValueX, height - 15);
};
