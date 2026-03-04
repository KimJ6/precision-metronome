// metronome-worklet.js
// AudioWorkletProcessor 기반 메트로놈 엔진 (정수+잔차 누적 Bresenham 방식 적용)

class MetronomeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.running = false;

    // 활성 설정
    this.bpm = 60;
    this.numerator = 4;
    this.denominator = 4;
    this.volume = 1.0;
    this.quantize = 'bar';
    this.pending = null;

    this.beatIndex = 0;
    this.barIndex = 0;

    // --- [핵심 수정됨] Bresenham 타이밍 제어 변수 ---
    this.totalSamples = 0;          // 엔진 구동 후 경과한 총 샘플 수
    this.samplesUntilNextTick = 0;  // 다음 틱까지 남은 정수 샘플 수
    
    // 타이밍 계산용
    this.exactSamplesPerBeat = 0.0; // 소수점을 포함한 정확한 1박 샘플 수
    this.intSamplesPerBeat = 0;     // 내림 처리된 정수 샘플 수
    this.fracSamplesPerBeat = 0.0;  // 소수점 잔차 (0.0 ~ 0.999...)
    this.fracAcc = 0.0;             // 잔차 누적기 (Accumulator)

    // 계측(Metric) 전용 변수 (정확도 증명용 수학적 기준)
    this.referenceSample = 0; 
    this.tickCounter = 0;
    this.lastTickSample = -1;

    // 클릭 합성용 (최적화된 DSP)
    this.env = 0.0;
    this.envDecay = 0.0;
    this.phase = 0.0;
    this.freq = 800;
    this.accentFreq = 1000;

    this._recomputeTiming();
    this._setClickEnvelopeTimeConstant(0.02);

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'start') {
        this.running = true;

        this.totalSamples = 0;
        const startDelaySec = typeof msg.startDelaySec === 'number' ? msg.startDelaySec : 0.05;
        
        // 시작 지점 초기화
        this.samplesUntilNextTick = Math.floor(startDelaySec * sampleRate);
        this.referenceSample = this.samplesUntilNextTick;
        this.fracAcc = 0.0;
        this.tickCounter = 0;
        this.lastTickSample = -1;

        const align = msg.align === false ? false : true;
        if (align) {
          this.beatIndex = 0;
          this.barIndex = 0;
        }
        this.port.postMessage({ type: 'state', running: true });
      }

      if (msg.type === 'stop') {
        this.running = false;
        this.env = 0.0;
        this.port.postMessage({ type: 'state', running: false });
      }

      if (msg.type === 'set') {
        const next = {
          bpm: this._clampNumber(msg.bpm, 30, 300, this.bpm),
          numerator: this._clampInt(msg.numerator, 1, 32, this.numerator),
          denominator: this._clampDenominator(msg.denominator, this.denominator),
          volume: this._clampNumber(msg.volume, 0, 3.0, this.volume),
          quantize: msg.quantize === 'bar' || msg.quantize === 'beat' ? msg.quantize : this.quantize,
        };
        this.pending = next;

        this.port.postMessage({
          type: 'pending',
          pending: {
            bpm: next.bpm,
            numerator: next.numerator,
            denominator: next.denominator,
            quantize: next.quantize,
          },
        });
      }
    };
  }

  _clampNumber(v, min, max, fallback) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  }
  _clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }
  _clampDenominator(v, fallback) {
    const allowed = new Set([1, 2, 4, 8, 16, 32]);
    const n = this._clampInt(v, 1, 32, fallback);
    return allowed.has(n) ? n : fallback;
  }

  _recomputeTiming() {
    // [핵심] 1박자의 샘플 수를 정수부와 소수점(잔차)부로 분리 계산
    const secondsPerBeat = (60.0 / this.bpm) * (4.0 / this.denominator);
    this.exactSamplesPerBeat = secondsPerBeat * sampleRate;
    
    this.intSamplesPerBeat = Math.floor(this.exactSamplesPerBeat);
    this.fracSamplesPerBeat = this.exactSamplesPerBeat - this.intSamplesPerBeat;
  }

  _setClickEnvelopeTimeConstant(tauSec) {
    const tau = Math.max(0.001, tauSec);
    this.envDecay = Math.exp(-1.0 / (tau * sampleRate));
  }

  _shouldApplyPendingAtThisBoundary() {
    if (!this.pending) return false;
    if (this.pending.quantize === 'beat') return true;
    return this.beatIndex === 0;
  }

  _applyPending() {
    if (!this.pending) return;

    this.bpm = this.pending.bpm;
    this.numerator = this.pending.numerator;
    this.denominator = this.pending.denominator;
    this.volume = this.pending.volume;
    this.quantize = this.pending.quantize;

    this.pending = null;
    this._recomputeTiming();

    // 템포 변경 시 누적 기준점 동기화
    this.referenceSample = this.totalSamples + this.samplesUntilNextTick;
    this.tickCounter = 0;
    this.fracAcc = 0.0;
  }

  _triggerTick(exactTime, driftMs, intervalMs) {
    if (this._shouldApplyPendingAtThisBoundary()) {
      this._applyPending();
    }

    const isAccent = this.beatIndex === 0;
    this.freq = isAccent ? this.accentFreq : 800;
    this.env = 1.0;

    this.port.postMessage({
      type: 'tick',
      audioTime: exactTime,
      beatIndex: this.beatIndex,
      barIndex: this.barIndex,
      bpm: this.bpm,
      denominator: this.denominator,
      numerator: this.numerator,
      driftMs: driftMs,
      intervalMs: intervalMs,
    });

    this.beatIndex++;
    if (this.beatIndex >= this.numerator) {
      this.beatIndex = 0;
      this.barIndex++;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const ch0 = output[0];
    const ch1 = output.length > 1 ? output[1] : null;
    if (!ch0) return true;

    const blockSize = ch0.length;

    if (!this.running) {
      for (let i = 0; i < blockSize; i++) {
        ch0[i] = 0.0;
        if (ch1) ch1[i] = 0.0;
      }
      return true;
    }

    let samplesToTick = this.samplesUntilNextTick;

    for (let i = 0; i < blockSize; i++) {
      let currentSample = this.totalSamples + i;

      // 정수 기반의 완벽한 틱 트리거
      if (samplesToTick <= 0) {
        
        // 오차 계측 (실제 발생한 정수 프레임 vs 수학적으로 완벽한 실수 시간)
        let exactIdealSample = this.referenceSample + (this.tickCounter * this.exactSamplesPerBeat);
        let driftSamples = currentSample - exactIdealSample;
        let driftMs = (driftSamples / sampleRate) * 1000;

        let intervalMs = 0;
        if (this.lastTickSample !== -1) {
          intervalMs = ((currentSample - this.lastTickSample) / sampleRate) * 1000;
        } else {
          intervalMs = (this.exactSamplesPerBeat / sampleRate) * 1000;
        }
        this.lastTickSample = currentSample;

        // 틱 발송
        this._triggerTick(currentTime + i / sampleRate, driftMs, intervalMs);

        // [핵심] Bresenham 잔차 누적 방식 다음 틱 스케줄링
        let nextInterval = this.intSamplesPerBeat;
        this.fracAcc += this.fracSamplesPerBeat;
        
        // 누적된 잔차가 1.0(1샘플)을 넘어가면 인터벌에 1샘플을 추가 보상하고 잔차 차감
        if (this.fracAcc >= 1.0) {
          nextInterval += 1;
          this.fracAcc -= 1.0;
        }

        samplesToTick += nextInterval;
        this.tickCounter++;
      }

      let s = 0.0;
      if (this.env > 1e-5) {
        const phaseInc = 2 * Math.PI * (this.freq / sampleRate);
        this.phase += phaseInc;
        if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;

        s = Math.sin(this.phase) * this.env * this.volume;
        this.env *= this.envDecay;
      }

      ch0[i] = s;
      if (ch1) ch1[i] = s;

      samplesToTick -= 1;
    }

    this.samplesUntilNextTick = samplesToTick;
    this.totalSamples += blockSize;

    return true;
  }
}

registerProcessor('metronome-processor', MetronomeProcessor);