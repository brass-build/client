declare const process: { env: { NODE_ENV?: string } } | undefined;

// Bundlers replace `process.env.NODE_ENV`; with none, nothing is reported.
export const inDevelopment = (): boolean => {
  try {
    return process!.env.NODE_ENV !== 'production';
  } catch {
    return false;
  }
};
