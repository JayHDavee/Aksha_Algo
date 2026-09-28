import { useEffect } from 'react';

/**
 * Custom hook that:
 * - Scrolls to the top of the page on change.
 * - Disables scrolling if the dependency array is empty.
 * - Optionally accepts a custom CSS class for scroll disabling.
 *
 * @param dependencyArray - Array of any values to track.
 * @param cssClass - Optional CSS class to apply to `document.body`. Defaults to `'removeScroll'`.
 */
const useRemoveScroll = (dependencyArray: any[], cssClass?: string): void => {
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  const classToApply = cssClass || 'removeScroll';

  useEffect(() => {
    if (!isBrowser) return;

    // Scroll to top after component mount/update
    setTimeout(() => window.scrollTo(0, 0), 0);

    // If array is empty, disable scroll by adding a class to body
    if (dependencyArray?.length === 0) {
      document.body.classList.add(classToApply);
    }

    // Clean up on unmount: remove scroll-disable class
    return () => {
      document.body.classList.remove(classToApply);
    };
  }, [dependencyArray, classToApply]);
};

export default useRemoveScroll;
