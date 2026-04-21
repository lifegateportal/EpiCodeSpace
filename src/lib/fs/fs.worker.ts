/**
 * fs.worker.ts — dedicated Web Worker that owns the OPFS driver.
 *
 * Exposed to the main thread via Comlink so each `FsWorkerApi` method on
 * the main side becomes a `postMessage` round-trip under the hood. Keeping
 * all sync-access-handle work here is mandatory on WebKit / iPadOS —
 * `createSyncAccessHandle()` is not allowed on the main thread.
 *
 *   main thread  ──►  Comlink.wrap<FsWorkerApi>(new Worker('fs.worker.ts'))
 *                                │
 *                                ▼
 *                       Comlink.expose(api)
 *                                │
 *                                ▼
 *                           OpfsDriver
 */

import * as Comlink from 'comlink';
import { OpfsDriver } from './drivers/OpfsDriver.ts';
import type { FsWorkerApi } from './types.ts';
import { isFsError } from './types.ts';

// Coerce unknown failures into FsError shapes before they cross the
// structured-clone boundary. Otherwise Comlink reconstructs them as
// `Error` objects on the main side and the `.code` field is lost.
function wrap<T>(fn: (...a: unknown[]) => Promise<T>): (...a: unknown[]) => Promise<T> {
  return async (...args: unknown[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (isFsError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw { code: 'EIO', message: msg };
    }
  };
}

const api: FsWorkerApi = {
  init: wrap(OpfsDriver.init) as FsWorkerApi['init'],
  ping: wrap(OpfsDriver.ping) as FsWorkerApi['ping'],
  usage: wrap(OpfsDriver.usage) as FsWorkerApi['usage'],
  list: wrap(OpfsDriver.list as never) as FsWorkerApi['list'],
  stat: wrap(OpfsDriver.stat as never) as FsWorkerApi['stat'],
  exists: wrap(OpfsDriver.exists as never) as FsWorkerApi['exists'],
  mkdir: wrap(OpfsDriver.mkdir as never) as FsWorkerApi['mkdir'],
  remove: wrap(OpfsDriver.remove as never) as FsWorkerApi['remove'],
  rename: wrap(OpfsDriver.rename as never) as FsWorkerApi['rename'],
  readText: wrap(OpfsDriver.readText as never) as FsWorkerApi['readText'],
  readChunk: wrap(async (path: unknown, offset: unknown, length: unknown) => {
    const buf = await OpfsDriver.readChunk(path as string, offset as number, length as number);
    // Transfer the ArrayBuffer back — zero copy on Safari / Chromium.
    return Comlink.transfer(buf, [buf]);
  }) as FsWorkerApi['readChunk'],
  writeText: wrap(OpfsDriver.writeText as never) as FsWorkerApi['writeText'],
  writeStreamOpen: wrap(OpfsDriver.writeStreamOpen as never) as FsWorkerApi['writeStreamOpen'],
  writeStreamAppend: wrap(OpfsDriver.writeStreamAppend as never) as FsWorkerApi['writeStreamAppend'],
  writeStreamClose: wrap(OpfsDriver.writeStreamClose as never) as FsWorkerApi['writeStreamClose'],
  writeStreamAbort: wrap(OpfsDriver.writeStreamAbort as never) as FsWorkerApi['writeStreamAbort'],
};

Comlink.expose(api);

export {}; // keep this file a module
