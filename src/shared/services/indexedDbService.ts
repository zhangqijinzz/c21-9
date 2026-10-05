import type { WorkspaceDocument } from "../domain/types";

const DATABASE = "latency-lab-db";
const STORE = "workspace";
const KEY = "latency-lab.workspace.v1";

/** 浏览器不提供 IndexedDB，本地持久化整体不可用。 */
export class StorageUnsupportedError extends Error {
  constructor() {
    super("浏览器不支持 IndexedDB");
    this.name = "StorageUnsupportedError";
  }
}

/** 数据库被其他页面持有连接，本次打开被阻塞。 */
export class StorageBlockedError extends Error {
  constructor() {
    super("本地数据库被其他页面占用");
    this.name = "StorageBlockedError";
  }
}

export class IndexedDbService {
  async read(): Promise<unknown> {
    if (!("indexedDB" in globalThis)) throw new StorageUnsupportedError();
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("读取本地项目失败"));
    });
  }

  async write(value: WorkspaceDocument): Promise<void> {
    if (!("indexedDB" in globalThis)) throw new StorageUnsupportedError();
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(value, KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("保存本地项目失败"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("保存已中断"));
    });
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        const db = request.result;
        // 其他标签页需要升级版本时主动断开，避免长期占用数据库。
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onblocked = () => reject(new StorageBlockedError());
      request.onerror = () =>
        reject(request.error ?? new Error("打开本地项目失败"));
    });
  }
}
