export const readOrUndefined = (error: unknown): undefined => {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
};
