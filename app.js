// app.js

// --- 시스템 상태 및 동기화 변수 ---
let audioContext = null;
let worker = null;
let isPlaying = false;
let wakeLock = null; // [추가됨] 화면 꺼짐 방지 잠금 객체

let currentVolume = 1.0;
let currentBPM = 60;
let beatsPerBar = 4;
let currentDenominator = 4;
let currentBeatIndex = 0;
let nextNoteTime = 0.0;
let lookahead = 25.0;
let scheduleAheadTime = 0.1;

// UI 동기화를 위한 데이터 큐
let noteQueue = [];

// 시각화 렌더링을 위한 현재 진행 상태
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
const keepAwakeToggle = document.getElementById('keep-awake-toggle'); // [추가됨] 화면 꺼짐 방지 토글

// --- 상태 업데이트 함수 ---
function updateVolume(newVolume) {
  newVolume = Math.max(0, Math.min(300, newVolume));
  volumeInput.value = newVolume;
  volumeSlider.value = newVolume;
  currentVolume = newVolume / 100.0;
}

function updateBPM(newBPM) {
  newBPM = Math.max(30, Math.min(300, newBPM));
  currentBPM = newBPM;
  visualState.targetBPM = currentBPM;
  bpmInput.value = currentBPM;
  bpmSlider.value = currentBPM;
}

function updateTimeSignature() {
  let n = parseInt(beatNumerator.value);
  if (isNaN(n) || n < 1) n = 1;
  beatsPerBar = n;
  currentDenominator = parseInt(beatDenominator.value);
}

// --- [추가됨] 화면 꺼짐 방지(Wake Lock) 제어 함수 ---
async function toggleWakeLock() {
  if (keepAwakeToggle.checked) {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        console.log('Wake Lock 활성화됨');
      } catch (err) {
        console.error(`Wake Lock 요청 실패: ${err.name}, ${err.message}`);
        keepAwakeToggle.checked = false; // 실패 시 토글 원복
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
        console.log('Wake Lock 해제됨');
      });
    }
  }
}

// --- 이벤트 리스너 ---
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

playBtn.addEventListener('click', () => {
  if (!isPlaying) startMetronome();
  else stopMetronome();
});

// 화면 꺼짐 방지 토글 이벤트 연결
keepAwakeToggle.addEventListener('change', toggleWakeLock);

// --- 핵심 로직: 오디오 스케줄링 ---
function startMetronome() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = function (e) {
      if (e.data === 'tick') scheduler();
    };
  }

  isPlaying = true;
  playBtn.textContent = 'Stop';
  playBtn.classList.add('stop');
  statusText.textContent = 'Running';

  currentBeatIndex = 0;
  nextNoteTime = audioContext.currentTime + 0.05;
  noteQueue = [];

  worker.postMessage('start');
}

function stopMetronome() {
  isPlaying = false;
  playBtn.textContent = 'Play';
  playBtn.classList.remove('stop');
  statusText.textContent = 'Stopped';

  if (worker) worker.postMessage('stop');
  noteQueue = [];

  if (audioContext) audioContext.suspend();
}

function scheduleNote(beatNumber, time) {
  noteQueue.push({
    noteTime: time,
    beatIndex: beatNumber,
    bpm: currentBPM,
    denominator: currentDenominator,
  });

  if (noteQueue.length > 0) {
    let latestScheduled = noteQueue[noteQueue.length - 1];
    if (latestScheduled.bpm !== visualState.targetBPM) {
      statusText.textContent = `Queuing: ${latestScheduled.bpm} BPM...`;
    } else {
      statusText.textContent = `Look-ahead: ${noteQueue.length} notes`;
    }
  }

  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();

  osc.connect(gain);
  gain.connect(audioContext.destination);

  osc.frequency.value = beatNumber === 0 ? 1000 : 800;

  if (currentVolume > 0) {
    gain.gain.setValueAtTime(currentVolume, time);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, currentVolume * 0.001),
      time + 0.05
    );
  } else {
    gain.gain.setValueAtTime(0, time);
  }

  osc.start(time);
  osc.stop(time + 0.05);
}

function nextNote() {
  const secondsPerBeat = (60.0 / currentBPM) * (4.0 / currentDenominator);

  nextNoteTime += secondsPerBeat;
  currentBeatIndex++;
  if (currentBeatIndex >= beatsPerBar) {
    currentBeatIndex = 0;
  }
}

function scheduler() {
  while (nextNoteTime < audioContext.currentTime + scheduleAheadTime) {
    scheduleNote(currentBeatIndex, nextNoteTime);
    nextNote();
  }
}

// 화면 백그라운드 전환/복귀 대응 (시각화 동기화 및 Wake Lock 복원)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    // 1. 오디오-비주얼 동기화
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

    // 2. 화면 꺼짐 방지 토글이 켜져있었다면 OS에 의해 풀린 Lock을 재요청
    if (keepAwakeToggle.checked && 'wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch (err) {
        console.error(`Wake Lock 자동 복구 실패: ${err.message}`);
      }
    }
  }
});

// --- p5.js 시각화 렌더링 (UI 스레드) ---
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

  // --- [추가됨] 양 끝 도달 지점 하얀색 기준선 표시 ---
  push();
  stroke(255); // 흰색
  strokeWeight(4); // 선 두께

  // 좌측 한계선 (-45도)
  push();
  rotate(-maxAngle);
  line(0, -215, 0, -225);
  pop();

  // 우측 한계선 (+45도)
  push();
  rotate(maxAngle);
  line(0, -215, 0, -225);
  pop();
  pop();
  // ---------------------------------------------------

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
