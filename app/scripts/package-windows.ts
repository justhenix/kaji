import { resolve } from 'node:path';
import { nativeTargetDir } from './native-output';

const root = resolve(import.meta.dir, '..');
const config = await Bun.file(resolve(root, 'src-tauri/tauri.package.conf.json')).json();
// Resource paths must follow the same target directory as the runtime builders.
config.bundle.resources = { [`${resolve(nativeTargetDir, 'release/python')}/`]: 'python/' };
const child = Bun.spawn([
  process.execPath, 'run', 'tauri', 'build', '--config', JSON.stringify(config), '--bundles', 'nsis',
], { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
