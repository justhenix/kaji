import { expect, test } from 'bun:test';
import { methodChoiceAction, taskRequestAction } from './methodChoice';

test('generic request stays attached to the selected conversation', () => {
  expect(taskRequestAction('Summarize the latest invoice totals', 'conversation-9')).toEqual({
    type: 'request', text: 'Summarize the latest invoice totals', source: 'text', conversationId: 'conversation-9',
  });
});

test('method choice routes any currently offered executor ID with task-scoped split screen', () => {
  const question = {
    id: 'q-7', taskId: 'task-3', kind: 'method' as const, title: 'Choose method',
    options: [{ id: 'spreadsheet', label: 'Update spreadsheet', value: 'spreadsheet_formula' }],
    allowCustom: false, optional: false,
    splitScreen: { available: true, enabled: true, userWindow: 'Mail', taskWindow: 'Invoice sheet' },
  };
  expect(methodChoiceAction(question, question.options[0].value, true)).toEqual({
    type: 'method', taskId: 'task-3', questionId: 'q-7', method: 'spreadsheet_formula', splitScreen: true,
  });
});

test('method choice never requests a layout the task did not offer', () => {
  const question = {
    id: 'q-8', taskId: 'task-4', kind: 'method' as const, title: 'Choose method',
    options: [{ id: 'file', label: 'Search local files', value: 'local_file_search' }],
    allowCustom: false, optional: false,
  };
  expect(methodChoiceAction(question, 'local_file_search', true)).toEqual({
    type: 'method', taskId: 'task-4', questionId: 'q-8', method: 'local_file_search', splitScreen: false,
  });
});

test('ask differently returns the user to the request without approving a layout', () => {
  const question = {
    id: 'q-11', taskId: 'task-8', kind: 'method' as const, title: 'Choose a suitable method',
    options: [{ id: 'search', label: 'Search local files', value: 'local_file_search' }],
    allowCustom: false, optional: false,
    splitScreen: { available: true, enabled: true, userWindow: 'Mail', taskWindow: 'Search results' },
  };
  expect(methodChoiceAction(question, 'rephrase', false)).toEqual({
    type: 'method', taskId: 'task-8', questionId: 'q-11', method: 'rephrase', splitScreen: false,
  });
});
