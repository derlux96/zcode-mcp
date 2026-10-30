// True when the module at metaUrl is the process's entry script. Compares real
// paths: Node resolves the main module through symlinks, argv[1] keeps the path
// as typed (/tmp -> /private/tmp, a symlinked clone or plugin root).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl, argv1 = process.argv[1]) {
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
