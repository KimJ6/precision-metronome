// metronome-worklet.js
class MetronomeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sampleRate = 48000; // init 메시지로 실제 기기 샘플레이트를 전달받음
    this.isPlaying = false;

    // 현재 적용 중인 상태
    this.bpm = 60;
    this.beatsPerBar = 4;
    this.denominator = 4;
    this.volume = 1.0;

    // UI에서 변경 시 다음 박자에 적용할 대기(Pending) 상태 (Quantized Change)
    this.nextBpm = 60;
    this.nextBeatsPerBar = 4;
    this.nextDenominator = 4;

    this.currentBeatIndex = 0;
    this.samplesUntilNextTick = 0;

    // 클릭 사운드 합성을 위한 상태
    this.clickSamplesRemaining = 0;
    this.phase = 0;
    this.freq = 1000;

    // 메인 스레드로부터 메시지 수신
    this.port.onmessage = (e) => {
      if (e.data.type === 'init') {
        this.sampleRate = e.data.sampleRate;
      } else if (e.data.type === 'start') {
        this.isPlaying = true;
        this.currentBeatIndex = 0;
        this.samplesUntilNextTick = 0; // 즉시 첫 틱 발생
      } else if (e.data.type === 'stop') {
        this.isPlaying = false;
        this.clickSamplesRemaining = 0;
      } else if (e.data.type === 'update') {
        // UI 변경값을 즉시 반영하지 않고 next 변수에 저장 (Quantized 대기)
        this.nextBpm = e.data.bpm;
        this.nextBeatsPerBar = e.data.beatsPerBar;
        this.nextDenominator = e.data.denominator;
        this.volume = e.data.volume;
      }
    };
  }

  // 오디오 렌더링 스레드에서 초당 수백 번씩 호출되는 메인 처리 루프
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channelCount = output.length;
    const bufferSize = output[0].length; // 보통 128 샘플

    for (let i = 0; i < bufferSize; i++) {
      if (this.isPlaying) {
        if (this.samplesUntilNextTick <= 0) {
          // [핵심] 틱이 발생하는 정확한 순간에 Pending된 설정을 확정(Quantized Change)
          this.bpm = this.nextBpm;
          this.beatsPerBar = this.nextBeatsPerBar;
          this.denominator = this.nextDenominator;

          // 다음 틱까지의 간격을 오디오 샘플 단위로 정확히 계산
          const secondsPerBeat = (60.0 / this.bpm) * (4.0 / this.denominator);
          const samplesPerBeat = secondsPerBeat * this.sampleRate;
          this.samplesUntilNextTick += samplesPerBeat;

          // 클릭 사운드 에셋 세팅 (강박/약박 주파수 분리)
          this.freq = this.currentBeatIndex === 0 ? 1000 : 800;
          this.clickSamplesRemaining = 0.05 * this.sampleRate; // 50ms 길이의 틱
          this.phase = 0;

          // 시각화(UI) 동기화를 위해 메인 스레드로 현재 타임스탬프 전송
          this.port.postMessage({
            type: 'tick',
            beatIndex: this.currentBeatIndex,
            bpm: this.bpm,
            denominator: this.denominator,
            time: currentTime + i / this.sampleRate, // 절대적인 오디오 시스템 시간
          });

          this.currentBeatIndex++;
          if (this.currentBeatIndex >= this.beatsPerBar) {
            this.currentBeatIndex = 0;
          }
        }

        this.samplesUntilNextTick--;
      }

      // 오실레이터 노드 없이, 프로세서 내부에서 직접 사인파(Sine Wave)를 수학적으로 합성
      let sampleValue = 0;
      if (this.clickSamplesRemaining > 0) {
        sampleValue = Math.sin(this.phase) * this.volume;

        // 지수 감쇠(Exponential Decay)를 적용하여 타격감 생성
        const envelope = this.clickSamplesRemaining / (0.05 * this.sampleRate);
        sampleValue *= envelope * envelope;

        this.phase += (2 * Math.PI * this.freq) / this.sampleRate;
        this.clickSamplesRemaining--;
      }

      // 스테레오/모노 출력 채널에 샘플 데이터 기록
      for (let channel = 0; channel < channelCount; channel++) {
        output[channel][i] = sampleValue;
      }
    }
    return true; // 노드 활성 상태 유지
  }
}

registerProcessor('metronome-processor', MetronomeProcessor);
