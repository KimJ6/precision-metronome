// worker.js
let timerID = null;
let interval = 25;

self.onmessage = function (e) {
  if (e.data === 'start') {
    // 이미 실행 중이면 타이머를 지우고 새로 시작
    if (timerID) clearInterval(timerID);
    timerID = setInterval(() => {
      self.postMessage('tick');
    }, interval);
  } else if (e.data === 'stop') {
    clearInterval(timerID);
    timerID = null;
  }
};
