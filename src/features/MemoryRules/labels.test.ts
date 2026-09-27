import { describe, expect, it } from 'vitest';

import { appendException } from './labels';

describe('appendException', () => {
  it('keeps the exceptions already written and adds the new one below', () => {
    expect(appendException('图表内部的间距不算', '打印样式不算')).toBe(
      '图表内部的间距不算\n打印样式不算',
    );
  });

  it('starts the list when there is nothing yet', () => {
    expect(appendException(undefined, '  图表内部的间距不算 ')).toBe('图表内部的间距不算');
  });

  it('replaces the "no boundary given" placeholder instead of keeping it above', () => {
    expect(appendException('边界未由评审者说明', '图表内部的间距不算')).toBe('图表内部的间距不算');
  });

  it('does not add the same exception twice', () => {
    expect(appendException('图表内部的间距不算\n打印样式不算', '打印样式不算')).toBe(
      '图表内部的间距不算\n打印样式不算',
    );
  });
});
