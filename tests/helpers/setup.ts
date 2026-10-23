import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { installChromeMock } from './chromeMock';
import { resetDbConnection } from '../../src/storage/db';

// jsdom does not implement Blob#text (Chrome does).
if (!Blob.prototype.text) {
  Blob.prototype.text = function text(this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

// Fresh chrome mock and empty IndexedDB for every test.
beforeEach(async () => {
  await resetDbConnection();
  globalThis.indexedDB = new IDBFactory();
  installChromeMock();
});

afterEach(async () => {
  await resetDbConnection();
});
