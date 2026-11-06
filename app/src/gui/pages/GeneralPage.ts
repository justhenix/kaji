import { store } from '../store';
import {dispatchRuntime,onRuntimeUpdate} from '../ipc';
import {showAboutModal} from '../components/Modal';
import type {RuntimeSnapshot} from '../../../shared/runtime';

export function renderGeneralPage(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'settings-content';
  const settings = store.settings;
  container.innerHTML = `
    <div class="settings-page-header">
      <div class="header-icon-box"><i class="ri-settings-3-line" aria-hidden="true"></i></div>
      <div class="header-text-group"><h2 class="header-title">General</h2></div>
    </div>
    <div class="kaji-card"><div class="kaji-card-title">Startup</div><div class="settings-row">
      <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-window-line" aria-hidden="true"></i></div><label for="gen-startup-select">Open on launch</label></div>
      <select class="kaji-select" id="gen-startup-select">
        <option value="composer" ${settings.startup_open === 'composer' ? 'selected' : ''}>Composer</option>
        <option value="mainWindow" ${settings.startup_open === 'mainWindow' ? 'selected' : ''}>Main window</option>
      </select>
    </div></div>
    <div class="kaji-card">
      <div class="kaji-card-title">Input now</div>
      <div class="settings-row">
        <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-cursor-line" aria-hidden="true"></i></div><span>Head control</span></div>
        <div class="general-input-actions"><span data-head-status>Checking…</span><button class="btn-secondary" type="button" data-head-toggle aria-label="Start head control" disabled>Start</button></div>
      </div>
      <div class="settings-row">
        <div class="settings-row-info"><div class="settings-row-icon"><i class="ri-mic-line" aria-hidden="true"></i></div><span>Voice input</span></div>
        <div class="general-input-actions"><span data-voice-status>Checking…</span><button class="btn-secondary" type="button" data-voice-toggle aria-label="Start voice input" disabled>Start</button></div>
      </div>
    </div>
    <p class="settings-row-desc" data-input-error role="alert" hidden></p>
    <div class="kaji-card"><div class="settings-row">
      <div><div class="settings-row-label">Kaji Desktop</div><div class="settings-row-desc">Version 0.1.0 · Windows</div></div>
      <button class="btn-secondary" type="button" data-about>About Kaji</button>
    </div></div>`;
  container.querySelector<HTMLSelectElement>('#gen-startup-select')!.onchange = event => {
    store.setDraftField('startup_open', (event.currentTarget as HTMLSelectElement).value as 'composer' | 'mainWindow');
  };
  container.querySelector<HTMLButtonElement>('[data-about]')!.onclick=showAboutModal;
  const head=container.querySelector<HTMLButtonElement>('[data-head-toggle]')!;
  const voice=container.querySelector<HTMLButtonElement>('[data-voice-toggle]')!;
  const error=container.querySelector<HTMLElement>('[data-input-error]')!;
  let current:RuntimeSnapshot|null=null,active=true;
  const update=(snapshot:RuntimeSnapshot)=>{
    if(!active || current && snapshot.revision<=current.revision)return;
    current=snapshot;
    for(const [button,enabled,label] of [[head,snapshot.head.enabled,'head control'],[voice,snapshot.voice.enabled,'voice input']] as const){
      button.disabled=false;button.textContent=enabled?'Stop':'Start';
      button.setAttribute('aria-label',`${enabled?'Stop':'Start'} ${label}`);button.setAttribute('aria-pressed',String(enabled));
    }
    container.querySelector('[data-head-status]')!.textContent=snapshot.head.enabled?(snapshot.head.phase==='initializing'?'Starting…':'On'):'Off';
    container.querySelector('[data-voice-status]')!.textContent=snapshot.voice.enabled?(snapshot.voice.phase==='wake'?'Waiting for wake phrase':snapshot.voice.phase==='listening'?'Listening…':'On'):'Off';
  };
  const toggle=async(type:'head'|'listen',button:HTMLButtonElement)=>{
    if(!current)return;
    button.disabled=true;error.hidden=true;
    try{update(await dispatchRuntime({type,enabled:!(type==='head'?current.head.enabled:current.voice.enabled)}));}
    catch(reason){error.textContent=reason instanceof Error?reason.message:'Could not change input state.';error.hidden=false;button.disabled=false;}
  };
  head.onclick=()=>{void toggle('head',head);};voice.onclick=()=>{void toggle('listen',voice);};
  const unlisten=onRuntimeUpdate(update,()=>{
    container.querySelector('[data-head-status]')!.textContent='Unavailable';
    container.querySelector('[data-voice-status]')!.textContent='Unavailable';
  });
  const observer=new MutationObserver(()=>{if(!container.isConnected){active=false;unlisten();observer.disconnect();}});
  observer.observe(document.getElementById('app')!,{childList:true,subtree:true});
  return container;
}
