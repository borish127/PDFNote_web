// IndexedDB Storage Engine & Native FS Sync

const DB_NAME = 'pdf_notes_db';
const DB_VERSION = 1;
let db = null;

// Initialize IndexedDB
export function initDb() {
  return new Promise((resolve, reject) => {
    if (db) {
      resolve(db);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const database = e.target.result;

      if (!database.objectStoreNames.contains('workspaces')) {
        database.createObjectStore('workspaces', { keyPath: 'pdfHash' });
      }
      if (!database.objectStoreNames.contains('markup')) {
        database.createObjectStore('markup', { keyPath: 'pdfHash' });
      }
      if (!database.objectStoreNames.contains('recovery')) {
        database.createObjectStore('recovery', { keyPath: 'pdfHash' });
      }
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings');
      }
    };

    request.onsuccess = (e) => {
      db = e.target.result;
      db.onversionchange = () => {
        db?.close();
        db = null;
      };
      resolve(db);
    };

    request.onerror = (e) => {
      console.error('IndexedDB open error:', e.target.error);
      reject(e.target.error);
    };
  });
}

async function runRead(storeName, operation) {
  const database = await initDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    const request = operation(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function runWrite(storeName, operation) {
  const database = await initDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    operation(store);

    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function toPdfBlob(pdfBytes) {
  if (!pdfBytes) return null;
  if (pdfBytes instanceof Blob) return pdfBytes;
  if (pdfBytes instanceof ArrayBuffer || ArrayBuffer.isView(pdfBytes)) {
    if (pdfBytes.byteLength === 0) return null;
    return new Blob([pdfBytes], { type: 'application/pdf' });
  }
  return null;
}

// --- WORKSPACE CACHE METHODS ---

export async function saveWorkspaceToCache(pdfHash, originalName, pages, assets = {}, pdfBytes = null) {
  const workspace = {
    pdfHash,
    meta: {
      version: '1.0.0',
      pdfHash,
      originalName,
      lastModified: new Date().toISOString()
    },
    pages,
    assets,
    pdfBytes: toPdfBlob(pdfBytes)
  };

  return runWrite('workspaces', (store) => store.put(workspace));
}

export async function loadWorkspaceFromCache(pdfHash) {
  const result = await runRead('workspaces', (store) => store.get(pdfHash));
  return result || null;
}

// --- VISUAL MARKUP OVERLAYS METHODS ---

export async function saveMarkupToCache(pdfHash, pageMarkup) {
  const data = {
    pdfHash,
    pages: pageMarkup
  };

  return runWrite('markup', (store) => store.put(data));
}

export async function loadMarkupFromCache(pdfHash) {
  const result = await runRead('markup', (store) => store.get(pdfHash));
  return result ? result.pages : {};
}

// --- CRASH RECOVERY JOURNAL/LOGS METHODS ---

export async function saveRecoveryJournal(pdfHash, originalName, pages, markup, pdfBytes = null) {
  const journal = {
    pdfHash,
    originalName,
    pages,
    markup,
    pdfBytes: toPdfBlob(pdfBytes),
    timestamp: new Date().toISOString()
  };

  return runWrite('recovery', (store) => store.put(journal));
}

export async function loadRecoveryJournal(pdfHash) {
  const result = await runRead('recovery', (store) => store.get(pdfHash));
  return result || null;
}

export async function checkAllRecoveryJournals() {
  const result = await runRead('recovery', (store) => store.getAll());
  return result || [];
}

export async function clearRecoveryJournal(pdfHash) {
  return runWrite('recovery', (store) => store.delete(pdfHash));
}

// --- SETTINGS & DIR HANDLE SYNCS ---

export async function saveDirHandle(handle) {
  return runWrite('settings', (store) => store.put(handle, 'dirHandle'));
}

export async function loadDirHandle() {
  const result = await runRead('settings', (store) => store.get('dirHandle'));
  return result || null;
}

export async function clearDirHandle() {
  return runWrite('settings', (store) => store.delete('dirHandle'));
}

// --- FILE SYSTEM ACCESS DIRECT WRITING ---

// Verify read-write permissions for FileSystemHandle without throwing outside user activation
export async function verifyPermission(fileHandle, readWrite = true, allowPrompt = true) {
  if (!fileHandle) return false;
  const options = readWrite ? { mode: 'readwrite' } : {};

  if ((await fileHandle.queryPermission(options)) === 'granted') {
    return true;
  }
  if (!allowPrompt) {
    return false;
  }
  if ((await fileHandle.requestPermission(options)) === 'granted') {
    return true;
  }
  return false;
}

// Write compiled notes, markup, and assets directly back to local file system
export async function writeToLocalFolder(dirHandle, pdfName, dataObj, mdText, { allowPrompt = false } = {}) {
  const hasPerm = await verifyPermission(dirHandle, true, allowPrompt);
  if (!hasPerm) {
    const err = new Error('Local folder permission required');
    err.code = 'PERMISSION_REQUIRED';
    throw err;
  }

  const baseName = pdfName.substring(0, pdfName.lastIndexOf('.')) || pdfName;

  const jsonFileHandle = await dirHandle.getFileHandle(`${baseName}_notes.json`, { create: true });
  const jsonWritable = await jsonFileHandle.createWritable();
  await jsonWritable.write(JSON.stringify(dataObj, null, 2));
  await jsonWritable.close();

  const mdFileHandle = await dirHandle.getFileHandle(`${baseName}_notes.md`, { create: true });
  const mdWritable = await mdFileHandle.createWritable();
  await mdWritable.write(mdText);
  await mdWritable.close();

  const assetsEntries = Object.entries(dataObj.assets || {});
  if (assetsEntries.length > 0 || Object.keys(dataObj.pages || {}).some(p => dataObj.pages[p].assets?.length > 0)) {
    const assetsDirHandle = await dirHandle.getDirectoryHandle('assets', { create: true });
    for (const [imgName, imgDataURL] of assetsEntries) {
      try {
        const blob = dataURLtoBlob(imgDataURL);
        const imgFileHandle = await assetsDirHandle.getFileHandle(imgName, { create: true });
        const imgWritable = await imgFileHandle.createWritable();
        await imgWritable.write(blob);
        await imgWritable.close();
      } catch (err) {
        console.error('Error writing image to folder assets:', imgName, err);
      }
    }
  }

  return true;
}

// Read saved workspace JSON from linked local folder if present
export async function readFromLocalFolder(dirHandle, pdfName) {
  const hasPerm = await verifyPermission(dirHandle, false, false);
  if (!hasPerm) return null;

  const baseName = pdfName.substring(0, pdfName.lastIndexOf('.')) || pdfName;
  try {
    const jsonHandle = await dirHandle.getFileHandle(`${baseName}_notes.json`);
    const jsonFile = await jsonHandle.getFile();
    const text = await jsonFile.text();
    return JSON.parse(text);
  } catch (err) {
    if (err?.name !== 'NotFoundError') {
      console.warn('Could not read local folder notes:', err);
    }
    return null;
  }
}

// Convert dataURL to Blob safely
export function dataURLtoBlob(dataurl) {
  if (typeof dataurl !== 'string' || !dataurl.startsWith('data:')) {
    throw new Error('Invalid data URL');
  }
  const commaIdx = dataurl.indexOf(',');
  if (commaIdx === -1) {
    throw new Error('Malformed data URL');
  }

  const header = dataurl.slice(5, commaIdx);
  const payload = dataurl.slice(commaIdx + 1);
  const mimeMatch = header.match(/^([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const isBase64 = header.includes(';base64');

  if (isBase64) {
    const bstr = atob(payload);
    const u8arr = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) {
      u8arr[i] = bstr.charCodeAt(i);
    }
    return new Blob([u8arr], { type: mime });
  }

  return new Blob([decodeURIComponent(payload)], { type: mime });
}
