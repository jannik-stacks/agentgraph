import { files, loaders } from 'virtual:bothub-code';
import type { FileText } from './model.ts';

export { files };

const texts = new Map<string, Promise<FileText>>();

/** The highlighted text of one source file, loaded once. Meant for `use()`. */
export const fileText = (path: string) => {
  let text = texts.get(path);
  if (!text) {
    const load = loaders[path];
    text = load ? load().then(m => m.default) : Promise.reject(new Error(`no source file ${path}`));
    texts.set(path, text);
  }
  return text;
};
