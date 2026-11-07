import { resolve } from 'node:path';

export const nativeTargetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : resolve(import.meta.dir, '../src-tauri/target');
