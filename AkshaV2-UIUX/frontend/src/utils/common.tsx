/**
 * A utility object to detect various types of mobile devices
 * based on the browser's user agent string.
 */
export const isMobile = {
  /**
   * Detects if the device is running Android.
   * @returns true if Android, false otherwise
   */
  Android: (): boolean => /Android/i.test(navigator.userAgent),

  /**
   * Detects if the device is a BlackBerry.
   * @returns true if BlackBerry, false otherwise
   */
  BlackBerry: (): boolean => /BlackBerry/i.test(navigator.userAgent),

  /**
   * Detects if the device is an iOS device (iPhone, iPad, or iPod).
   * @returns true if iOS, false otherwise
   */
  iOS: (): boolean => /iPhone|iPad|iPod/i.test(navigator.userAgent),

  /**
   * Detects if the browser is Opera Mini.
   * @returns true if Opera Mini, false otherwise
   */
  Opera: (): boolean => /Opera Mini/i.test(navigator.userAgent),

  /**
   * Detects if the device is running Windows Mobile (IE Mobile).
   * @returns true if Windows Mobile, false otherwise
   */
  Windows: (): boolean => /IEMobile/i.test(navigator.userAgent),

  /**
   * Checks if the device matches any of the mobile types above.
   * @returns true if any mobile platform is detected, false otherwise
   */
  any(): boolean {
    return (
      isMobile.Android() ||
      isMobile.BlackBerry() ||
      isMobile.iOS() ||
      isMobile.Opera() ||
      isMobile.Windows()
    );
  }
};
