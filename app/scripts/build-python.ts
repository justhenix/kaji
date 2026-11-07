import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { nativeTargetDir } from './native-output';

const root = resolve(import.meta.dir, '..');
const cache = resolve(root, 'assets/python-runtime');
const pythonVersion = '3.14.10';

// Official CPython and PyPI release hashes; wheels are installed without running package scripts.
const archives = [
  {
    name: 'python-3.14.10-embed-amd64.zip',
    url: 'https://www.python.org/ftp/python/3.14.10/python-3.14.10-embed-amd64.zip',
    sha256: '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159',
    packages: false,
  },
  {
    name: 'python-docx-1.2.0.zip',
    url: 'https://files.pythonhosted.org/packages/d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/python_docx-1.2.0-py3-none-any.whl',
    sha256: '3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7',
    packages: true,
  },
  {
    name: 'lxml-6.1.3-cp314-win_amd64.zip',
    url: 'https://files.pythonhosted.org/packages/0f/bc/5811cc73cac05e324e05ba9b0924e1a163a317a167ede8a9c748b11db30a/lxml-6.1.3-cp314-cp314-win_amd64.whl',
    sha256: '66299564c046bc7e0cc5de5106601eae907e9fa5904cd68a323380a8502f7861',
    packages: true,
  },
  {
    name: 'typing-extensions-4.16.0.zip',
    url: 'https://files.pythonhosted.org/packages/49/d3/b8441a820a491ddfc024b0b0cf0393375b75ea13866d9c66727e54c2fc80/typing_extensions-4.16.0-py3-none-any.whl',
    sha256: '481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8',
    packages: true,
  },
];

async function verifiedArchive(archive: typeof archives[number]): Promise<string> {
  const path = join(cache, archive.name);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const response = await fetch(archive.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || Number(response.headers.get('content-length')) > 32 * 1024 * 1024) {
      throw new Error(`Python runtime download failed: ${archive.name} (${response.status})`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  if (bytes.byteLength > 32 * 1024 * 1024 || digest !== archive.sha256) {
    throw new Error(`Python runtime checksum mismatch: ${archive.name}`);
  }
  await Bun.write(path, bytes);
  return path;
}

async function extract(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const process = Bun.spawn([
    'powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:KAJI_ARCHIVE_PATH, $env:KAJI_ARCHIVE_OUTPUT)",
  ], {
    env: { ...Bun.env, KAJI_ARCHIVE_PATH: archive, KAJI_ARCHIVE_OUTPUT: destination },
    stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', windowsHide: true,
  });
  if (await process.exited !== 0) throw new Error(`Python runtime extraction failed: ${basename(archive)}`);
}

async function removeStaging(path: string): Promise<void> {
  const cacheRoot = await realpath(cache);
  const stage = await realpath(path);
  if (relative(cacheRoot, stage).startsWith('..') || !basename(stage).startsWith('stage-')) {
    throw new Error('Python staging directory escaped the build cache');
  }
  await rm(stage, { recursive: true, force: true });
}

export async function buildPython(): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Kaji Python resources require Windows x64');
  await mkdir(cache, { recursive: true });
  const paths = await Promise.all(archives.map(verifiedArchive));
  const staging = await mkdtemp(join(cache, 'stage-'));
  try {
    for (let i = 0; i < archives.length; i++) {
      await extract(paths[i], archives[i].packages ? join(staging, 'Lib/site-packages') : staging);
    }
    await Bun.write(join(staging, 'python314._pth'), 'python314.zip\n.\nLib\\site-packages\n');
    await cp(join(root, 'python/worker.py'), join(staging, 'worker.py'));
    const verify = Bun.spawn([
      join(staging, 'python.exe'), '-I', '-c',
      `import sys, docx, lxml.etree, typing_extensions; assert sys.version.split()[0] == '${pythonVersion}'; assert docx.__version__ == '1.2.0'; assert lxml.etree.LXML_VERSION[:3] == (6, 1, 3); assert sys.flags.isolated`,
    ], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', windowsHide: true });
    if (await verify.exited !== 0) throw new Error('Bundled Python dependency verification failed');
    for (const profile of ['debug', 'release']) {
      const profileRoot = resolve(nativeTargetDir, profile);
      const destination = join(profileRoot, 'python');
      await mkdir(profileRoot, { recursive: true });
      const targetRoot = await realpath(nativeTargetDir);
      const resolvedProfile = await realpath(profileRoot);
      if (relative(targetRoot, resolvedProfile) !== profile || relative(resolvedProfile, destination) !== 'python') {
        throw new Error('Python destination escaped the native build directory');
      }
      await rm(destination, { recursive: true, force: true });
      await cp(staging, destination, { recursive: true });
    }
    console.log(`Bundled isolated Python ${pythonVersion} and verified DOCX dependencies.`);
  } finally {
    await removeStaging(staging);
  }
}

if (import.meta.main) await buildPython();
