// AudioWorkletProcessor 기반 메트로놈 엔진
// - SampleClock(샘플 단위 카운터) 기반 tick
// - Bresenham(정수+잔차 누적) 스케줄링으로 비정수 박 길이 장기 평균 정확도 확보
// - Quantize 정책은 'bar'(마디) 단위로 완전 고정됨
// - ACC(Accent) 상태는 음악적 구조에 해당하므로 pending에 포함하여 경계에서 동기화 적용

class MetronomeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.running = false;

    // Active params
    this.bpm = 60;
    this.numerator = 4;
    this.denominator = 4;
    this.volume = 1.0;
    this.accentEnabled = true;

    // Pending params
    this.pending = null;

    // Counters & Timing
    this.beatIndex = 0;
    this.barIndex = 0;
    this.totalSamples = 0;
    this.samplesUntilNextTick = 0;
    this.exactSamplesPerBeat = 0.0;
    this.intSamplesPerBeat = 0;
    this.fracSamplesPerBeat = 0.0;
    this.fracAcc = 0.0;

    // Metrics
    this.referenceSample = 0;
    this.tickCounter = 0;
    this.lastTickSample = -1;
    this.needStartReference = false;

    // --- Click Synth (Dual-tone Synthesis) ---
    // 1. Body (저음역대: 편안한 음정과 톡톡거리는 바디감)
    this.envBody = 0.0;
    this.envDecayBody = 0.0;
    this.phaseBody = 0.0;
    this.baseFreq = 440;
    this.accentFreq = 880;
    this.freq = this.baseFreq;

    // 2. Attack (고음역대: 칼박을 잡아주는 1.5ms의 매우 짧고 날카로운 타격음)
    this.envClick = 0.0;
    this.envDecayClick = 0.0;
    this.phaseClick = 0.0;
    this.clickFreq = 4000;

    this._recomputeTiming();
    this._setClickEnvelopes(0.005, 0.0015);

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'start') {
        this.running = true;
        const startDelaySec =
          typeof msg.startDelaySec === 'number' ? msg.startDelaySec : 0.05;
        this.samplesUntilNextTick = Math.max(
          0,
          Math.floor(startDelaySec * sampleRate)
        );
        this.fracAcc = 0.0;
        this.tickCounter = 0;
        this.lastTickSample = -1;
        this.needStartReference = true;
        if (msg.align !== false) {
          this.beatIndex = 0;
          this.barIndex = 0;
        }
        this.port.postMessage({ type: 'state', running: true });
        return;
      }

      if (msg.type === 'stop') {
        this.running = false;
        this.envBody = 0.0;
        this.envClick = 0.0;
        this.samplesUntilNextTick = 0;
        this.port.postMessage({ type: 'state', running: false });
        return;
      }

      if (msg.type === 'set') {
        const next = {
          bpm: this._clampNumber(msg.bpm, 30, 300, this.bpm),
          numerator: this._clampInt(msg.numerator, 1, 32, this.numerator),
          denominator: this._clampDenominator(
            msg.denominator,
            this.denominator
          ),
          // 볼륨 최대치를 5.0(500%)으로 허용
          volume: this._clampNumber(msg.volume, 0, 5.0, this.volume),
          accentEnabled:
            typeof msg.accentEnabled === 'boolean'
              ? msg.accentEnabled
              : this.accentEnabled,
        };

        this.pending = next;
        this.port.postMessage({
          type: 'pending',
          pending: next,
        });
        return;
      }
    };
  }

  _clampNumber(v, min, max, fallback) {
    return typeof v !== 'number' || !Number.isFinite(v)
      ? fallback
      : Math.min(max, Math.max(min, v));
  }

  _clampInt(v, min, max, fallback) {
    const n = Number(v);
    return !Number.isFinite(n)
      ? fallback
      : Math.min(max, Math.max(min, Math.round(n)));
  }

  _clampDenominator(v, fallback) {
    const allowed = new Set([1, 2, 4, 8, 16, 32]);
    const n = this._clampInt(v, 1, 32, fallback);
    return allowed.has(n) ? n : fallback;
  }

  _recomputeTiming() {
    const secondsPerBeat = (60.0 / this.bpm) * (4.0 / this.denominator);
    this.exactSamplesPerBeat = Math.max(1e-9, secondsPerBeat * sampleRate);
    this.intSamplesPerBeat = Math.max(1, Math.floor(this.exactSamplesPerBeat));
    this.fracSamplesPerBeat = this.exactSamplesPerBeat - this.intSamplesPerBeat;
  }

  _setClickEnvelopes(bodyTauSec, clickTauSec) {
    this.envDecayBody = Math.exp(
      -1.0 / (Math.max(0.001, bodyTauSec) * sampleRate)
    );
    this.envDecayClick = Math.exp(
      -1.0 / (Math.max(0.0001, clickTauSec) * sampleRate)
    );
  }

  _shouldApplyPendingAtThisBoundary() {
    if (!this.pending) return false;
    return this.beatIndex === 0;
  }

  _applyPending(currentSample) {
    if (!this.pending) return false;

    this.bpm = this.pending.bpm;
    this.numerator = this.pending.numerator;
    this.denominator = this.pending.denominator;
    this.volume = this.pending.volume;
    this.accentEnabled = this.pending.accentEnabled;

    this.pending = null;
    this._recomputeTiming();

    // 300% (3.0) 초과 시 엔벨로프 바디를 최대 8ms까지 소폭 늘림
    let dynamicTau = 0.005;
    if (this.volume > 3.0) {
      dynamicTau += (this.volume - 3.0) * 0.0015;
    }
    this._setClickEnvelopes(dynamicTau, 0.0015);

    this.referenceSample = currentSample;
    this.tickCounter = 0;
    this.fracAcc = 0.0;
    return true;
  }

  _triggerTick(exactTime, driftMs, intervalMs, appliedPending) {
    this.freq =
      this.accentEnabled && this.beatIndex === 0
        ? this.accentFreq
        : this.baseFreq;

    this.envBody = 1.0;
    this.envClick = 1.0;

    this.port.postMessage({
      type: 'tick',
      audioTime: exactTime,
      beatIndex: this.beatIndex,
      barIndex: this.barIndex,
      bpm: this.bpm,
      denominator: this.denominator,
      numerator: this.numerator,
      driftMs,
      intervalMs,
      appliedPending,
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

    if (!this.running) {
      for (let i = 0; i < ch0.length; i++) {
        ch0[i] = 0.0;
        if (ch1) ch1[i] = 0.0;
      }
      this.totalSamples += ch0.length;
      return true;
    }

    let samplesToTick = this.samplesUntilNextTick;
    for (let i = 0; i < ch0.length; i++) {
      const currentSample = this.totalSamples + i;
      if (samplesToTick <= 0) {
        if (this.needStartReference) {
          this.referenceSample = currentSample;
          this.tickCounter = 0;
          this.fracAcc = 0.0;
          this.needStartReference = false;
        }

        let appliedPending = false;
        if (this._shouldApplyPendingAtThisBoundary()) {
          appliedPending = this._applyPending(currentSample);
        }

        const exactIdealSample =
          this.referenceSample + this.tickCounter * this.exactSamplesPerBeat;
        const driftMs =
          ((currentSample - exactIdealSample) / sampleRate) * 1000.0;
        const intervalMs =
          this.lastTickSample !== -1
            ? ((currentSample - this.lastTickSample) / sampleRate) * 1000.0
            : (this.exactSamplesPerBeat / sampleRate) * 1000.0;

        this.lastTickSample = currentSample;
        this._triggerTick(
          currentTime + i / sampleRate,
          driftMs,
          intervalMs,
          appliedPending
        );

        let nextInterval = this.intSamplesPerBeat;
        this.fracAcc += this.fracSamplesPerBeat;
        if (this.fracAcc >= 1.0) {
          nextInterval += 1;
          this.fracAcc -= 1.0;
        }
        samplesToTick += nextInterval;
        this.tickCounter++;
      }

      let s = 0.0;

      if (this.envBody > 1e-5) {
        this.phaseBody += 2 * Math.PI * (this.freq / sampleRate);
        if (this.phaseBody > 2 * Math.PI) this.phaseBody -= 2 * Math.PI;
        s += Math.sin(this.phaseBody) * this.envBody;
        this.envBody *= this.envDecayBody;
      }

      if (this.envClick > 1e-5) {
        this.phaseClick += 2 * Math.PI * (this.clickFreq / sampleRate);
        if (this.phaseClick > 2 * Math.PI) this.phaseClick -= 2 * Math.PI;
        s += Math.sin(this.phaseClick) * this.envClick * 0.5;
        this.envClick *= this.envDecayClick;
      }

      // 3.0 (300%) 이하: 정직한 선형 증폭 유지
      // 3.0 초과: 최대 4.0 (400%)까지만 소폭 증가하도록 보정
      let actualVolume = this.volume;
      if (this.volume > 3.0) {
        actualVolume = 3.0 + (this.volume - 3.0) * 0.5;
      }

      s *= actualVolume;

      // [핵심] 고볼륨 클리핑 방지를 위한 소프트 클립 (Soft Clip)
      // 값이 1.0을 넘지 않도록 제한하여 찢어지는 파열음을 방지합니다.
      s = Math.tanh(s);

      ch0[i] = s;
      if (ch1) ch1[i] = s;
      samplesToTick -= 1;
    }
    this.samplesUntilNextTick = samplesToTick;
    this.totalSamples += ch0.length;
    return true;
  }
}

registerProcessor('metronome-processor', MetronomeProcessor);
