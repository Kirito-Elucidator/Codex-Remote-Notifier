import * as fs from 'fs';

/**
 * Checks if a file exists at the given path asynchronously.
 * @param filePath The absolute path to the file.
 * @returns A promise that resolves to true if the file exists, false otherwise.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
