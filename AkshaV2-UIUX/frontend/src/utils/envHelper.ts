export const getEnvVar = (key: string): string => {
  // Vite provides environment variables via import.meta.env
  const viteEnv = (import.meta as any)?.env?.[key];
  if (viteEnv) return viteEnv;

  // Optional fallback for Node (e.g., tests in Jest)
  if (typeof process !== 'undefined') {
    return process.env[key] || '';
  }

  // Default fallback if neither exists
  return '';
};
