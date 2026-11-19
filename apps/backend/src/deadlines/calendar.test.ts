import { describe, expect, it } from 'vitest';
import { calculateDeadline } from './calendar.js';

const due = (startDate: string, quantity = 0, unit = 'calendar_days', jurisdictionTz = 'UTC') =>
  calculateDeadline({ startDate, quantity, unit, jurisdictionTz });

describe('法域日历期限', () => {
  it('从当地日期截点转换到 UTC，界面显示北京时间次日', () => {
    expect(due('2025-01-15', 0, 'calendar_days', 'America/New_York')).toMatchObject({
      dueDate: '2025-01-15',
      dueAt: '2025-01-16T04:59:59.999Z',
      beijingTime: '2025-01-16 12:59:59',
    });
    expect(due('2026-03-08', 0, 'calendar_days', 'America/New_York')).toMatchObject({
      dueDate: '2026-03-08',
      dueAt: '2026-03-09T03:59:59.999Z',
      beijingTime: '2026-03-09 11:59:59',
    });
  });

  it('按天跨过闰日，按月遇短月截到月末，向前回算保持同一规则', () => {
    expect(due('2024-02-28', 1).dueDate).toBe('2024-02-29');
    expect(due('2024-02-28', 2).dueDate).toBe('2024-03-01');
    expect(due('2024-01-31', 1, 'calendar_months').dueDate).toBe('2024-02-29');
    expect(due('2025-01-31', 1, 'calendar_months').dueDate).toBe('2025-02-28');
    expect(due('2024-05-31', -1, 'calendar_months').dueDate).toBe('2024-04-30');
  });

  it('拒绝不存在的日期、不明确时区和超出范围的计算', () => {
    expect(() => due('2025-02-29')).toThrow(
      expect.objectContaining({ code: 'DEADLINE_CALCULATION_INVALID' }),
    );
    expect(() => due('2025-03-01', 0, 'calendar_days', 'EST')).toThrow(
      expect.objectContaining({ code: 'DEADLINE_TIMEZONE_INVALID' }),
    );
    expect(() => due('2011-12-30', 0, 'calendar_days', 'Pacific/Apia')).toThrow(
      expect.objectContaining({ code: 'DEADLINE_LOCAL_TIME_INVALID' }),
    );
    expect(() => due('1900-01-01', -1)).toThrow(
      expect.objectContaining({ code: 'DEADLINE_RANGE_INVALID' }),
    );
  });
});
