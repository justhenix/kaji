import type { RuntimeSnapshot } from '../../../shared/runtime';
import { dispatchRuntime, onRuntimeUpdate, setupSliderFill } from '../ipc';
import { store } from '../store';

export function renderHeadControlPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';
  const settings = store.settings;
  container.innerHTML = `
    <div class="settings-page-header">
      <div class="header-icon-box"><i class="ri-cursor-line" aria-hidden="true"></i></div>
      <div class="header-text-group"><h2 class="header-title">Head Control</h2></div>
    </div>
    <div class="kaji-card head-runtime-card">
      <div class="head-runtime-status"><span class="settings-row-label">Camera control</span><p id="hc-runtime-status" role="status">Checking camera status…</p></div>
      <div class="head-runtime-actions"><button class="btn-primary" id="hc-enable-toggle" type="button" disabled>Start head control</button><button class="btn-secondary" id="hc-reset-btn" type="button" disabled><i class="ri-refresh-line" aria-hidden="true"></i> Reset tracking</button><button class="btn-secondary" id="hc-calibrate-btn" type="button" disabled><i class="ri-crosshair-2-line" aria-hidden="true"></i> Calibrate</button></div>
    </div>
    <div class="kaji-card">
      <div class="settings-row">
        <label for="hc-camera-select">Camera</label>
        <select class="kaji-select" id="hc-camera-select"><option value="">System default</option></select>
      </div>
    </div>
    <div class="kaji-card">
      <div class="settings-group">
        <div class="settings-row"><label for="hc-sens-slider">Sensitivity</label><div class="kaji-slider-wrap"><input type="range" min="10" max="100" value="${settings.sensitivity}" class="kaji-slider" id="hc-sens-slider" /><span id="hc-sens-value">${settings.sensitivity}%</span></div></div>
        <div class="settings-row"><label for="hc-dwell-slider">Dwell time</label><div class="kaji-slider-wrap"><input type="range" min="5" max="30" value="${Math.round(settings.dwell_time * 10)}" class="kaji-slider" id="hc-dwell-slider" /><span id="hc-dwell-value">${settings.dwell_time.toFixed(1)} s</span></div></div>
      </div>
    </div>`;

  const status = container.querySelector<HTMLElement>('#hc-runtime-status')!;
  const toggle = container.querySelector<HTMLButtonElement>('#hc-enable-toggle')!;
  const reset = container.querySelector<HTMLButtonElement>('#hc-reset-btn')!;
  const calibrate = container.querySelector<HTMLButtonElement>('#hc-calibrate-btn')!;
  let current: RuntimeSnapshot | null = null;
  let active = true;
  let revision = -1;
  const update = (snapshot: RuntimeSnapshot) => {
    if (!active || snapshot.revision <= revision) return;
    revision = snapshot.revision;
    current = snapshot;
    const running = snapshot.head.enabled;
    toggle.disabled = false;
    toggle.textContent = running ? 'Stop head control' : 'Start head control';
    toggle.setAttribute('aria-pressed', String(running));
    reset.disabled = !running;
    calibrate.disabled = !running || snapshot.head.phase === 'initializing';
    status.textContent = snapshot.head.reason || (running ? snapshot.head.phase : 'Camera control is off');
    calibrate.innerHTML = `<i class="ri-crosshair-2-line" aria-hidden="true"></i> ${snapshot.head.calibrationSamples ? `Calibrate (${snapshot.head.calibrationSamples})` : 'Calibrate'}`;
  };
  toggle.onclick = async () => {
    toggle.disabled = true;
    status.textContent = current?.head.enabled ? 'Stopping camera…' : 'Starting camera…';
    try { update(await dispatchRuntime({ type: 'head', enabled: !current?.head.enabled })); }
    catch (error) { status.textContent = error instanceof Error ? error.message : 'Could not change camera state.'; toggle.disabled = false; }
  };
  reset.onclick = async () => {
    if (!current?.head.enabled) return;
    reset.disabled = true; toggle.disabled = true; calibrate.disabled = true;
    status.textContent = 'Resetting tracking…';
    try {
      update(await dispatchRuntime({ type: 'head', enabled: false }));
      update(await dispatchRuntime({ type: 'head', enabled: true }));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Could not reset tracking.';
      toggle.disabled = false;
    }
  };
  calibrate.onclick = async () => {
    calibrate.disabled = true;
    status.textContent = 'Calibrating…';
    try { update(await dispatchRuntime({ type: 'calibrate' })); }
    catch (error) { status.textContent = error instanceof Error ? error.message : 'Calibration failed.'; calibrate.disabled = !current?.head.enabled || current.head.phase === 'initializing'; }
  };
  const unlisten = onRuntimeUpdate(update, () => { status.textContent = 'Camera status unavailable.'; toggle.disabled = true; });
  const observer = new MutationObserver(() => {
    if (!container.isConnected) { active = false; unlisten(); observer.disconnect(); }
  });
  observer.observe(document.getElementById('app')!, { childList: true, subtree: true });

  const camera = container.querySelector<HTMLSelectElement>('#hc-camera-select')!;
  void navigator.mediaDevices?.enumerateDevices().then((devices) => {
    if (!container.isConnected) return;
    camera.replaceChildren(new Option('System default', ''));
    devices.filter((device) => device.kind === 'videoinput').forEach((device, index) => {
      const option = new Option(device.label || `Camera ${index + 1}`, device.deviceId, false, device.deviceId === settings.camera);
      camera.add(option);
    });
    if (![...camera.options].some((option) => option.value === settings.camera)) camera.value = '';
  }).catch(() => { status.textContent = 'Could not list cameras.'; });
  camera.onchange = () => store.setDraftField('camera', camera.value);

  const sensitivity = container.querySelector<HTMLInputElement>('#hc-sens-slider')!;
  setupSliderFill(sensitivity);
  sensitivity.oninput = () => {
    const value = Number(sensitivity.value);
    container.querySelector('#hc-sens-value')!.textContent = `${value}%`;
    store.setDraftField('sensitivity', value);
  };
  const dwell = container.querySelector<HTMLInputElement>('#hc-dwell-slider')!;
  setupSliderFill(dwell);
  dwell.oninput = () => {
    const value = Number(dwell.value) / 10;
    container.querySelector('#hc-dwell-value')!.textContent = `${value.toFixed(1)} s`;
    store.setDraftField('dwell_time', value);
  };
  return container;
}
