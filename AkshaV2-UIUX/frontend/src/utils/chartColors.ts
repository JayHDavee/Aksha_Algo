/**
 * Shared chart color palette, replacing the 3 near-duplicate inline arrays
 * previously hardcoded in DoughnutChart, HorizontalBarChart and the Kreport
 * bar chart. Soft pastel tones matching the brand's blue-led, classy look.
 */
export const CHART_PALETTE: string[] = [
  'rgba(122, 178, 235, 0.9)',  // sky blue
  'rgba(141, 216, 173, 0.9)',  // mint green
  'rgba(247, 209, 115, 0.9)',  // soft amber
  'rgba(240, 158, 189, 0.9)',  // soft pink
  'rgba(179, 165, 234, 0.9)',  // periwinkle
  'rgba(108, 197, 189, 0.9)',  // teal
  'rgba(240, 152, 122, 0.9)',  // coral
  'rgba(129, 140, 217, 0.9)',  // indigo
  'rgba(184, 214, 122, 0.9)',  // lime
  'rgba(224, 122, 150, 0.9)',  // rose
  'rgba(158, 202, 225, 0.9)',  // pale blue
  'rgba(178, 223, 197, 0.9)',  // pale green
  'rgba(250, 224, 158, 0.9)',  // pale amber
  'rgba(232, 184, 208, 0.9)',  // pale pink
  'rgba(201, 192, 240, 0.9)',  // pale lavender
  'rgba(150, 214, 209, 0.9)',  // pale teal
  'rgba(244, 186, 165, 0.9)',  // pale coral
  'rgba(163, 172, 227, 0.9)',  // pale indigo
  'rgba(210, 228, 166, 0.9)',  // pale lime
  'rgba(235, 165, 184, 0.9)',  // pale rose
];

/** Blue-only monotone ramp for single-hue charts (hourly bar/line trends). */
export const CHART_PALETTE_BLUE: string[] = [
  '#035faa',
  '#2f7cbd',
  '#5a9bcf',
  '#8bbcdf',
  '#c6dbef',
];
