"use strict";

// Meeting Audio kept between a Recording's save and ShaiNote accepting it,
// shared by the offscreen document (writes, uploads) and the worker (deletes).
const GMRMeetingAudioStore = (() => {
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("GMRMeetingAudio", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("audio")) {
          request.result.createObjectStore("audio");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transaction(mode, operation) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("audio", mode);
        const request = operation(tx.objectStore("audio"));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error || new Error("Meeting Audio transaction aborted"));
        tx.onerror = () => reject(tx.error || request.error);
      });
    } finally {
      db.close();
    }
  }

  return {
    put: (localId, blob) => transaction("readwrite", (store) => store.put(blob, localId)),
    get: (localId) => transaction("readonly", (store) => store.get(localId)),
    delete: (localId) => transaction("readwrite", (store) => store.delete(localId))
  };
})();
