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

let metricState = {
  driftMs: 0.0,
  jitterMs: 0.0,
  errors: [],
};

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

function updateVolume(newVolumePercent) {
  newVolumePercent = Math.max(0, Math.min(500, newVolumePercent));
  volumeInput.value = newVolumePercent;
  volumeSlider.value = newVolumePercent;

  const volPercent = (newVolumePercent / 500) * 100;

  let trackBg;
  if (newVolumePercent <= 300) {
    trackBg = `linear-gradient(to right, #999 0%, #999 ${volPercent}%, #444 ${volPercent}%, #444 100%)`;
  } else {
    trackBg = `linear-gradient(to right, #999 0%, #999 60%, #f44336 ${volPercent}%, #444 ${volPercent}%, #444 100%)`;
  }
  volumeSlider.style.setProperty('--track-bg', trackBg);

  currentVolume = newVolumePercent / 100;
  if (isPlaying) sendQuantizedSettings();
}

function updateBPM(newBPM) {
  newBPM = Math.max(30, Math.min(300, newBPM));
  currentBPM = newBPM;
  visualState.targetBPM = currentBPM;
  bpmInput.value = currentBPM;
  bpmSlider.value = currentBPM;

  const bpmPercent = ((currentBPM - 30) / (300 - 30)) * 100;
  const trackBg = `linear-gradient(to right, #999 0%, #999 ${bpmPercent}%, #444 ${bpmPercent}%, #444 100%)`;
  bpmSlider.style.setProperty('--track-bg', trackBg);

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
keepAwakeToggle.addEventListener('change', toggleWakeLock);

// 캔버스 컨테이너 클릭 시 재생/정지
canvasContainer.addEventListener('click', () =>
  !isPlaying ? startMetronome() : stopMetronome()
);

if (accToggle) {
  accToggle.addEventListener('change', (e) => {
    isAccentEnabled = e.target.checked;
    if (isPlaying) sendQuantizedSettings();
  });
}

async function ensureAudio() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    audioContext.onstatechange = () => {
      if (
        audioContext.state === 'suspended' ||
        audioContext.state === 'interrupted'
      ) {
        if (isPlaying) {
          stopMetronome();
          if (statusText) statusText.innerHTML = '<span>Interrupted</span>';
        }
      }
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

    metronomeNode.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'tick') {
        noteQueue.push({
          noteTime: msg.audioTime,
          beatIndex: msg.beatIndex,
          bpm: msg.bpm,
          denominator: msg.denominator,
          numerator: msg.numerator,
        });

        if (noteQueue.length > 200) {
          noteQueue.shift();
        }

        metricState.driftMs = msg.driftMs;

        if (
          typeof msg.intervalMs === 'number' &&
          Number.isFinite(msg.intervalMs)
        ) {
          if (msg.appliedPending) {
            metricState.errors = [];
            pendingLabel = null;
            renderStatus();
          }

          let expectedIntervalMs =
            (60.0 / msg.bpm) * (4.0 / msg.denominator) * 1000;
          let error = msg.intervalMs - expectedIntervalMs;

          metricState.errors.push(error);
          if (metricState.errors.length > 50) metricState.errors.shift();

          let sumSq = metricState.errors.reduce(
            (acc, val) => acc + val * val,
            0
          );
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
    };
  }
}

// 상태 렌더링 및 캔버스 애니메이션 클래스 토글
function renderStatus() {
  if (!statusText) return;

  if (!isPlaying) {
    statusText.innerHTML = '<span>Ready</span>';
    // 대기 상태일 때 숨쉬는 애니메이션 클래스 추가
    if (canvasContainer) canvasContainer.classList.add('ready-pulse');
    return;
  }

  // 재생 시작 시 애니메이션 클래스 제거
  if (canvasContainer) canvasContainer.classList.remove('ready-pulse');

  if (pendingLabel) {
    statusText.innerHTML = `<span>Pending</span> <span>${pendingLabel.bpm} BPM, ${pendingLabel.numerator}/${pendingLabel.denominator}</span>`;
    return;
  }

  statusText.innerHTML = `<span>Running</span> <span>${currentBPM} BPM, ${beatsPerBar}/${currentDenominator}</span>`;
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
  visualState.lastBeatTime = 0;
  visualState.currentBeatIndex = 0;
  visualState.flashAlpha = 0;
  pendingLabel = null;

  visualState.playingBPM = currentBPM;
  visualState.playingNumerator = beatsPerBar;
  visualState.playingDenominator = currentDenominator;

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

updateVolume(100);
updateBPM(60);
// 초기 로드 시 대기(Ready) 애니메이션 적용을 위해 호출
renderStatus();

// p5.js 시각화 렌더링
window.setup = function () {
  const canvas = createCanvas(400, 300);
  canvas.parent('canvas-container');
  angleMode(RADIANS);
};

window.draw = function () {
  background('#1a1a1a');
  const currentTime = audioContext ? audioContext.currentTime : 0;

  while (noteQueue.length > 0 && noteQueue[0].noteTime <= currentTime) {
    const currentNote = noteQueue.shift();
    visualState.lastBeatTime = currentNote.noteTime;
    visualState.currentBeatIndex = currentNote.beatIndex;
    visualState.duration =
      (60.0 / currentNote.bpm) * (4.0 / currentNote.denominator);
    visualState.flashAlpha = 255;

    visualState.playingBPM = currentNote.bpm;
    visualState.playingNumerator = currentNote.numerator;
    visualState.playingDenominator = currentNote.denominator;
  }

  let P = 0;
  if (isPlaying && visualState.lastBeatTime > 0) {
    P = (currentTime - visualState.lastBeatTime) / visualState.duration;
    P = constrain(P, 0, 1);
  }

  let maxAngle = PI / 4;
  let directionMultiplier = visualState.currentBeatIndex % 2 === 0 ? 1 : -1;
  let angle = maxAngle * Math.sin(Math.PI * P) * directionMultiplier;

  // --- 상단 LED 비트 인디케이터 ---
  const dNum = isPlaying ? visualState.playingNumerator : beatsPerBar;
  const ledY = 25;
  const ledRadius = 7;

  const maxSwingX = Math.sin(PI / 4) * 205;
  const startX = width / 2 - maxSwingX;
  const endX = width / 2 + maxSwingX;

  for (let i = 0; i < dNum; i++) {
    const x =
      dNum === 1 ? width / 2 : startX + (i * (endX - startX)) / (dNum - 1);
    const isLit = isPlaying && i === visualState.currentBeatIndex;

    if (isLit) {
      if (i === 0 && isAccentEnabled) fill('#f44336'); // 강박
      else fill('#d1d1d1'); // 약박
    } else {
      fill('#333'); // 비활성
    }

    noStroke();
    ellipse(x, ledY, ledRadius * 2, ledRadius * 2);

    if (isLit) {
      let coreColor, coreDiameter;
      if (i === 0 && isAccentEnabled) {
        coreColor = '#ff8a80';
        coreDiameter = ledRadius * 1.4;
      } else {
        coreColor = '#ffffff';
        coreDiameter = ledRadius * 1.3;
      }
      fill(coreColor);
      ellipse(x, ledY, coreDiameter, coreDiameter);
    }
  }

  translate(width / 2, height - 40);

  // 뒤쪽 배경 가이드라인
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

  // 중심축 삼각형
  push();
  noStroke();
  fill(255, 50, 50);
  triangle(-6, -215, 6, -215, 0, -205);
  pop();

  // 바늘(추) 렌더링
  push();
  rotate(angle);

  let needleLength = 190;
  let lollipopY = -140;
  let lollipopSize = 24;

  // 1. 바늘 막대기
  stroke(255);
  strokeWeight(3);
  line(0, 0, 0, -needleLength);

  // 2. 바늘 추 테두리 및 기본 색상 (불 꺼진 상태)
  stroke(255);
  strokeWeight(3);
  fill(100);
  ellipse(0, lollipopY, lollipopSize, lollipopSize);

  // 3. 점등 효과 (테두리 안쪽에서만 빛나도록 LED 스타일 적용)
  if (visualState.flashAlpha > 0) {
    noStroke();
    let isAccent = isAccentEnabled && visualState.currentBeatIndex === 0;

    if (isAccent) {
      fill(244, 67, 54, visualState.flashAlpha);
    } else {
      fill(209, 209, 209, visualState.flashAlpha);
    }
    ellipse(0, lollipopY, lollipopSize - 3, lollipopSize - 3);

    if (isAccent) {
      fill(255, 138, 128, visualState.flashAlpha);
    } else {
      fill(255, 255, 255, visualState.flashAlpha);
    }

    let coreSize = isAccent
      ? (lollipopSize - 3) * 0.7
      : (lollipopSize - 3) * 0.65;
    ellipse(0, lollipopY, coreSize, coreSize);

    visualState.flashAlpha -= 15;
  }

  // 중심축 고정점
  noStroke();
  fill(255);
  ellipse(0, 0, 20, 20);
  fill(100);
  ellipse(0, 0, 8, 8);
  pop();

  resetMatrix();

  // --- 우측 텍스트 ---
  let rightMargin = width - 15;

  let displayBPM = isPlaying ? visualState.playingBPM : currentBPM;
  let displayNum = isPlaying ? visualState.playingNumerator : beatsPerBar;
  let displayDen = isPlaying
    ? visualState.playingDenominator
    : currentDenominator;

  if (pendingLabel) {
    fill('#f44336');
    textSize(14);
    textStyle(BOLD);
    textAlign(RIGHT, BOTTOM);
    text('PENDING', rightMargin, height - 88);
    textStyle(NORMAL);
  }

  textAlign(RIGHT, BOTTOM);
  fill(255);
  textSize(24);
  text(`${displayBPM} BPM`, rightMargin, height - 60);

  textSize(12);
  let val1 = `${displayNum}/${displayDen}`;
  let val2 = `${QUANTIZE_MODE}`;

  let maxValWidth = Math.max(textWidth(val1), textWidth(val2));
  let rightValueX = rightMargin - maxValWidth;
  let rightColonX = rightValueX - 8;

  fill(200);
  textAlign(RIGHT, BOTTOM);
  text('Time Sig :', rightColonX, height - 35);
  textAlign(LEFT, BOTTOM);
  text(val1, rightValueX, height - 35);

  fill(150);
  textAlign(RIGHT, BOTTOM);
  text('Quantize :', rightColonX, height - 15);
  textAlign(LEFT, BOTTOM);
  text(val2, rightValueX, height - 15);

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

  let leftValueX = leftColonX + 60;
  textAlign(RIGHT, BOTTOM);
  text(`${metricState.jitterMs.toFixed(3)} ms`, leftValueX, height - 35);
  text(`${metricState.driftMs.toFixed(3)} ms`, leftValueX, height - 15);
};
