import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nativeTargetDir } from './native-output';

const root = resolve(import.meta.dir, '..');
const output = resolve(root, 'src-tauri/binaries/kaji-agent-x86_64-pc-windows-msvc.exe');
await mkdir(resolve(root, 'src-tauri/binaries'), { recursive: true });

const child = Bun.spawn([
  process.execPath,
  'build', resolve(root, 'agent/desktop-host.ts'),
  '--compile', '--target=bun-windows-x64',
  '--env=disable',
  '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
  '--no-compile-autoload-package-json', '--no-compile-autoload-tsconfig',
  '--windows-hide-console', '--outfile', output,
], { cwd: root, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });

const code = await child.exited;
if (code !== 0) throw new Error(`Desktop agent build failed (${code})`);

for (const profile of ['debug', 'release']) {
  const destination = resolve(nativeTargetDir, profile);
  await mkdir(destination, { recursive: true });
  await cp(output, resolve(destination, 'kaji-agent.exe'));
}

console.log('Built managed desktop agent.');
