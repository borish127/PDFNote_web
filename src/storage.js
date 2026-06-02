// IndexedDB Storage Engine & Native FS Sync

const DB_NAME = 'pdf_notes_db';
const DB_VERSION = 1;
let db = null;

// Initialize IndexedDB
export function initDb() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      
      // Store workspaces: notes metadata, pages (markdown text), assets (images)
      if (!database.objectStoreNames.contains('workspaces')) {
        database.createObjectStore('workspaces', { keyPath: 'pdfHash' });
      }
      
      // Store drawings and visual annotations per PDF page
      if (!database.objectStoreNames.contains('markup')) {
        database.createObjectStore('markup', { keyPath: 'pdfHash' });
      }

      // Store temporary recovery logs/journal for crash recovery
      if (!database.objectStoreNames.contains('recovery')) {
        database.createObjectStore('recovery', { keyPath: 'pdfHash' });
      }

      // Store settings (e.g., FileSystemDirectoryHandle, activePdfHash)
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings');
      }
    };

    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };

    request.onerror = (e) => {
      console.error('IndexedDB open error:', e.target.error);
      reject(e.target.error);
    };
  });
}

// Helper to wrap transactions in Promises
function getStore(storeName, mode = 'readonly') {
  return new Promise((resolve) => {
    const transaction = db.transaction([storeName], mode);
    const store = transaction.objectStore(storeName);
    resolve(store);
  });
}

// --- WORKSPACE CACHE METHODS ---

export async function saveWorkspaceToCache(pdfHash, originalName, pages, assets = {}, pdfBytes = null) {
  await initDb();

  let clonedPdfBytes = pdfBytes;
  if (pdfBytes instanceof ArrayBuffer || (pdfBytes && ArrayBuffer.isView(pdfBytes))) {
    clonedPdfBytes = new Blob([pdfBytes], { type: 'application/pdf' });
  }

  const workspace = {
    pdfHash,
    meta: {
      version: '1.0.0',
      pdfHash,
      originalName,
      lastModified: new Date().toISOString()
    },
    pages, // Structure: { "0": { markdown: "...", assets: [] }, ... }
    assets, // Structure: { "img_p1_0.png": dataURL/blob, ... }
    pdfBytes: clonedPdfBytes // Raw PDF Blob (safe for structured cloning)
  };

  return new Promise(async (resolve, reject) => {
    const store = await getStore('workspaces', 'readwrite');
    const request = store.put(workspace);
    request.onsuccess = () => resolve(true);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function loadWorkspaceFromCache(pdfHash) {
  await initDb();
  return new Promise(async (resolve, reject) => {
    const store = await getStore('workspaces', 'readonly');
    const request = store.get(pdfHash);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = (e) => reject(e.target.error);
  });
}

// --- VISUAL MARKUP OVERLAYS METHODS ---

export async function saveMarkupToCache(pdfHash, pageMarkup) {
  await initDb();
  const data = {
    pdfHash,
    pages: pageMarkup // Structure: { "0": { drawings: [...] }, "1": ... }
  };

  return new Promise(async (resolve, reject) => {
    const store = await getStore('markup', 'readwrite');
    const request = store.put(data);
    request.onsuccess = () => resolve(true);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function loadMarkupFromCache(pdfHash) {
  await initDb();
  return new Promise(async (resolve, reject) => {
    const store = await getStore('markup', 'readonly');
    const request = store.get(pdfHash);
    request.onsuccess = () => {
      resolve(request.result ? request.result.pages : {});
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

// --- CRASH RECOVERY JOURNAL/LOGS METHODS ---
// Saves active un-finalized state toIndexedDB immediately on keystroke/draw

export async function saveRecoveryJournal(pdfHash, originalName, pages, markup, pdfBytes = null) {
  await initDb();

  let clonedPdfBytes = pdfBytes;
  if (pdfBytes instanceof ArrayBuffer || (pdfBytes && ArrayBuffer.isView(pdfBytes))) {
    clonedPdfBytes = new Blob([pdfBytes], { type: 'application/pdf' });
  }

  const journal = {
    pdfHash,
    originalName,
    pages,
    markup,
    pdfBytes: clonedPdfBytes, // Raw PDF Blob (safe for structured cloning)
    timestamp: new Date().toISOString()
  };

  return new Promise(async (resolve, reject) => {
    const store = await getStore('recovery', 'readwrite');
    const request = store.put(journal);
    request.onsuccess = () => resolve(true);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function loadRecoveryJournal(pdfHash) {
  await initDb();
  return new Promise(async (resolve, reject) => {
    const store = await getStore('recovery', 'readonly');
    const request = store.get(pdfHash);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function checkAllRecoveryJournals() {
  await initDb();
  return new Promise(async (resolve, reject) => {
    const store = await getStore('recovery', 'readonly');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function clearRecoveryJournal(pdfHash) {
  await initDb();
  return new Promise(async (resolve, reject) => {
    const store = await getStore('recovery', 'readwrite');
    const request = store.delete(pdfHash);
    request.onsuccess = () => resolve(true);
    request.onerror = (e) => reject(e.target.error);
  });
}

// --- SETTINGS & DIR HANDLE SYNCS ---

export async function saveDirHandle(handle) {
  await initDb();
  return new Promise(async (resolve, reject) => {
    const store = await getStore('settings', 'readwrite');
    const request = store.put(handle, 'dirHandle');
    request.onsuccess = () => resolve(true);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function loadDirHandle() {
  await initDb();
  return new Promise(async (resolve, reject) => {
    const store = await getStore('settings', 'readonly');
    const request = store.get('dirHandle');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function clearDirHandle() {
  await initDb();
  return new Promise(async (resolve, reject) => {
    const store = await getStore('settings', 'readwrite');
    const request = store.delete('dirHandle');
    request.onsuccess = () => resolve(true);
    request.onerror = (e) => reject(e.target.error);
  });
}

// --- FILE SYSTEM ACCESS DIRECT WRITING ---

// Verify read-write permissions for FileSystemHandle
export async function verifyPermission(fileHandle, readWrite) {
  const options = {};
  if (readWrite) {
    options.mode = 'readwrite';
  }
  // Check if permission was already granted
  if ((await fileHandle.queryPermission(options)) === 'granted') {
    return true;
  }
  // Request permission
  if ((await fileHandle.requestPermission(options)) === 'granted') {
    return true;
  }
  return false;
}

// Write compiled notes directly back to local file system
export async function writeToLocalFolder(dirHandle, pdfName, dataObj, mdText) {
  try {
    const hasPerm = await verifyPermission(dirHandle, true);
    if (!hasPerm) {
      throw new Error('Local folder permission denied');
    }

    // Name files based on PDF
    const baseName = pdfName.substring(0, pdfName.lastIndexOf('.')) || pdfName;
    
    // Save notes.json
    const jsonFileHandle = await dirHandle.getFileHandle(`${baseName}_notes.json`, { create: true });
    const jsonWritable = await jsonFileHandle.createWritable();
    await jsonWritable.write(JSON.stringify(dataObj, null, 2));
    await jsonWritable.close();

    // Save combined compiled markdown file
    const mdFileHandle = await dirHandle.getFileHandle(`${baseName}_notes.md`, { create: true });
    const mdWritable = await mdFileHandle.createWritable();
    await mdWritable.write(mdText);
    await mdWritable.close();

    // Save images in an "assets" subfolder if present
    if (Object.keys(dataObj.assets || {}).length > 0 || Object.keys(dataObj.pages).some(p => dataObj.pages[p].assets?.length > 0)) {
      const assetsDirHandle = await dirHandle.getDirectoryHandle('assets', { create: true });
      for (const [imgName, imgDataURL] of Object.entries(dataObj.assets || {})) {
        try {
          // Convert dataURL/base64 to Blob
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
  } catch (error) {
    console.error('Failed writing to local directory:', error);
    throw error;
  }
}

// Convert dataURL to Blob
export function dataURLtoBlob(dataurl) {
  const arr = dataurl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}
