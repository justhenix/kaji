import type { RuntimeSnapshot, ServiceCapability, ServiceCapabilities } from '../../../shared/runtime';
import { dispatchRuntime, onRuntimeUpdate } from '../ipc';
import { LANGUAGE_OPTIONS } from '../types';
import { store } from '../store';
import { GATEWAY_MODELS, gatewayModelId } from '../../../shared/models';

type ServiceKey = keyof ServiceCapabilities;
const services: { key: ServiceKey; label: string }[] = [
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'vision', label: 'Screen understanding' },
  { key: 'stt', label: 'Speech to text' },
  { key: 'tts', label: 'Spoken feedback' },
  { key: 'titles', label: 'Conversation titles' },
];

function renderServices(container: HTMLElement, snapshot: RuntimeSnapshot | null, failed = false): void {
  const view = container.querySelector<HTMLElement>('#ai-service-state')!;
  if (failed) {
    view.innerHTML = '<p class="service-state" role="alert">Could not check service availability.</p>';
    return;
  }
  if (!snapshot?.services) {
    view.innerHTML = '<p class="service-state" role="status">Connecting to AI services…</p>';
    return;
  }
  const reason = snapshot.services.reasoning.reason;
  if (reason && Object.values(snapshot.services).every(service => !service.available && service.reason === reason)) {
    const message = document.createElement('p');
    message.className = 'service-state';
    message.setAttribute('role', 'status');
    message.textContent = reason.includes('gateway credential')
      ? 'Kaji couldn’t finish automatic setup. Check the connection to try again.'
      : reason.includes('HTTP 401')
        ? 'Kaji couldn’t sign in to its AI services. Check the connection again.'
        : reason;
    view.replaceChildren(message);
    return;
  }
  const list = document.createElement('dl');
  list.className = 'service-list';
  for (const item of services) {
    const capability = snapshot.services[item.key] as ServiceCapability;
    const row = document.createElement('div'); row.className = `service-row ${capability.available ? 'available' : 'unavailable'}`;
    const name = document.createElement('dt'); name.textContent = item.label;
    const detail = document.createElement('dd');
    const state = document.createElement('span'); state.className = 'service-value';
    const activeModel = GATEWAY_MODELS.find(model => model.id === gatewayModelId(store.committedSettings.model))?.label;
    state.textContent = capability.available ? (item.key === 'reasoning' || item.key === 'vision' ? activeModel ?? capability.model : capability.model) : capability.reason || 'Unavailable';
    detail.append(state);
    if (capability.remaining !== undefined) {
      const quota = document.createElement('span'); quota.className = 'service-quota'; quota.textContent = capability.available ? 'Demo allowance' : 'Unavailable';
      detail.append(quota);
    }
    row.append(name, detail); list.append(row);
  }
  view.replaceChildren(list);
}

export function renderAiModelsPage(): HTMLElement {
  void dispatchRuntime({ type: 'services.refresh' }).catch(() => {});
  const container = document.createElement('div');
  container.className = 'settings-content';
  const settings = store.settings;
  container.innerHTML = `
    <div class="settings-page-header">
      <div class="header-icon-box"><i class="ri-stack-line" aria-hidden="true"></i></div>
      <div class="header-text-group"><h2 class="header-title">AI & Models</h2></div>
    </div>
    <div class="kaji-card"><div class="settings-row">
      <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-stack-line" aria-hidden="true"></i></div><label for="ai-model-select">Model</label></div>
      <select class="kaji-select" id="ai-model-select">
        ${GATEWAY_MODELS.map(model => `<option value="${model.id === 'deepseek-v4.1-flash' ? 'Kaji Pro' : model.id}" ${gatewayModelId(settings.model) === model.id ? 'selected' : ''}>${model.label}</option>`).join('')}
      </select>
    </div></div>
    <div class="kaji-card service-card">
      <div class="kaji-card-title">Services</div>
      <div id="ai-service-state" aria-live="polite"><p class="service-state" role="status">Checking service availability…</p></div>
      <button class="btn-secondary" id="ai-service-retry" type="button">Check connection</button>
      <p class="service-state" id="ai-connection-result" role="status" aria-live="polite" hidden></p>
    </div>
    <div class="kaji-card">
      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-icon"><i class="ri-chat-1-line" aria-hidden="true"></i></div>
          <div class="settings-row-text"><div class="settings-row-label">Response language</div></div>
        </div>
        <select class="kaji-select" id="ai-response-language" aria-label="Response language">
          ${LANGUAGE_OPTIONS.map((language) => `<option value="${language}" ${settings.response_language === language ? 'selected' : ''}>${language}</option>`).join('')}
        </select>
      </div>
    </div>`;
  container.querySelector<HTMLSelectElement>('#ai-response-language')!.onchange = (event) => {
    store.setDraftField('response_language', (event.currentTarget as HTMLSelectElement).value);
  };
  container.querySelector<HTMLSelectElement>('#ai-model-select')!.onchange = event => {
    store.setDraftField('model', (event.currentTarget as HTMLSelectElement).value);
  };
  let active = true;
  let checking = false;
  let checkRevision = -1;
  const retry = container.querySelector<HTMLButtonElement>('#ai-service-retry')!;
  const result = container.querySelector<HTMLElement>('#ai-connection-result')!;
  retry.onclick = async () => {
    checking = true;
    checkRevision = revision;
    retry.disabled = true;
    retry.textContent = 'Checking…';
    result.hidden = false;
    result.textContent = 'Checking the connection to Kaji…';
    try {
      await dispatchRuntime({ type: 'services.refresh' });
    } catch {
      if (active) renderServices(container, null, true);
      checking = false;
      result.textContent = 'Connection check failed. Check your internet connection and try again.';
      retry.disabled = false;
      retry.textContent = 'Check connection';
    }
  };
  let revision = -1;
  const update = (snapshot: RuntimeSnapshot) => {
    if (!active || snapshot.revision <= revision) return;
    revision = snapshot.revision;
    if (checking && snapshot.revision > checkRevision && snapshot.message === 'Service status updated') {
      checking = false;
      retry.disabled = false;
      retry.textContent = 'Check connection';
      const available = services.filter(service => snapshot.services?.[service.key].available).length;
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      result.textContent = available === services.length
        ? `Connected to Kaji. All ${available} services are ready. Checked at ${time}.`
        : available > 0
          ? `Connected to Kaji. ${available} of ${services.length} services are available. Checked at ${time}.`
          : `Connection check finished. AI services are unavailable; see the status above. Checked at ${time}.`;
    }
    const advertised = snapshot.services?.reasoning.models;
    if (advertised) for (const option of container.querySelector<HTMLSelectElement>('#ai-model-select')!.options) {
      option.disabled = advertised.find(model => model.id === gatewayModelId(option.value))?.available === false;
    }
    renderServices(container, snapshot);
  };
  const unlisten = onRuntimeUpdate(update, () => { if (active) renderServices(container, null, true); });
  const observer = new MutationObserver(() => {
    if (!container.isConnected) { active = false; unlisten(); observer.disconnect(); }
  });
  observer.observe(document.getElementById('app')!, { childList: true, subtree: true });
  return container;
}
