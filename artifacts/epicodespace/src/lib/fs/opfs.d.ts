/**
 * Ambient type augmentation for OPFS sync access handles.
 *
 * TypeScript's built-in `dom` / `webworker` libs (as of TS 5.4) don't yet
 * expose `FileSystemSyncAccessHandle` or the `createSyncAccessHandle()`
 * method on `FileSystemFileHandle`. These are shipping in Safari 17+ and
 * Chromium 102+. We declare them locally so the driver type-checks
 * without pulling in a full polyfill package.
 *
 * Spec: https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle
 */

interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
