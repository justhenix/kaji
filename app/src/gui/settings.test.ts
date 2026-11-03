import { expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, normalizeSettings } from './ipc';
import { getStatusLabel } from './status';

test('settings strip removed fields before the strict native IPC boundary', () => {
  const migrated = normalizeSettings({ ...DEFAULT_SETTINGS, show_menu_subtitles: true, model: 'old model' } as typeof DEFAULT_SETTINGS);
  expect('show_menu_subtitles' in migrated).toBe(false);
  expect(migrated.model).toBe('Kaji Pro');
  expect(normalizeSettings({ model: 'Kaji Flash (Fast)' }).model).toBe('Kaji Flash');
  expect(normalizeSettings({ confirmation_policy: 'auto_review' }).confirmation_policy).toBe('auto_review');
  expect(normalizeSettings({ confirmation_policy: 'always' as never }).confirmation_policy).toBe('auto_review');
  expect(DEFAULT_SETTINGS.confirmation_policy).toBe('auto_review');
  expect(normalizeSettings({ response_language: 'English' }).response_language).toBe('English (US)');
  expect(normalizeSettings({ response_language: 'Spanish' }).response_language).toBe('Adaptive');
  expect(normalizeSettings({ recognition_language: 'English' }).recognition_language).toBe('English (US)');
  expect(normalizeSettings({ recognition_language: 'Spanish' }).recognition_language).toBe('Adaptive');
  expect(normalizeSettings({ language: 'German' }).language).toBe('Adaptive');
});

test('status labels reflect native phases and pause takes precedence', () => {
  const status = { phase: 'tracking', reason: '', mode: 'assist' as const, head_control_active: false, voice_active: false, is_paused: false, session_id: 0 };
  expect(getStatusLabel(status)).toBe('Ready');
  expect(getStatusLabel({ ...status, phase: 'planning' })).toBe('Thinking');
  expect(getStatusLabel({ ...status, phase: 'executing' })).toBe('Doing');
  expect(getStatusLabel({ ...status, phase: 'offline' })).toBe('Offline');
  expect(getStatusLabel({ ...status, phase: 'executing', is_paused: true })).toBe('Paused');
});
