/**
 * Extracts a date object from a given image URL string using a timestamp pattern.
 *
 * Expected format in the URL:
 *    '.../2023-06-15 18:47:56_alert.jpg'
 *
 * @param url - The image URL string.
 * @returns A JavaScript Date object if timestamp is found, otherwise current date.
 */
const extractDateFromUrl = (url: string): Date => {
  const regex = /\/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})_/;
  const match = regex.exec(url);

  if (match && match[1]) {
    // Replace space with 'T' for ISO compliance
    return new Date(match[1].replace(' ', 'T'));
  }

  // Fallback to an old date so missing timestamps go last
  return new Date(0);
};

/**
 * Sorts an array of image URLs by timestamp (embedded in the filename) in descending order.
 *
 * @param imageUrls - Array of image URL strings.
 * @returns A new array sorted from newest to oldest.
 */
export const sortImagesByDesc = (imageUrls: string[] = []): string[] => {
  return [...imageUrls].sort((a, b) => {
    const dateA = extractDateFromUrl(a).getTime();
    const dateB = extractDateFromUrl(b).getTime();
    return dateB - dateA; // Newest first
  });
};

export default sortImagesByDesc;
