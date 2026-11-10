import { readdirSync } from 'node:fs';
import { Result, Schema } from 'effect';

export const readDirOrEmpty = (dir: string) => readDirEntriesOrEmpty(dir).map(e => e.name);

export const readDirEntriesOrEmpty = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return readOrUndefined(e) ?? [];
  }
};

export const readOrUndefined = (error: unknown): undefined => {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
};

export const parseJson = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  text: string,
  at: string
): S['Type'] => {
  const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(schema))(text);
  if (Result.isFailure(decoded)) throw new Error(`${at}: ${decoded.failure.message}`);
  return decoded.success;
};
