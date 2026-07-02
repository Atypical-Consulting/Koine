import { afterEach, describe, expect, test } from 'vitest';
import { domById, domQueryAll } from '@/shared/domById';

describe('domById', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('returns the element when it is present', () => {
    const node = document.createElement('div');
    node.id = 'present';
    document.body.appendChild(node);
    expect(domById('present')).toBe(node);
  });

  test('throws `missing #<id>` when the element is absent', () => {
    expect(() => domById('ghost')).toThrow('missing #ghost');
  });

  test('narrows to the requested element type', () => {
    const input = document.createElement('input');
    input.id = 'field';
    input.value = 'typed';
    document.body.appendChild(input);
    const found = domById<HTMLInputElement>('field');
    // Reading `.value` only compiles if `found` is narrowed to HTMLInputElement (it is absent on the
    // HTMLElement default), so the `tsc --noEmit` gate proves the generic flows through — and the
    // runtime check confirms it's the same node.
    expect(found.value).toBe('typed');
  });
});

describe('domQueryAll', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('returns the matched elements as an array', () => {
    const a = document.createElement('button');
    a.className = 'tool';
    const b = document.createElement('button');
    b.className = 'tool';
    document.body.append(a, b);
    expect(domQueryAll('.tool')).toEqual([a, b]);
  });

  test('throws `missing <selector>` when nothing matches', () => {
    expect(() => domQueryAll('.ghost')).toThrow('missing .ghost');
  });

  test('narrows to the requested element type', () => {
    const input = document.createElement('input');
    input.className = 'field';
    input.value = 'typed';
    document.body.appendChild(input);
    const found = domQueryAll<HTMLInputElement>('.field');
    // Reading `.value` only compiles if the array element is narrowed to HTMLInputElement, so the
    // `tsc --noEmit` gate proves the generic flows through — and the runtime check confirms the node.
    expect(found[0].value).toBe('typed');
  });
});
