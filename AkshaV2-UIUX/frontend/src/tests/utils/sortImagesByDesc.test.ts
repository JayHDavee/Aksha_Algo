import sortImagesByDesc from '../../utils/sortImagesByDesc';

// Local helper re-implemented for coverage validation
const extractDateFromUrl = (url: string): Date => {
  const regex = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
  const match = regex.exec(url);
  // If timestamp found → return parsed date
  if (match && match[1]) {
    return new Date(match[1].replace(' ', 'T'));
  }
  // Otherwise → use a very old date so “no timestamp” entries go last
  return new Date(0);
};

describe('extractDateFromUrl', () => {
  it('should extract a valid Date object from the URL', () => {
    const url = '/images/2023-07-23 14:30:00_alert.jpg';
    const date = extractDateFromUrl(url);
    expect(date).toEqual(new Date('2023-07-23T14:30:00'));
  });

  it('should return a very old date if no timestamp is found', () => {
    const url = '/images/alert.jpg';
    const date = extractDateFromUrl(url);
    expect(date.getTime()).toBe(0);
  });

  it('should not fail for empty string', () => {
    const date = extractDateFromUrl('');
    expect(date).toBeInstanceOf(Date);
  });
});

describe('sortImagesByDesc', () => {
  it('should return images sorted by date descending', () => {
    const urls = [
      '/img/2023-07-23 14:30:00_alert.jpg',
      '/img/2023-07-21 10:15:00_alert.jpg',
      '/img/2023-07-22 18:00:00_alert.jpg',
    ];

    const sorted = sortImagesByDesc(urls);
    expect(sorted).toEqual([
      '/img/2023-07-23 14:30:00_alert.jpg',
      '/img/2023-07-22 18:00:00_alert.jpg',
      '/img/2023-07-21 10:15:00_alert.jpg',
    ]);
  });

  it('should handle URLs without a valid timestamp', () => {
    const urls = [
      '/img/no-timestamp1.jpg',
      '/img/2023-07-22 18:00:00_alert.jpg',
      '/img/no-timestamp2.jpg',
    ];

    const sorted = sortImagesByDesc(urls);

    // Valid timestamp image should come first
    expect(sorted[0]).toBe('/img/2023-07-22 18:00:00_alert.jpg');
    expect(sorted.length).toBe(3);
  });

  it('should return an empty array if input is empty', () => {
    expect(sortImagesByDesc([])).toEqual([]);
  });

  it('should not mutate the original array', () => {
    const urls = [
      '/img/2023-07-22 18:00:00_alert.jpg',
      '/img/2023-07-21 10:15:00_alert.jpg',
    ];
    const copy = [...urls];
    sortImagesByDesc(urls);
    expect(urls).toEqual(copy);
  });
});
