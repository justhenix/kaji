import { LANGUAGE_OPTIONS } from '../types';
import { setupSliderFill } from '../ipc';
import { store } from '../store';

export function renderVoiceAudioPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';

  const settings = store.settings;

  container.innerHTML = `
    <!-- Header -->
    <div class="settings-page-header">
      <div class="header-icon-box">
        <i class="ri-mic-line"></i>
      </div>
      <div class="header-text-group">
        <h2 class="header-title">Voice & Audio</h2>

      </div>
    </div>

    <!-- Microphone Card -->
    <div class="kaji-card">
      <div class="kaji-card-title" style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <i class="ri-mic-line" style="color: var(--kaji-blue); font-size: 18px;"></i>
        <span>Microphone</span>
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px;">
        <select class="kaji-select" id="va-mic-select" style="min-width: 220px;">
          <option value="Microphone (Realtek Audio)" selected>Microphone (Realtek Audio)</option>
        </select>

        <!-- VU Meter -->
        <div class="mic-meter-row" id="vu-meter">
          <div class="meter-bar"></div>
          <div class="meter-bar"></div>
          <div class="meter-bar"></div>
          <div class="meter-bar"></div>
          <div class="meter-bar"></div>
          <div class="meter-bar"></div>
          <div class="meter-bar"></div>
          <div class="meter-bar"></div>
          <div class="meter-bar"></div>
          <div class="meter-bar"></div>
        </div>

        <button class="btn-secondary" id="test-mic-btn" style="color: var(--kaji-blue); border-color: rgba(9, 49, 141, 0.3);">
          <i class="ri-play-line"></i> Test microphone
        </button>

        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 13.5px; font-weight: 500; color: var(--text-primary);">Noise suppression</span>
          <label class="toggle-switch">
            <input type="checkbox" id="va-noise-toggle" ${settings.noise_suppression ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
    </div>

    <!-- Listening Card -->
    <div class="kaji-card">
      <div class="kaji-card-title" style="display: flex; align-items: center; gap: 8px; margin-bottom: 14px;">
        <i class="ri-broadcast-line" style="color: var(--kaji-blue); font-size: 18px;"></i>
        <span>Listening</span>
      </div>

      <!-- Row 1: Voice activation | Wake phrase -->
      <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 14px; border-bottom: 1px solid var(--divider); gap: 16px;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 13.5px; font-weight: 500;">Voice activation</span>
          <label class="toggle-switch">
            <input type="checkbox" id="va-voice-act-toggle" ${settings.voice_activation ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div style="width: 1px; height: 24px; background: var(--border-subtle);"></div>

        <div style="display: flex; align-items: center; gap: 12px; flex: 1; max-width: 320px;">
          <span style="font-size: 13.5px; font-weight: 500; white-space: nowrap;">Wake phrase</span>
          <input type="text" id="va-wake-input" value="${settings.wake_phrase}"
            style="flex: 1; padding: 6px 12px; border: 1px solid var(--border-subtle); border-radius: 7px; font-family: var(--font-body); font-size: 13px; outline: none;" />
        </div>
      </div>

      <!-- Row 2: Sensitivity | Push-to-talk -->
      <div style="display: flex; align-items: center; justify-content: space-between; padding-top: 14px; gap: 16px;">
        <div style="display: flex; align-items: center; gap: 14px;">
          <span style="font-size: 13.5px; font-weight: 500; white-space: nowrap;">Input sensitivity</span>
          <div class="kaji-slider-wrap">
            <input type="range" min="0" max="100" value="${settings.input_sensitivity}" class="kaji-slider" id="va-sens-slider" />
          </div>
        </div>

        <div style="width: 1px; height: 24px; background: var(--border-subtle);"></div>

        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 13.5px; font-weight: 500; white-space: nowrap;">Push-to-talk</span>
          <div class="keycap-badge" style="background: var(--surface-card);">
            <span class="keycap-item">Ctrl</span>
            <span class="keycap-plus">+</span>
            <span class="keycap-item">Space</span>
            <button id="clear-ptt-btn" aria-label="Clear push-to-talk shortcut" style="border: none; background: transparent; cursor: pointer; color: var(--text-muted); margin-left: 4px; font-size: 12px;"><i class="ri-close-line"></i></button>
          </div>
        </div>
      </div>
    </div>

    <!-- Spoken Feedback Card -->
    <div class="kaji-card">
      <div class="kaji-card-title" style="display: flex; align-items: center; gap: 8px; margin-bottom: 14px;">
        <i class="ri-volume-up-line" style="color: var(--kaji-blue); font-size: 18px;"></i>
        <span>Spoken feedback</span>
      </div>

      <!-- Row 1: Speakers | Voice feedback | Sound effects -->
      <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 14px; border-bottom: 1px solid var(--divider); gap: 16px;">
        <select class="kaji-select" id="va-speaker-select" style="min-width: 220px;">
          <option value="Speakers (Realtek Audio)" selected>Speakers (Realtek Audio)</option>
        </select>

        <div style="width: 1px; height: 24px; background: var(--border-subtle);"></div>

        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 13.5px; font-weight: 500;">Voice feedback</span>
          <label class="toggle-switch">
            <input type="checkbox" id="va-voice-fb-toggle" ${settings.voice_feedback ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div style="width: 1px; height: 24px; background: var(--border-subtle);"></div>

        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 13.5px; font-weight: 500;">Sound effects</span>
          <label class="toggle-switch">
            <input type="checkbox" id="va-sfx-toggle" ${settings.sound_effects ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <!-- Row 2: Response volume -->
      <div style="display: flex; align-items: center; padding-top: 14px; gap: 16px;">
        <span style="font-size: 13.5px; font-weight: 500; white-space: nowrap;">Response volume</span>
        <div class="kaji-slider-wrap" style="flex: 1; max-width: 320px;">
          <input type="range" min="0" max="100" value="${settings.response_volume}" class="kaji-slider" id="va-vol-slider" />
        </div>
      </div>
    </div>

    <!-- Language & Recognition Card -->
    <div class="kaji-card">
      <div class="kaji-card-title" style="display: flex; align-items: center; gap: 8px; margin-bottom: 14px;">
        <i class="ri-global-line" style="color: var(--kaji-blue); font-size: 18px;"></i>
        <span>Language & recognition</span>
      </div>

      <div class="voice-recognition-controls" style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 13.5px; font-weight: 500;">Recognition language</span>
          <select class="kaji-select" id="va-rec-lang-select">
              ${LANGUAGE_OPTIONS.map((language) => `<option value="${language}" ${settings.recognition_language === language ? 'selected' : ''}>${language}</option>`).join('')}
          </select>
        </div>

        <div style="width: 1px; height: 24px; background: var(--border-subtle);"></div>

        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 13.5px; font-weight: 500;">Offline voice pack</span>
          <span style="padding: 4px 10px; background: #ECFDF5; color: #059669; border-radius: 6px; font-size: 12.5px; font-weight: 600;">
            Installed
          </span>
        </div>

        <div style="width: 1px; height: 24px; background: var(--border-subtle);"></div>

        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 13.5px; font-weight: 500;">Transcription</span>
          <select class="kaji-select" id="va-trans-select">
            <option value="Balanced" ${settings.transcription === 'Balanced' ? 'selected' : ''}>Balanced</option>
            <option value="Accurate" ${settings.transcription === 'Accurate' ? 'selected' : ''}>Accurate</option>
            <option value="Fast" ${settings.transcription === 'Fast' ? 'selected' : ''}>Fast</option>
          </select>
        </div>
      </div>
    </div>
  `;

  // Detect real hardware devices if available
  if (navigator.mediaDevices?.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const micSelect = container.querySelector('#va-mic-select') as HTMLSelectElement;
      const speakerSelect = container.querySelector('#va-speaker-select') as HTMLSelectElement;

      const audioInputs = devices.filter((d) => d.kind === 'audioinput' && d.label);
      const audioOutputs = devices.filter((d) => d.kind === 'audiooutput' && d.label);

      if (micSelect && audioInputs.length > 0) {
        micSelect.innerHTML = audioInputs
          .map((d) => `<option value="${d.label}" ${d.label === settings.microphone ? 'selected' : ''}>${d.label}</option>`)
          .join('');
      }

      if (speakerSelect && audioOutputs.length > 0) {
        speakerSelect.innerHTML = audioOutputs
          .map((d) => `<option value="${d.label}" ${d.label === settings.speaker ? 'selected' : ''}>${d.label}</option>`)
          .join('');
      }
    }).catch(() => {});
  }

  // Hook up event handlers
  const noiseToggle = container.querySelector('#va-noise-toggle') as HTMLInputElement;
  noiseToggle.onchange = () => store.setDraftField('noise_suppression', noiseToggle.checked);

  const voiceActToggle = container.querySelector('#va-voice-act-toggle') as HTMLInputElement;
  voiceActToggle.onchange = () => store.setDraftField('voice_activation', voiceActToggle.checked);

  const wakeInput = container.querySelector('#va-wake-input') as HTMLInputElement;
  wakeInput.onchange = () => store.setDraftField('wake_phrase', wakeInput.value);

  const sensSlider = container.querySelector('#va-sens-slider') as HTMLInputElement;
  setupSliderFill(sensSlider);
  sensSlider.oninput = () => store.setDraftField('input_sensitivity', parseInt(sensSlider.value, 10));

  const voiceFbToggle = container.querySelector('#va-voice-fb-toggle') as HTMLInputElement;
  voiceFbToggle.onchange = () => store.setDraftField('voice_feedback', voiceFbToggle.checked);

  const sfxToggle = container.querySelector('#va-sfx-toggle') as HTMLInputElement;
  sfxToggle.onchange = () => store.setDraftField('sound_effects', sfxToggle.checked);

  const volSlider = container.querySelector('#va-vol-slider') as HTMLInputElement;
  setupSliderFill(volSlider);
  volSlider.oninput = () => store.setDraftField('response_volume', parseInt(volSlider.value, 10));

  const recLangSelect = container.querySelector('#va-rec-lang-select') as HTMLSelectElement;
  recLangSelect.onchange = () => store.setDraftField('recognition_language', recLangSelect.value);

  const transSelect = container.querySelector('#va-trans-select') as HTMLSelectElement;
  transSelect.onchange = () => store.setDraftField('transcription', transSelect.value);

  const testMicBtn = container.querySelector('#test-mic-btn') as HTMLButtonElement;
  const bars = [...container.querySelectorAll<HTMLElement>('.meter-bar')];
  let stream: MediaStream | null = null;
  let audio: AudioContext | null = null;
  let frame = 0;
  const stopTest = () => {
    cancelAnimationFrame(frame);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    void audio?.close();
    audio = null;
    bars.forEach((bar) => bar.classList.remove('active'));
    testMicBtn.innerHTML = `<i class="ri-play-line"></i> Test microphone`;
  };
  const observer = new MutationObserver(() => {
    if (!container.isConnected) {
      stopTest();
      observer.disconnect();
      window.removeEventListener('pagehide', stopTest);
    }
  });
  observer.observe(document.getElementById('app')!, { childList: true, subtree: true });
  window.addEventListener('pagehide', stopTest, { once: true });

  const micSelect = container.querySelector('#va-mic-select') as HTMLSelectElement;
  micSelect.onchange = () => {
    stopTest();
    store.setDraftField('microphone', micSelect.value);
  };
  const speakerSelect = container.querySelector('#va-speaker-select') as HTMLSelectElement;
  speakerSelect.onchange = () => store.setDraftField('speaker', speakerSelect.value);

  testMicBtn.onclick = async () => {
    if (stream) return stopTest();
    testMicBtn.disabled = true;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const selected = devices.find((device) => device.kind === 'audioinput' && device.label === store.settings.microphone);
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: selected ? { exact: selected.deviceId } : undefined,
        noiseSuppression: store.settings.noise_suppression,
      } });
      if (!container.isConnected) return stopTest();
      audio = new AudioContext();
      await audio.resume();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 256;
      audio.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      testMicBtn.innerHTML = `<i class="ri-stop-line"></i> Stop test`;
      const measure = () => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        const count = Math.min(bars.length, Math.round(rms * 40 * bars.length));
        bars.forEach((bar, index) => bar.classList.toggle('active', index < count));
        frame = requestAnimationFrame(measure);
      };
      measure();
    } catch (error) {
      stopTest();
      testMicBtn.textContent = 'Retry microphone';
      testMicBtn.title = error instanceof Error ? error.message : 'Microphone unavailable';
    } finally {
      testMicBtn.disabled = false;
    }
  };

  return container;
}
