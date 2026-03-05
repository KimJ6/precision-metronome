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

// DOM
const playBtn = document.getElementById('play-btn');
const iconPlay = document.getElementById('icon-play');
const iconStop = document.getElementById('icon-stop');
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
  newVolumePercent = Math.max(0, Math.min(300, newVolumePercent));
  volumeInput.value = newVolumePercent;
  volumeSlider.value = newVolumePercent;

  const volPercent = (newVolumePercent / 300) * 100;
  volumeSlider.style.setProperty('--val', `${volPercent}%`);

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
  bpmSlider.style.setProperty('--val', `${bpmPercent}%`);

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

// (next bar) 안내 문구 제거 로직 반영
function renderStatus() {
  if (!statusText) return;

  if (!isPlaying) {
    statusText.innerHTML = '<span>Ready</span>';
    return;
  }

  if (pendingLabel) {
    // [개선] (next bar) 문구를 제거하여 시각적으로 더 깔끔하게 표시
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

  if (playBtn) playBtn.classList.add('stop');
  if (iconPlay) iconPlay.style.display = 'none';
  if (iconStop) iconStop.style.display = 'block';
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

  if (playBtn) playBtn.classList.remove('stop');
  if (iconPlay) iconPlay.style.display = 'block';
  if (iconStop) iconStop.style.display = 'none';

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

  translate(width / 2, height - 40);

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

  push();
  noStroke();
  fill(255, 50, 50);
  triangle(-6, -215, 6, -215, 0, -205);
  pop();

  push();
  rotate(angle);

  let needleLength = 190;
  let lollipopY = -140;
  let lollipopSize = 24;

  let flashR = 255,
    flashG = 255,
    flashB = 255;

  if (isAccentEnabled && visualState.currentBeatIndex === 0) {
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

  let leftColonX = 55;
  let leftValueX = 115;

  fill(100);
  textSize(10);
  textAlign(LEFT, BOTTOM);
  text('Engine', 15, height - 55);

  fill(150);
  textSize(12);
  textAlign(RIGHT, BOTTOM);
  text('Jitter :', leftColonX, height - 35);
  text('Drift :', leftColonX, height - 15);

  textAlign(RIGHT, BOTTOM);
  text(`${metricState.jitterMs.toFixed(3)} ms`, leftValueX, height - 35);
  text(`${metricState.driftMs.toFixed(3)} ms`, leftValueX, height - 15);
};
