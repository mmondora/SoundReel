import { describe, expect, it } from 'vitest';
import { dispatchKey, keyTargetOf } from './managerKeys';
import type { KeyInput } from './managerKeys';

const list = (key: string, extra: Partial<KeyInput> = {}) => dispatchKey({ key, target: 'list', ...extra });

describe('dispatchKey: function keys', () => {
  it.each([
    ['F1', 'help'],
    ['F2', 'newDynamic'],
    ['F3', 'details'],
    ['F4', 'rename'],
    ['F5', 'copy'],
    ['F6', 'move'],
    ['F7', 'newPlaylist'],
    ['F8', 'remove'],
    ['F9', 'share'],
  ])('%s → %s', (key, type) => {
    expect(dispatchKey({ key, target: 'list' })).toEqual({ type });
  });

  it('works from anywhere on the page: inputs, buttons, body', () => {
    for (const target of ['input', 'button', 'other'] as const) {
      expect(dispatchKey({ key: 'F5', target })).toEqual({ type: 'copy' });
    }
  });

  it('never fires inside a dialog and leaves Ctrl/Alt/Meta/Shift+F-key to the browser', () => {
    expect(dispatchKey({ key: 'F5', target: 'dialog' })).toBeNull();
    expect(dispatchKey({ key: 'F5', target: 'list', ctrlKey: true })).toBeNull();
    expect(dispatchKey({ key: 'F5', target: 'list', altKey: true })).toBeNull();
    expect(dispatchKey({ key: 'F5', target: 'list', metaKey: true })).toBeNull();
    expect(dispatchKey({ key: 'F5', target: 'list', shiftKey: true })).toBeNull();
  });

  it('F10 and F12 are left to the browser', () => {
    expect(dispatchKey({ key: 'F10', target: 'list' })).toBeNull();
    expect(dispatchKey({ key: 'F12', target: 'list' })).toBeNull();
  });
});

describe('dispatchKey: list navigation and marks', () => {
  it('arrows, home/end and pages move the cursor', () => {
    expect(list('ArrowUp')).toEqual({ type: 'cursor', move: 'up' });
    expect(list('ArrowDown')).toEqual({ type: 'cursor', move: 'down' });
    expect(list('Home')).toEqual({ type: 'cursor', move: 'home' });
    expect(list('End')).toEqual({ type: 'cursor', move: 'end' });
    expect(list('PageUp')).toEqual({ type: 'cursor', move: 'pageUp' });
    expect(list('PageDown')).toEqual({ type: 'cursor', move: 'pageDown' });
  });

  it('Space and Insert mark and move down; + - * and Ctrl+A work on marks', () => {
    expect(list(' ')).toEqual({ type: 'toggleMark', advance: true });
    expect(list('Insert')).toEqual({ type: 'toggleMark', advance: true });
    expect(list('+')).toEqual({ type: 'markPattern' });
    expect(list('-')).toEqual({ type: 'unmarkPattern' });
    expect(list('*')).toEqual({ type: 'invertMarks' });
    expect(list('a', { ctrlKey: true })).toEqual({ type: 'markAll' });
    expect(list('A', { ctrlKey: true })).toEqual({ type: 'markAll' });
  });

  it('Ctrl+Z undoes the last operation (only on a list: inside a text box it stays the native text undo)', () => {
    expect(list('z', { ctrlKey: true })).toEqual({ type: 'undo' });
    expect(list('Z', { ctrlKey: true })).toEqual({ type: 'undo' });
    expect(dispatchKey({ key: 'z', ctrlKey: true, target: 'input' })).toBeNull();
    expect(list('z')).toBeNull();
  });

  it('Enter plays, Delete removes (F8 alias), Escape escapes', () => {
    expect(list('Enter')).toEqual({ type: 'play' });
    expect(list('Delete')).toEqual({ type: 'remove' });
    expect(list('Escape')).toEqual({ type: 'escape' });
  });

  it('Ctrl+↑/↓ reorder', () => {
    expect(list('ArrowUp', { ctrlKey: true })).toEqual({ type: 'reorder', dir: -1 });
    expect(list('ArrowDown', { ctrlKey: true })).toEqual({ type: 'reorder', dir: 1 });
  });

  it('Tab switches pane but Shift+Tab stays native (the way out of the lists)', () => {
    expect(list('Tab')).toEqual({ type: 'switchPane' });
    expect(list('Tab', { shiftKey: true })).toBeNull();
    expect(list('Tab', { ctrlKey: true })).toBeNull();
  });

  it('ignores unknown keys and modified arrows', () => {
    expect(list('q')).toBeNull();
    expect(list('ArrowDown', { shiftKey: true })).toBeNull();
    expect(list('ArrowDown', { altKey: true })).toBeNull();
    expect(list('c', { ctrlKey: true })).toBeNull();
  });
});

describe('dispatchKey: focus outside the lists', () => {
  it('typing in a filter box is left alone', () => {
    for (const key of [' ', '+', '-', '*', 'Enter', 'Tab', 'ArrowDown', 'Escape', 'Delete']) {
      expect(dispatchKey({ key, target: 'input' })).toBeNull();
    }
    expect(dispatchKey({ key: 'a', ctrlKey: true, target: 'input' })).toBeNull();
  });

  it('buttons and the page body keep their native keys', () => {
    for (const target of ['button', 'other'] as const) {
      expect(dispatchKey({ key: 'Enter', target })).toBeNull();
      expect(dispatchKey({ key: ' ', target })).toBeNull();
      expect(dispatchKey({ key: 'Tab', target })).toBeNull();
    }
  });
});

describe('keyTargetOf', () => {
  it('classifies the focused element', () => {
    document.body.innerHTML = `
      <div role="dialog"><input id="d-in"></div>
      <div data-mgr-list tabindex="0"><div id="row"></div></div>
      <input id="in"><select id="sel"></select><button id="btn"></button><a id="a" href="#x">x</a><p id="p"></p>`;
    const get = (id: string) => document.getElementById(id);
    expect(keyTargetOf(get('d-in'))).toBe('dialog');
    expect(keyTargetOf(get('row'))).toBe('list');
    expect(keyTargetOf(get('in'))).toBe('input');
    expect(keyTargetOf(get('sel'))).toBe('input');
    expect(keyTargetOf(get('btn'))).toBe('button');
    expect(keyTargetOf(get('a'))).toBe('button');
    expect(keyTargetOf(get('p'))).toBe('other');
    expect(keyTargetOf(null)).toBe('other');
  });
});
