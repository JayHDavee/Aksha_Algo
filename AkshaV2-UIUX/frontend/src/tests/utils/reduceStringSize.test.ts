import { reduceStringSize } from '../../utils/reduceStringSize';

describe('reduceStringSize', () => {
  it('should return the original string if its length is less than the maxLimit', () => {
    expect(reduceStringSize('Hello', 10)).toBe('Hello');
  });

  it('should return the original string if its length is equal to maxLimit', () => {
    expect(reduceStringSize('HelloWorld', 10)).toBe('HelloWorld');
  });

  it('should truncate the string and append "..." if length exceeds maxLimit', () => {
    // maxLimit = 10 → take 9 chars → "HelloBeau"
    expect(reduceStringSize('HelloBeautifulWorld', 10)).toBe('HelloBeau...');
  });

  it('should return empty string if input is empty', () => {
    expect(reduceStringSize('', 5)).toBe('');
  });

  it('should return the original string if maxLimit is zero or less', () => {
    expect(reduceStringSize('TestString', 0)).toBe('TestString');
    expect(reduceStringSize('TestString', -5)).toBe('TestString');
  });

  it('should handle Unicode characters correctly', () => {
    // "नमस्तेविश्व"
    // maxLimit = 5 → slice(0, 4) → "नमस्"
    expect(reduceStringSize('नमस्तेविश्व', 5)).toBe('नमस्...');
  });

  it('should default to 10 if maxLimit is not passed', () => {
    // default maxLimit = 10 → slice(0, 9) = "This is a"
    expect(reduceStringSize('This is a long sentence')).toBe('This is a...');
  });
});
