import type { WorkspaceDocument } from "../domain/types";
import { classifyStorageError, StorageAccessError } from "./storageError";

const DATABASE = "latency-lab-db";
const STORE = "workspace";
const KEY = "latency-lab.workspace.v1";

export class IndexedDbService {
  async read(): Promise<unknown> {
    if (!this.isSupported())
      throw new StorageAccessError("unsupported", "浏览器不支持 IndexedDB");
    let db: IDBDatabase;
    try {
      db = await this.open();
    } catch (error) {
      throw classifyStorageError(error);
    }
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, "readonly");
        const request = transaction.objectStore(STORE).get(KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(
            classifyStorageError(
              request.error ?? new Error("读取本地项目失败"),
            ),
          );
        transaction.onabort = () =>
          reject(
            classifyStorageError(
              transaction.error ?? new Error("读取本地项目被中断"),
            ),
          );
      });
    } finally {
      db.close();
    }
  }

  async write(value: WorkspaceDocument): Promise<void> {
    if (!this.isSupported())
      throw new StorageAccessError("unsupported", "浏览器不支持 IndexedDB");
    let db: IDBDatabase;
    try {
      db = await this.open();
    } catch (error) {
      throw classifyStorageError(error);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).put(value, KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            classifyStorageError(
              transaction.error ?? new Error("保存本地项目失败"),
            ),
          );
        transaction.onabort = () =>
          reject(
            classifyStorageError(transaction.error ?? new Error("保存已中断")),
          );
      });
    } finally {
      db.close();
    }
  }

  private isSupported(): boolean {
    return (
      "indexedDB" in globalThis &&
      typeof globalThis.indexedDB?.open === "function"
    );
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DATABASE, 1);
      } catch (error) {
        reject(classifyStorageError(error));
        return;
      }
      let settled = false;
      // 另一个标签页持有旧版本连接且未关闭时，升级会一直被阻塞。
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(
          new StorageAccessError(
            "blocked",
            "本地数据库正被其他标签页占用，请关闭其他标签页后重试",
          ),
        );
      };
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE))
          database.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        resolve(request.result);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error ?? new Error("打开本地项目失败"));
      };
    });
  }
}
