// app.js

let audioContext = null;
let metronomeNode = null; // AudioWorkletNode
let isWorkletLoaded = false;
let isPlaying = false;
let wakeLock = null;

let currentVolume = 1.0;
let currentBPM = 60;
let beatsPerBar = 4;
let currentDenominator = 4;

let noteQueue = []; // UI 시각화 동기화용 큐

let visualState = {
  lastBeatTime: 0,
  currentBeatIndex: 0,
  duration: 1.0,
  flashAlpha: 0,
  targetBPM: 60,
};

// --- DOM 요소 ---
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

// --- 상태 업데이트 및 Worklet으로 전송 ---
function syncParamsToWorklet() {
  if (metronomeNode) {
    metronomeNode.port.postMessage({
      type: 'update',
      bpm: currentBPM,
      beatsPerBar: beatsPerBar,
      denominator: currentDenominator,
      volume: currentVolume,
    });
  }
}

function updateVolume(newVolume) {
  newVolume = Math.max(0, Math.min(300, newVolume));
  volumeInput.value = newVolume;
  volumeSlider.value = newVolume;
  currentVolume = newVolume / 100.0;
  syncParamsToWorklet();
}

function updateBPM(newBPM) {
  newBPM = Math.max(30, Math.min(300, newBPM));
  currentBPM = newBPM;
  visualState.targetBPM = currentBPM;
  bpmInput.value = currentBPM;
  bpmSlider.value = currentBPM;
  syncParamsToWorklet();
}

function updateTimeSignature() {
  let n = parseInt(beatNumerator.value);
  if (isNaN(n) || n < 1) n = 1;
  beatsPerBar = n;
  currentDenominator = parseInt(beatDenominator.value);
  syncParamsToWorklet();
}

// --- 화면 꺼짐 방지(Wake Lock) ---
async function toggleWakeLock() {
  if (keepAwakeToggle.checked) {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch (err) {
        keepAwakeToggle.checked = false;
      }
    } else {
      alert(
        '사용 중인 브라우저에서는 화면 꺼짐 방지 기능을 지원하지 않습니다.'
      );
      keepAwakeToggle.checked = false;
    }
  } else {
    if (wakeLock !== null) {
      wakeLock.release().then(() => {
        wakeLock = null;
      });
    }
  }
}

// --- 이벤트 리스너 ---
volumeSlider.addEventListener('input', (e) =>
  updateVolume(parseInt(e.target.value))
);
volumeInput.addEventListener('change', (e) =>
  updateVolume(parseInt(e.target.value) || 100)
);

bpmSlider.addEventListener('input', (e) => updateBPM(parseInt(e.target.value)));
bpmInput.addEventListener('change', (e) =>
  updateBPM(parseInt(e.target.value) || currentBPM)
);
bpmUpBtn.addEventListener('click', () =>
  updateBPM(currentBPM + (parseInt(stepInput.value) || 1))
);
bpmDownBtn.addEventListener('click', () =>
  updateBPM(currentBPM - (parseInt(stepInput.value) || 1))
);

beatNumerator.addEventListener('change', updateTimeSignature);
beatDenominator.addEventListener('change', updateTimeSignature);
keepAwakeToggle.addEventListener('change', toggleWakeLock);

playBtn.addEventListener('click', () => {
  if (!isPlaying) startMetronome();
  else stopMetronome();
});

// --- 핵심 로직: AudioWorklet 초기화 및 구동 ---
async function initAudioEngine() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  if (!isWorkletLoaded) {
    statusText.textContent = 'Loading Engine...';
    // Vite 환경에 맞춘 모듈 로드 방식
    await audioContext.audioWorklet.addModule(
      new URL('./metronome-worklet.js', import.meta.url)
    );

    metronomeNode = new AudioWorkletNode(audioContext, 'metronome-processor');
    metronomeNode.connect(audioContext.destination);

    // Worklet으로부터 정확한 틱 발생 시점을 수신하여 시각화 큐에 푸시
    metronomeNode.port.onmessage = (e) => {
      if (e.data.type === 'tick') {
        noteQueue.push({
          noteTime: e.data.time,
          beatIndex: e.data.beatIndex,
          bpm: e.data.bpm,
          denominator: e.data.denominator,
        });
      }
    };

    // 실제 하드웨어 샘플레이트 전달 및 초기 파라미터 동기화
    metronomeNode.port.postMessage({
      type: 'init',
      sampleRate: audioContext.sampleRate,
    });
    syncParamsToWorklet();
    isWorkletLoaded = true;
  }
}

async function startMetronome() {
  await initAudioEngine();

  isPlaying = true;
  playBtn.textContent = 'Stop';
  playBtn.classList.add('stop');
  statusText.textContent = 'AudioWorklet Active';

  noteQueue = [];
  metronomeNode.port.postMessage({ type: 'start' });
}

function stopMetronome() {
  isPlaying = false;
  playBtn.textContent = 'Play';
  playBtn.classList.remove('stop');
  statusText.textContent = 'Stopped';

  if (metronomeNode) {
    metronomeNode.port.postMessage({ type: 'stop' });
  }
  noteQueue = [];
  if (audioContext) audioContext.suspend();
}

// 화면 백그라운드 전환/복귀 대응
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if (isPlaying && audioContext) {
      const currentTime = audioContext.currentTime;
      while (noteQueue.length > 0 && noteQueue[0].noteTime < currentTime) {
        let pastNote = noteQueue.shift();
        visualState.lastBeatTime = pastNote.noteTime;
        visualState.currentBeatIndex = pastNote.beatIndex;
        visualState.duration =
          (60.0 / pastNote.bpm) * (4.0 / pastNote.denominator);
      }
    }
    if (keepAwakeToggle.checked && 'wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch (err) {}
    }
  }
});

// --- p5.js 시각화 렌더링 ---
window.setup = function () {
  const canvas = createCanvas(400, 300);
  canvas.parent('canvas-container');
  angleMode(RADIANS);
  textAlign(CENTER, CENTER);
};

window.draw = function () {
  background(30);

  let currentTime = audioContext ? audioContext.currentTime : 0;

  while (noteQueue.length > 0 && noteQueue[0].noteTime <= currentTime) {
    let currentNote = noteQueue.shift();
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
  } else if (!isPlaying) {
    P = 0;
  }

  let maxAngle = PI / 4;
  let directionMultiplier = visualState.currentBeatIndex % 2 === 0 ? 1 : -1;
  let angle = maxAngle * Math.sin(Math.PI * P) * directionMultiplier;

  translate(width / 2, height - 40);

  // 양 끝 도달 지점 하얀색 기준선
  push();
  stroke(255);
  strokeWeight(4);
  push();
  rotate(-maxAngle);
  line(0, -215, 0, -225);
  pop();
  push();
  rotate(maxAngle);
  line(0, -215, 0, -225);
  pop();
  pop();

  // 중앙 빨간 삼각형 표시기
  push();
  noStroke();
  fill(255, 50, 50);
  triangle(-6, -225, 6, -225, 0, -215);
  pop();

  if (visualState.flashAlpha > 0) {
    noStroke();
    if (visualState.currentBeatIndex === 0) {
      fill(255, 50, 50, visualState.flashAlpha);
    } else {
      fill(50, 255, 50, visualState.flashAlpha);
    }
    circle(0, -height / 2, 100);
    visualState.flashAlpha -= 15;
  }

  rotate(angle);
  stroke(200);
  strokeWeight(6);
  line(0, 0, 0, -200);

  noStroke();
  fill(255, 150, 0);
  circle(0, -180, 30);

  fill(100);
  circle(0, 0, 20);
};
