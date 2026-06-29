import { afterEach, describe, expect, test } from 'vitest';
import { domById } from '@/shared/domById';

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
    document.body.appendChild(input);
    const found = domById<HTMLInputElement>('field');
    expect(found).toBeInstanceOf(HTMLInputElement);
  });
});
