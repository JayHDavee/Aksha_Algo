/**
 * Reduces a given string to a maximum length and appends ellipsis ("...") if trimmed.
 *
 * @param nameGiven - The original string to shorten.
 * @param maxLimit - Maximum allowed characters before truncating (default: 10).
 * @returns The original string if within the limit, otherwise a truncated version with "..." appended.
 */
export const reduceStringSize = (
  nameGiven: string,
  maxLimit: number = 10
): string => {
  if (!nameGiven || maxLimit <= 0) return nameGiven;

  return nameGiven.length > maxLimit
    ? nameGiven.slice(0, maxLimit - 1) + '...'   // <-- FIX
    : nameGiven;
};

