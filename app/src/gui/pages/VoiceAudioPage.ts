import type { RuntimeSnapshot, ServiceCapability } from '../../../shared/runtime';
import { dispatchRuntime, onRuntimeUpdate, setupSliderFill } from '../ipc';
import { playSendCue } from '../../audio-cue';
import { LANGUAGE_OPTIONS } from '../types';
import { store } from '../store';

const voiceDescriptions: Record<string,string> = {
  Liam: 'Clear and energetic', Lily: 'Soft and expressive', Matilda: 'Steady and professional',
  River: 'Calm and neutral', Roger: 'Relaxed and resonant', Sarah: 'Warm and reassuring', Will: 'Bright and upbeat',
};
function voiceLabel(name: string): string {
  const first = name.split(/\s+[-–—]\s+/)[0]!.trim();
  return voiceDescriptions[first] ? `${first} — ${voiceDescriptions[first]}` : first;
}

function setServiceStatus(node: HTMLElement, name: string, capability?: ServiceCapability, error = false): void {
  node.className = `voice-service-status ${error ? 'error' : capability?.available ? 'available' : 'unavailable'}`;
  node.setAttribute('role', error ? 'alert' : 'status');
  const text = error ? `Could not check ${name}.`
    : !capability ? `Checking ${name}…`
    : capability.available ? `${name} is ready.`
    : capability.reason || `${name} is unavailable.`;
  if (node.textContent !== text) node.textContent = text;
}

function populateDevices(select: HTMLSelectElement, devices: MediaDeviceInfo[], kind: MediaDeviceKind, selected: string): void {
  const matches = devices.filter((device) => device.kind === kind);
  select.replaceChildren(new Option(kind === 'audioinput' ? 'Automatic' : 'System default', ''));
  matches.forEach((device, index) => {
    const label = device.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${index + 1}`;
    select.add(new Option(label, device.deviceId, false, device.deviceId === selected));
  });
  if (!matches.some((device) => device.deviceId === selected)) select.value = '';
  select.dispatchEvent(new Event('value-updated'));
}

export function renderVoiceAudioPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content voice-settings';
  const settings = store.settings;
  container.innerHTML = `
    <div class="settings-page-header">
      <div class="header-icon-box"><i class="ri-mic-line" aria-hidden="true"></i></div>
      <div class="header-text-group"><h2 class="header-title">Voice & Audio</h2></div>
    </div>
    <div class="kaji-card">
      <div class="kaji-card-title">Microphone</div>
      <div class="voice-device-row">
        <label for="va-mic-select">Input device</label>
        <div class="voice-controls">
          <select class="kaji-select" id="va-mic-select" aria-label="Input device"><option value="">Automatic</option></select>
          <div class="mic-meter-row" id="vu-meter" role="img" aria-label="Microphone level">
            ${Array.from({ length: 10 }, () => '<div class="meter-bar"></div>').join('')}
          </div>
          <button class="btn-secondary" id="test-mic-btn" type="button"><i class="ri-play-line" aria-hidden="true"></i> Test microphone</button>
        </div>
      </div>
      <div class="voice-device-row voice-noise-row">
        <label for="va-noise-toggle">Noise suppression</label>
        <label class="toggle-switch"><input type="checkbox" id="va-noise-toggle" ${settings.noise_suppression ? 'checked' : ''} /><span class="toggle-slider"></span></label>
      </div>
      <p class="voice-service-status" id="va-mic-status" role="status" hidden></p>
    </div>
    <div class="kaji-card">
      <div class="kaji-card-title">Wake word & listening</div>
      <div class="settings-row">
        <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-broadcast-line" aria-hidden="true"></i></div><div class="settings-row-text"><div class="settings-row-label">Voice activation</div></div></div>
        <label class="toggle-switch"><input type="checkbox" id="va-voice-act-toggle" ${settings.voice_activation ? 'checked' : ''} /><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row">
        <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-sound-module-line" aria-hidden="true"></i></div><div class="settings-row-text"><div class="settings-row-label">Wake phrase</div></div></div>
        <span class="voice-fixed-value">Hey Kaji</span>
      </div>
      <div class="voice-device-row voice-sensitivity-row">
        <label for="va-sens-slider">Input sensitivity</label>
        <div class="kaji-slider-wrap"><input type="range" min="0" max="100" value="${settings.input_sensitivity}" class="kaji-slider" id="va-sens-slider" /><span id="va-sens-value">${settings.input_sensitivity}%</span></div>
      </div>
      <div class="voice-device-row">
        <label for="va-rec-lang-select">Recognition language</label>
        <select class="kaji-select" id="va-rec-lang-select" aria-label="Recognition language">
          ${LANGUAGE_OPTIONS.map((language) => `<option value="${language}" ${settings.recognition_language === language ? 'selected' : ''}>${language}</option>`).join('')}
        </select>
      </div>
      <p class="voice-service-status" id="va-stt-status" role="status">Checking speech recognition…</p>

    </div>
    <div class="kaji-card">
      <div class="kaji-card-title">Spoken feedback</div>
      <div class="voice-device-row">
        <label for="va-speaker-select">Output device</label>
        <select class="kaji-select" id="va-speaker-select" aria-label="Output device"><option value="">System default</option></select>
      </div>
      <div class="voice-device-row">
        <label for="va-voice-select">ElevenLabs voice</label>
        <select class="kaji-select" id="va-voice-select" aria-label="ElevenLabs voice" disabled><option>Loading voices…</option></select>
      </div>
      <div class="voice-device-row">
        <label for="va-voice-fb-toggle">Read replies aloud</label>
        <label class="toggle-switch"><input type="checkbox" id="va-voice-fb-toggle" ${settings.voice_feedback ? 'checked' : ''} /><span class="toggle-slider"></span></label>
      </div>
      <div class="voice-device-row voice-sensitivity-row">
        <label for="va-vol-slider">Response volume</label>
        <div class="kaji-slider-wrap"><input type="range" min="0" max="100" value="${settings.response_volume}" class="kaji-slider" id="va-vol-slider" /><span id="va-vol-value">${settings.response_volume}%</span></div>
      </div>
      <div class="voice-device-row">
        <label for="va-sfx-toggle">Sound effects</label>
        <div class="voice-controls">
          <button class="btn-secondary" id="va-test-cue" type="button"><i class="ri-play-line" aria-hidden="true"></i> Play send cue</button>
          <label class="toggle-switch"><input type="checkbox" id="va-sfx-toggle" ${settings.sound_effects ? 'checked' : ''} /><span class="toggle-slider"></span></label>
        </div>
      </div>
      <p class="voice-service-status" id="va-tts-status" role="status">Checking spoken feedback…</p>
    </div>`;

  const micSelect = container.querySelector<HTMLSelectElement>('#va-mic-select')!;
  const speakerSelect = container.querySelector<HTMLSelectElement>('#va-speaker-select')!;
  const micStatus = container.querySelector<HTMLElement>('#va-mic-status')!;
  void navigator.mediaDevices?.enumerateDevices().then((devices) => {
    if (!container.isConnected) return;
    populateDevices(micSelect, devices, 'audioinput', settings.microphone);
    populateDevices(speakerSelect, devices, 'audiooutput', settings.speaker);
  }).catch(() => {
    if (container.isConnected) { micStatus.hidden = false; micStatus.textContent = 'Could not list audio devices.'; }
  });

  micSelect.onchange = () => { stopTest(); store.setDraftField('microphone', micSelect.value); };
  speakerSelect.onchange = () => store.setDraftField('speaker', speakerSelect.value);
  container.querySelector<HTMLInputElement>('#va-noise-toggle')!.onchange = (event) => store.setDraftField('noise_suppression', (event.currentTarget as HTMLInputElement).checked);
  container.querySelector<HTMLInputElement>('#va-voice-act-toggle')!.onchange = (event) => store.setDraftField('voice_activation', (event.currentTarget as HTMLInputElement).checked);
  container.querySelector<HTMLInputElement>('#va-voice-fb-toggle')!.onchange = (event) => store.setDraftField('voice_feedback', (event.currentTarget as HTMLInputElement).checked);
  const voiceSelect = container.querySelector<HTMLSelectElement>('#va-voice-select')!;
  voiceSelect.onchange = () => store.setDraftField('speech_voice_id', voiceSelect.value);
  container.querySelector<HTMLInputElement>('#va-sfx-toggle')!.onchange = (event) => store.setDraftField('sound_effects', (event.currentTarget as HTMLInputElement).checked);
  const cueButton = container.querySelector<HTMLButtonElement>('#va-test-cue')!;
  cueButton.onclick = async () => {
    cueButton.disabled = true;
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      await context.resume();
      const cue = playSendCue(context);
      await new Promise<void>(resolve => cue.addEventListener('ended', () => resolve(), { once: true }));
    } catch {
      micStatus.hidden = false;
      micStatus.textContent = 'Could not play the send cue.';
    } finally {
      await context?.close().catch(() => {});
      cueButton.disabled = false;
    }
  };
  container.querySelector<HTMLSelectElement>('#va-rec-lang-select')!.onchange = (event) => store.setDraftField('recognition_language', (event.currentTarget as HTMLSelectElement).value);

  const sensitivity = container.querySelector<HTMLInputElement>('#va-sens-slider')!;
  setupSliderFill(sensitivity);
  sensitivity.oninput = () => {
    const value = Number(sensitivity.value);
    container.querySelector('#va-sens-value')!.textContent = `${value}%`;
    store.setDraftField('input_sensitivity', value);
  };
  const volume = container.querySelector<HTMLInputElement>('#va-vol-slider')!;
  setupSliderFill(volume);
  volume.oninput = () => {
    container.querySelector('#va-vol-value')!.textContent = `${volume.value}%`;
    store.setDraftField('response_volume', Number(volume.value));
  };

  const testMicBtn = container.querySelector<HTMLButtonElement>('#test-mic-btn')!;
  const bars = [...container.querySelectorAll<HTMLElement>('.meter-bar')];
  let stream: MediaStream | null = null;
  let audio: AudioContext | null = null;
  let frame = 0;
  const stopTest = () => {
    cancelAnimationFrame(frame);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    void audio?.close(); audio = null;
    bars.forEach((bar) => bar.classList.remove('active'));
    testMicBtn.innerHTML = '<i class="ri-play-line" aria-hidden="true"></i> Test microphone';
  };
  const observer = new MutationObserver(() => {
    if (!container.isConnected) { stopTest(); observer.disconnect(); window.removeEventListener('pagehide', stopTest); }
  });
  observer.observe(document.getElementById('app')!, { childList: true, subtree: true });
  window.addEventListener('pagehide', stopTest, { once: true });
  testMicBtn.onclick = async () => {
    if (stream) { stopTest(); return; }
    testMicBtn.disabled = true;
    micStatus.hidden = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: micSelect.value ? { exact: micSelect.value } : undefined,
        noiseSuppression: store.settings.noise_suppression,
        autoGainControl: true,
        echoCancellation: false,
        channelCount: 1,
      } });
      if (!container.isConnected) { stopTest(); return; }
      audio = new AudioContext();
      await audio.resume();
      const analyser = audio.createAnalyser(); analyser.fftSize = 256;
      audio.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      testMicBtn.innerHTML = '<i class="ri-stop-line" aria-hidden="true"></i> Stop test';
      const measure = () => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        const count = Math.max(0, Math.min(bars.length, Math.round((20 * Math.log10(Math.max(0.00001, rms)) + 72) / 46 * bars.length)));
        bars.forEach((bar, index) => bar.classList.toggle('active', index < count));
        frame = requestAnimationFrame(measure);
      };
      measure();
    } catch (error) {
      stopTest(); micStatus.hidden = false;
      micStatus.textContent = error instanceof Error && error.name === 'NotAllowedError' ? 'Microphone permission was denied.' : 'Microphone is unavailable.';
    } finally { testMicBtn.disabled = false; }
  };

  const stt = container.querySelector<HTMLElement>('#va-stt-status')!;
  const tts = container.querySelector<HTMLElement>('#va-tts-status')!;
  let active = true;
  let revision = -1;
  let voiceCatalog = '';
  const update = (snapshot: RuntimeSnapshot) => {
    if (!active || snapshot.revision <= revision) return;
    revision = snapshot.revision;
    setServiceStatus(stt, 'Speech recognition', snapshot.services?.stt);
    setServiceStatus(tts, 'Spoken feedback', snapshot.services?.tts);
    if (!snapshot.services) return;
    const voices = snapshot.services.tts.voices;
    const key = JSON.stringify(voices);
    if (key === voiceCatalog) return;
    voiceCatalog = key;
    const selected = store.settings.speech_voice_id;
    const options = voices.map(voice => new Option(voiceLabel(voice.name), voice.id, false, voice.id === selected));
    if (!voices.some(voice => voice.id === selected)) {
      const missing = new Option(voices.length ? 'Saved voice unavailable' : 'No voices available', selected, true, true);
      missing.disabled = true;
      options.unshift(missing);
    }
    voiceSelect.replaceChildren(...options);
    voiceSelect.disabled = !voices.length;
    voiceSelect.dispatchEvent(new Event('value-updated'));
  };
  const showStatusError = () => {
    if (!active) return;
    setServiceStatus(stt, 'speech recognition', undefined, true);
    setServiceStatus(tts, 'spoken feedback', undefined, true);
    if (!voiceCatalog) {
      voiceSelect.replaceChildren(new Option('Voices unavailable'));
      voiceSelect.dispatchEvent(new Event('value-updated'));
    }
  };
  const unlisten = onRuntimeUpdate(update, showStatusError);
  void unlisten.ready.then(async () => {
    if (active) update(await dispatchRuntime({ type: 'services.refresh' }));
  }).catch(showStatusError);
  const runtimeObserver = new MutationObserver(() => {
    if (!container.isConnected) { active = false; unlisten(); runtimeObserver.disconnect(); }
  });
  runtimeObserver.observe(document.getElementById('app')!, { childList: true, subtree: true });
  return container;
}
