import type { ConversationRecord, ConversationSummary, RuntimeSnapshot } from '../../shared/runtime';
import { dispatchRuntime, getConversation, listConversations, navigateMain, onRuntimeUpdate, type RuntimeUnlisten } from './ipc';
import { createTitleBar } from './components/TitleBar';
import { createDitherAccents } from './components/DitherAccent';
import { showModal } from './components/Modal';
import { methodChoiceAction, taskRequestAction } from './methodChoice';
import { isFreshRuntimeSnapshot } from './runtimeState';
import { store } from './store';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export class HistoryApp {
  private readonly root: HTMLElement;
  private readonly requestedId: string | null;
  private readonly conversationRoute: boolean;
  private readonly newConversationRoute: boolean;
  private listGeneration = 0;
  private recordGeneration = 0;
  private runtime: RuntimeSnapshot | null = null;
  private record: ConversationRecord | null = null;
  private listMounted = false;
  private unlisten: RuntimeUnlisten | undefined;

  constructor(root: HTMLElement, requestedId: string | null, conversationRoute: boolean, newConversationRoute: boolean) {
    this.root = root;
    this.requestedId = requestedId;
    this.conversationRoute = conversationRoute;
    this.newConversationRoute = newConversationRoute;
  }

  async mount(): Promise<void> {
    this.root.replaceChildren();
    const shell = document.createElement('div');
    shell.className = 'window-shell history-shell';
    shell.append(createDitherAccents(), createTitleBar({
      windowLabel: 'main', title: 'Kaji', subtitle: this.conversationRoute ? 'Conversation' : 'History', showVersion: false,
      onBack: () => { void this.back(); },
    }));
    const main = document.createElement('main');
    main.className = 'history-main';
    main.id = 'history-view';
    shell.append(main);
    this.root.append(shell);
    this.unlisten = onRuntimeUpdate((snapshot) => {
      if (!isFreshRuntimeSnapshot(snapshot, this.runtime?.revision ?? -1)) return;
      const key = (state: RuntimeSnapshot | null) => state ? JSON.stringify([state.task, state.question, state.message, state.layout, state.activeConversationId, state.historyRevision]) : '';
      const changed = key(snapshot) !== key(this.runtime);
      this.runtime = snapshot;
      if (!changed) return;
      if (this.record && (snapshot.activeConversationId === this.record.id || snapshot.task?.conversationId === this.record.id)) void this.loadRecord(this.record.id, true);
      else if (!this.conversationRoute && this.listMounted) void this.loadList(this.root.querySelector<HTMLInputElement>('.history-search input')?.value ?? '');
      else this.renderDetail();
    }, () => this.showError('Kaji runtime is unavailable.'));
    window.addEventListener('pagehide', () => this.unlisten?.(), { once: true });
    await this.unlisten.ready;
    if (this.newConversationRoute || (this.conversationRoute && !this.requestedId)) {
      this.record = { id: this.runtime?.activeConversationId ?? '', title: 'New conversation', titleSource: 'local', createdAt: 0, updatedAt: 0, messages: [] };
      this.renderDetail();
    } else if (this.requestedId) await this.loadRecord(this.requestedId);
    else {
      this.listMounted = true;
      await this.loadList();
    }
  }

  private async back(): Promise<void> {
    if (this.conversationRoute) {
      await navigateMain('history.html?view=history');
      return;
    }
    await navigateMain('index.html');
  }

  private async loadList(query = ''): Promise<void> {
    const generation = ++this.listGeneration;
    this.renderList([], 'loading', query);
    try {
      const rows = await listConversations(query.trim() || undefined);
      if (generation === this.listGeneration) this.renderList(rows, 'ready', query);
    } catch {
      if (generation === this.listGeneration) this.renderList([], 'error', query);
    }
  }

  private async createConversation(): Promise<void> {
    try {
      const snapshot = await dispatchRuntime({ type: 'conversation.new' });
      this.runtime = snapshot;
      await navigateMain('history.html?view=conversation&new=1');
    } catch (error) {
      this.showError(error instanceof Error ? error.message : 'Could not start a new conversation.');
    }
  }

  private renderList(rows: ConversationSummary[], state: 'loading' | 'ready' | 'error', query: string): void {
    const main = this.root.querySelector<HTMLElement>('#history-view')!;
    main.innerHTML = `
      <header class="history-heading">
        <div><h1>Recents</h1><p class="history-subtitle">Your saved conversations</p></div>
        <button class="btn-primary history-new" type="button"><i class="ri-add-line" aria-hidden="true"></i> New session</button>
      </header>
      <label class="history-search"><i class="ri-search-line" aria-hidden="true"></i><span class="sr-only">Search conversations</span><input type="search" value="${escapeHtml(query)}" placeholder="Search conversations" autocomplete="off"></label>
      <section class="history-results" aria-live="polite" aria-busy="${state === 'loading'}"></section>
      <p class="history-error" role="alert" hidden></p>`;
    main.querySelector<HTMLButtonElement>('.history-new')!.onclick = () => { void this.createConversation(); };
    const search = main.querySelector<HTMLInputElement>('.history-search input')!;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    search.oninput = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { void this.loadList(search.value); }, 140);
    };
    const results = main.querySelector<HTMLElement>('.history-results')!;
    const error = main.querySelector<HTMLElement>('.history-error')!;
    if (state === 'loading') {
      results.innerHTML = '<div class="history-state"><i class="ri-loader-4-line" aria-hidden="true"></i><span>Loading conversations…</span></div>';
      return;
    }
    if (state === 'error') {
      results.replaceChildren();
      error.hidden = false;
      error.textContent = 'Could not load history. Check connection and retry.';
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'btn-secondary'; retry.textContent = 'Retry';
      retry.onclick = () => { void this.loadList(search.value); };
      error.append(' ', retry);
      return;
    }
    if (rows.length === 0) {
      results.innerHTML = `<div class="history-state"><i class="ri-chat-3-line" aria-hidden="true"></i><span>${query ? 'No matching conversations' : 'No conversations yet'}</span></div>`;
      return;
    }
    const list = document.createElement('ul');
    list.className = 'history-list';
    for (const row of rows) {
      const item = document.createElement('li');
      item.className = 'history-row';
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'history-open';
      const title = document.createElement('span'); title.className = 'history-row-title'; title.textContent = row.title;
      const date = document.createElement('time'); date.className = 'history-row-date'; date.dateTime = new Date(row.updatedAt).toISOString();
      date.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(row.updatedAt);
      open.append(title, date);
      open.onclick = () => { void this.open(row.id); };
      const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'history-row-action'; rename.title = `Rename ${row.title}`; rename.setAttribute('aria-label', `Rename ${row.title}`); rename.innerHTML = '<i class="ri-edit-line" aria-hidden="true"></i>';
      rename.onclick = () => this.rename(item, row);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'history-row-action'; remove.title = `Delete ${row.title}`; remove.setAttribute('aria-label', `Delete ${row.title}`); remove.innerHTML = '<i class="ri-delete-bin-line" aria-hidden="true"></i>';
      remove.onclick = () => { void this.remove(row); };
      item.append(open, rename, remove);
      list.append(item);
    }
    results.replaceChildren(list);
  }

  private rename(item: HTMLElement, row: ConversationSummary): void {
    const open = item.querySelector<HTMLButtonElement>('.history-open')!;
    const oldTitle = row.title;
    const edit = document.createElement('form'); edit.className = 'history-rename';
    edit.innerHTML = '<label class="sr-only">Conversation title</label><input maxlength="80" required><button type="submit" aria-label="Save title"><i class="ri-check-line" aria-hidden="true"></i></button><button type="button" aria-label="Cancel rename"><i class="ri-close-line" aria-hidden="true"></i></button>';
    const input = edit.querySelector('input')!; input.value = oldTitle; input.setAttribute('aria-label', 'Conversation title');
    open.replaceWith(edit); input.focus(); input.select();
    edit.querySelector<HTMLButtonElement>('button[type="button"]')!.onclick = () => { edit.replaceWith(open); };
    edit.onsubmit = async (event) => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title || title === oldTitle) return edit.replaceWith(open);
      edit.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        await dispatchRuntime({ type: 'conversation.rename', conversationId: row.id, title });
        await this.loadList((this.root.querySelector<HTMLInputElement>('.history-search input')?.value ?? ''));
      } catch (error) {
        this.showError(error instanceof Error ? error.message : 'Could not rename conversation.');
        edit.replaceWith(open);
      }
    };
  }

  private async remove(row: ConversationSummary): Promise<void> {
    const approved = await new Promise<boolean>(resolve => {
      const content = document.createElement('div');
      content.className = 'modal-body';
      content.innerHTML = `<p>Delete “${escapeHtml(row.title)}” and its saved messages?</p><div class="modal-actions"><button type="button" class="btn-secondary" data-modal-close>Cancel</button><button type="button" class="btn-primary" data-delete>Delete conversation</button></div>`;
      const close = showModal('Delete conversation', content, () => resolve(false));
      content.querySelector<HTMLButtonElement>('[data-delete]')!.onclick = () => { resolve(true); close(); };
    });
    if (!approved) return;
    try {
      await dispatchRuntime({ type: 'conversation.delete', conversationId: row.id });
      await this.loadList(this.root.querySelector<HTMLInputElement>('.history-search input')?.value ?? '');
    } catch (error) {
      this.showError(error instanceof Error ? error.message : 'Could not delete conversation.');
    }
  }

  private async open(conversationId: string): Promise<void> {
    try {
      this.runtime = await dispatchRuntime({ type: 'conversation.open', conversationId });
      await navigateMain(`history.html?view=conversation&conversationId=${encodeURIComponent(conversationId)}`);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : 'Could not open conversation.');
    }
  }

  private async loadRecord(conversationId: string, refresh = false): Promise<void> {
    const generation = ++this.recordGeneration;
    if (!refresh) this.renderLoadingDetail();
    try {
      const record = await getConversation(conversationId);
      if (generation !== this.recordGeneration) return;
      if (!record) { if (refresh && this.record?.id === conversationId) { this.renderDetail(); return; } this.record = null; this.renderMissingDetail(); return; }
      this.record = record;
      this.renderDetail();
    } catch {
      if (generation === this.recordGeneration) this.renderDetailError();
    }
  }

  private renderLoadingDetail(): void {
    const main = this.root.querySelector<HTMLElement>('#history-view')!;
    main.innerHTML = '<div class="history-state"><i class="ri-loader-4-line" aria-hidden="true"></i><span>Loading conversation…</span></div>';
  }

  private renderMissingDetail(): void {
    const main = this.root.querySelector<HTMLElement>('#history-view')!;
    main.innerHTML = '<div class="history-state"><span>Conversation is unavailable.</span><button class="btn-secondary" type="button">Back to history</button></div>';
    main.querySelector('button')!.onclick = () => { void navigateMain('history.html?view=history'); };
  }

  private renderDetailError(): void {
    const main = this.root.querySelector<HTMLElement>('#history-view')!;
    main.innerHTML = '<div class="history-state" role="alert"><span>Could not load conversation.</span><button class="btn-secondary" type="button">Retry</button></div>';
    main.querySelector('button')!.onclick = () => { if (this.requestedId) void this.loadRecord(this.requestedId); };
  }

  private renderDetail(): void {
    if (!this.record) return;
    const main = this.root.querySelector<HTMLElement>('#history-view')!;
    const activeTask = this.runtime?.task;
    const previousInput = main.querySelector<HTMLTextAreaElement>('#conversation-input');
    const draft = previousInput?.value ?? '';
    const focused = document.activeElement === previousInput;
    const selection = [previousInput?.selectionStart ?? 0, previousInput?.selectionEnd ?? 0];
    const ownsTask = activeTask?.conversationId === this.record.id;
    const taskRunning = !!activeTask && !['complete', 'stopped', 'error', 'blocked'].includes(activeTask.phase);
    const taskStatus = activeTask?.phase === 'paused' ? 'A task is paused.'
      : ownsTask ? this.runtime?.message || activeTask?.message || 'Kaji is working'
      : 'Another task is still running.';
    main.innerHTML = `
      <header class="history-heading history-detail-heading"><div><h1></h1><p class="history-subtitle">Conversation</p></div><button type="button" class="btn-secondary history-back"><i class="ri-arrow-left-line" aria-hidden="true"></i> Recents</button></header>
      <section class="conversation-transcript" aria-label="Conversation messages" aria-live="polite"></section>
      <p class="conversation-status" role="status" hidden></p>
      <div class="conversation-pending-artifacts" ${this.runtime?.task?.conversationId === this.record.id && this.runtime.task.artifacts.length ? '' : 'hidden'}></div>
      <form class="conversation-composer"><label class="sr-only" for="conversation-input">Continue conversation</label><textarea id="conversation-input" rows="2" placeholder="Continue this conversation" ${taskRunning ? 'disabled' : ''}></textarea><button type="button" class="conversation-attach" aria-label="Attach file" title="Attach file" ${taskRunning ? 'disabled' : ''}><i class="ri-attachment-2" aria-hidden="true"></i></button><button type="submit" class="conversation-send btn-primary" ${taskRunning ? 'disabled' : ''}><i class="ri-arrow-up-line" aria-hidden="true"></i><span class="sr-only">Send</span></button></form>
      <button class="history-restore-layout" type="button" hidden><i class="ri-layout-2-line" aria-hidden="true"></i> Restore layout</button>`;
    main.querySelector('h1')!.textContent = this.record.title;
    main.querySelector<HTMLButtonElement>('.history-back')!.onclick = () => { void navigateMain('history.html?view=history'); };
    const transcript = main.querySelector<HTMLElement>('.conversation-transcript')!;
    if (this.record.messages.length === 0) {
      transcript.innerHTML = '<div class="history-state"><span>No saved messages</span></div>';
    } else {
      for (const message of this.record.messages) {
        const row = document.createElement('article'); row.className = `conversation-message ${message.role}`;
        const role = document.createElement('span'); role.className = 'conversation-role'; role.textContent = message.role === 'user' ? 'You' : 'Kaji';
        const text = document.createElement('p'); text.textContent = message.text;
        row.append(role, text);
        for (const artifact of message.artifacts ?? []) {
          const link = document.createElement('button'); link.type = 'button'; link.className = 'conversation-artifact'; link.textContent = artifact.name;
          link.onclick = () => { void this.dispatch({ type: 'artifact.open', artifactId: artifact.id }); };
          row.append(link);
        }
        transcript.append(row);
      }
    }
    const pendingArtifacts = main.querySelector<HTMLElement>('.conversation-pending-artifacts')!;
    for (const artifact of ownsTask ? activeTask?.artifacts ?? [] : []) {
      const chip = document.createElement('span'); chip.className = 'composer-attachment'; chip.textContent = artifact.name; pendingArtifacts.append(chip);
    }
    if (this.runtime?.question && this.runtime.question.taskId === activeTask?.id) this.renderQuestion(main);
    else if (taskRunning) {
      const status = main.querySelector<HTMLElement>('.conversation-status')!;
      status.hidden = false; status.textContent = taskStatus;
    }
    const form = main.querySelector<HTMLFormElement>('.conversation-composer')!;
    const restoredInput = form.querySelector<HTMLTextAreaElement>('textarea')!;
    restoredInput.value = draft;
    if (focused && !restoredInput.disabled) { restoredInput.focus(); restoredInput.setSelectionRange(selection[0], selection[1]); }
    form.querySelector<HTMLButtonElement>('.conversation-attach')!.onclick = () => { void this.dispatch({ type: 'file.select' }); };
    form.onsubmit = (event) => {
      event.preventDefault();
      const input = form.querySelector<HTMLTextAreaElement>('textarea')!;
      const text = input.value.trim();
      const send = form.querySelector<HTMLButtonElement>('.conversation-send')!;
      if (!text || send.disabled) return;
      input.disabled = true; send.disabled = true;
      const conversationId = this.record!.id || this.runtime?.activeConversationId || undefined;
      void this.dispatch(taskRequestAction(text, conversationId)).then((snapshot) => {
        const activeId = snapshot.activeConversationId;
        if (!this.record!.id && activeId) {
          this.record!.id = activeId;
          window.history.replaceState(null, '', `history.html?view=conversation&conversationId=${encodeURIComponent(activeId)}`);
        }
        input.value = ''; input.disabled = false; send.disabled = false; input.focus();
        if (this.record!.id) void this.loadRecord(this.record!.id);
      }).catch((error) => {
        const status = main.querySelector<HTMLElement>('.conversation-status')!;
        status.hidden = false; status.textContent = error instanceof Error ? error.message : 'Could not send request.';
        input.disabled = false; send.disabled = false;
      });
    };
    const restore = main.querySelector<HTMLButtonElement>('.history-restore-layout')!;
    restore.onclick = () => { void this.dispatch({ type: 'layout.restore' }); };
    const layoutActive = this.runtime?.layout.active ?? false;
    restore.hidden = !layoutActive;
  }

  private renderQuestion(main: HTMLElement): void {
    const question = this.runtime!.question!;
    const taskId = question.taskId;
    const container = document.createElement('section'); container.className = 'history-pending-question';
    const title = document.createElement('h2'); title.textContent = question.title; container.append(title);
    let answer = '';
    const options = document.createElement('div'); options.className = 'history-question-options'; options.setAttribute('role', 'group'); options.setAttribute('aria-label', 'Choose a response');
    const choices = question.kind === 'approval'
      ? [{ id: 'approve', label: 'Approve', value: 'approve' }, { id: 'reject', label: 'Reject', value: 'reject' }]
      : question.options;
    for (const option of choices) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'composer-option'; button.textContent = option.label; button.setAttribute('aria-pressed', 'false');
      button.onclick = () => { answer = option.value; for (const candidate of options.querySelectorAll('button')) candidate.setAttribute('aria-pressed', String(candidate === button)); };
      options.append(button);
    }
    container.append(options);
    let splitScreen = question.splitScreen?.enabled ?? false;
    if (question.kind === 'method' && question.splitScreen?.available) {
      const arrangement = document.createElement('label'); arrangement.className = 'history-split-option';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = splitScreen;
      checkbox.onchange = () => { splitScreen = checkbox.checked; };
      const label = document.createElement('span'); label.textContent = 'Split screen: your app left, Kaji’s task right';
      arrangement.append(checkbox, label); container.append(arrangement);
    }
    const controls = document.createElement('footer'); controls.className = 'history-question-controls';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => { void this.dispatch({ type: 'dismiss', taskId, questionId: question.id }); };
    const askDifferently = () => {
      const request = this.runtime?.task?.request ?? '';
      void this.dispatch(methodChoiceAction(question, 'rephrase', false)).then(() => {
        const input = main.querySelector<HTMLTextAreaElement>('.conversation-composer textarea');
        if (input) { input.value = request; input.focus(); }
      });
    };
    if (question.kind === 'method' && !question.options.some((option) => option.value === 'rephrase')) {
      const rephrase = document.createElement('button'); rephrase.type = 'button'; rephrase.className = 'btn-secondary'; rephrase.textContent = 'Ask differently';
      rephrase.onclick = askDifferently;
      controls.append(rephrase);
    }
    const proceed = document.createElement('button'); proceed.type = 'button'; proceed.className = 'btn-primary'; proceed.textContent = question.kind === 'approval' ? 'Confirm' : 'Continue'; proceed.disabled = true;
    options.addEventListener('click', () => { proceed.disabled = !answer; });
    proceed.onclick = () => {
      if (!answer) return;
      if (question.kind === 'approval') void this.dispatch({ type: 'confirm', taskId, questionId: question.id, approved: answer === 'approve' });
      else if (question.kind === 'method' && answer === 'rephrase') askDifferently();
      else if (question.kind === 'method') void this.dispatch(methodChoiceAction(question, answer, splitScreen));
      else void this.dispatch({ type: 'answer', taskId, questionId: question.id, answer });
    };
    controls.append(cancel, proceed); container.append(controls);
    main.querySelector('.conversation-status')?.remove();
    main.querySelector('.history-pending-question')?.remove();
    main.insertBefore(container, main.querySelector('.conversation-composer'));
  }

  private async dispatch(action: Parameters<typeof dispatchRuntime>[0]): Promise<RuntimeSnapshot> {
    const snapshot = await dispatchRuntime(action);
    if (isFreshRuntimeSnapshot(snapshot, this.runtime?.revision ?? -1)) this.runtime = snapshot;
    this.renderDetail();
    return snapshot;
  }

  private showError(message: string): void {
    const existing = this.root.querySelector<HTMLElement>('.history-global-error');
    const error = existing ?? document.createElement('p');
    error.className = 'history-global-error'; error.setAttribute('role', 'alert'); error.textContent = message;
    if (!existing) this.root.querySelector('.history-main')?.prepend(error);
  }
}

async function initHistoryApp(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  await store.init();
  const params = new URLSearchParams(location.search);
  const conversationId = params.get('conversationId');
  const conversationRoute = params.get('view') === 'conversation';
  const newConversationRoute = conversationRoute && params.get('new') === '1';
  const app = new HistoryApp(root, conversationRoute && !newConversationRoute ? conversationId : null, conversationRoute, newConversationRoute);
  await app.mount();
}

if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', () => { void initHistoryApp(); });
