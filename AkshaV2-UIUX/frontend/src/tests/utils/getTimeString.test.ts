import getTimeString from '../../utils/getTimeString';
import dayjs from 'dayjs';

describe('getTimeString', () => {
  it('should format time to HH:mm by default', () => {
    const date = new Date('2023-07-23T08:30:00');
    expect(getTimeString(date)).toBe('08:30');
  });

  it('should show HH:mm:ss if showSeconds is true', () => {
    const date = new Date('2023-07-23T08:30:00');
    expect(getTimeString(date, true)).toBe('08:30:00');
  });

  it('should show HH:00 if showMinutes is false', () => {
    const date = new Date('2023-07-23T08:30:00');
    expect(getTimeString(date, false, false)).toBe('08:00');
  });

  it('should show HH:00:00 if showMinutes is false and showSeconds is true', () => {
    const date = new Date('2023-07-23T08:30:00');
    expect(getTimeString(date, true, false)).toBe('08:00:00');
  });

  it('should pad single-digit hour and minute with zeroes', () => {
    const date = new Date('2023-07-23T03:05:00');
    expect(getTimeString(date)).toBe('03:05');
    expect(getTimeString(date, true)).toBe('03:05:00');
    expect(getTimeString(date, false, false)).toBe('03:00');
  });

  it('should work with string input', () => {
    expect(getTimeString('2023-07-23T22:45:00')).toBe('22:45');
  });

  it('should work with number timestamp input', () => {
    const timestamp = new Date('2023-07-23T14:15:00').getTime();
    expect(getTimeString(timestamp)).toBe('14:15');
  });

  it('should work with dayjs input', () => {
    const d = dayjs('2023-07-23T06:20:00');
    expect(getTimeString(d)).toBe('06:20');
  });
});
