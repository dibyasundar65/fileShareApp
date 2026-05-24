// Application State
let currentPath = '';
let viewMode = 'grid'; // 'grid' or 'list'
let nickname = localStorage.getItem('airbridge_nickname') || '';
let socket = null;
let currentFiles = [];
let isHost = false;
let syncQueue = [];
let syncBusy = false;
let syncedPaths = new Set(JSON.parse(localStorage.getItem('airbridge_synced') || '[]'));
let currentTaggedFile = null;   // { path, name } of file being tagged
let chatFilter = 'all';         // 'all' | 'messages' | 'tagged'
let allMessages = [];           // master list for filter re-rendering

// DOM Elements
const filesContainer = document.getElementById('files-container');
const emptyState = document.getElementById('empty-state');
const breadcrumbs = document.getElementById('breadcrumbs');
const searchInput = document.getElementById('search-input');
const viewToggleBtn = document.getElementById('view-toggle-btn');
const gridViewIcon = document.getElementById('grid-view-icon');
const listViewIcon = document.getElementById('list-view-icon');
const dropZone = document.getElementById('drop-zone');
const newFolderBtn = document.getElementById('new-folder-btn');
const uploadMenuBtn = document.getElementById('upload-menu-btn');
const uploadDropdown = document.getElementById('upload-dropdown');
const uploadFilesInput = document.getElementById('upload-files-input');
const uploadFolderInput = document.getElementById('upload-folder-input');
const progressContainer = document.getElementById('progress-container');
const progressFileInfo = document.getElementById('progress-file-info');
const progressPercentVal = document.getElementById('progress-percent-val');
const progressFill = document.getElementById('progress-fill');

const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const userNicknameDisplay = document.getElementById('user-nickname-display');
const headerUserAvatar = document.getElementById('header-user-avatar');
const nicknameTrigger = document.getElementById('nickname-trigger');

const folderModal = document.getElementById('folder-modal');
const folderModalClose = document.getElementById('folder-modal-close');
const folderModalCancel = document.getElementById('folder-modal-cancel');
const folderModalSubmit = document.getElementById('folder-modal-submit');
const newFolderName = document.getElementById('new-folder-name');

const nicknameModal = document.getElementById('nickname-modal');
const nicknameInput = document.getElementById('nickname-input');
const nicknameModalSubmit = document.getElementById('nickname-modal-submit');

const previewModal = document.getElementById('preview-modal');
const previewFilenameTxt = document.getElementById('preview-filename-txt');
const previewDownloadBtn = document.getElementById('preview-download-btn');
const previewCloseBtn = document.getElementById('preview-close-btn');
const previewContentBox = document.getElementById('preview-content-box');

const toastContainer = document.getElementById('toast-container');
const networkIpDisplay = document.getElementById('network-ip-display');
const sortSelect = document.getElementById('sort-select');
const refreshBtn = document.getElementById('refresh-btn');
const refreshIcon = document.getElementById('refresh-icon');
const tagIndicator = document.getElementById('tag-indicator');
const tagIndicatorName = document.getElementById('tag-indicator-name');
const tagIndicatorClear = document.getElementById('tag-indicator-clear');
const filterTabs = document.querySelectorAll('.filter-tab');

// Init application
document.addEventListener('DOMContentLoaded', () => {
  // Update UI with current IP address dynamically
  networkIpDisplay.textContent = `http://${window.location.host}`;
  setupEventListeners();
  
  if (!nickname) {
    showNicknameModal();
  } else {
    updateNicknameUI();
    initApp();
  }
});

function initApp() {
  fetchFiles(currentPath);
  fetchComments();
  initWebSocket();
  checkAndInitAutoSync();
  startPollingSync(); // 5-second fallback poller
}

// -------------------------------------------------------------
// WEB SOCKETS
// -------------------------------------------------------------
function initWebSocket() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}`;
  
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('Connected to real-time chat server');
  };
  
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'file_added') {
        // Refresh file list
        fetchFiles(currentPath);
        // Auto-download on guest clients
        if (!isHost) {
          enqueueSyncDownload(data.path, data.name);
        }
        return;
      }

      if (data.type === 'file_deleted') {
        // Remove from synced set so it re-downloads if re-uploaded
        syncedPaths.delete(data.path);
        saveSyncedPaths();
        fetchFiles(currentPath);
        return;
      }

      appendMessage(data);

      // If someone uploaded/deleted files, refresh our current directory
      if (data.type === 'notification') {
        fetchFiles(currentPath);
      }
    } catch (err) {
      console.error('Error parsing WS message:', err);
    }
  };
  
  socket.onclose = () => {
    console.log('WebSocket disconnected. Reconnecting in 1 second...');
    setTimeout(() => {
      initWebSocket();
      // Re-check sync in case files were added while disconnected
      if (!isHost) setTimeout(checkAndInitAutoSync, 1500);
    }, 1000);
  };
  
  socket.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

// -------------------------------------------------------------
// EVENT LISTENERS
// -------------------------------------------------------------
function setupEventListeners() {
  // Toolbar upload toggle
  uploadMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    uploadDropdown.classList.toggle('show');
  });
  
  document.addEventListener('click', () => {
    uploadDropdown.classList.remove('show');
  });

  // Upload inputs
  uploadFilesInput.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files.length > 0) {
      // Standard file upload
      handleStandardUpload(files);
    }
  });

  uploadFolderInput.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files.length > 0) {
      // Folder upload - we need webkitRelativePath
      handleFolderUpload(files);
    }
  });

  // View toggle
  viewToggleBtn.addEventListener('click', () => {
    if (viewMode === 'grid') {
      viewMode = 'list';
      filesContainer.classList.add('list-view');
      gridViewIcon.classList.add('hidden');
      listViewIcon.classList.remove('hidden');
    } else {
      viewMode = 'grid';
      filesContainer.classList.remove('list-view');
      gridViewIcon.classList.remove('hidden');
      listViewIcon.classList.add('hidden');
    }
    renderFiles(currentFiles);
  });

  // Create folder trigger
  newFolderBtn.addEventListener('click', () => {
    newFolderName.value = '';
    folderModal.classList.remove('hidden');
    newFolderName.focus();
  });

  folderModalClose.addEventListener('click', () => folderModal.classList.add('hidden'));
  folderModalCancel.addEventListener('click', () => folderModal.classList.add('hidden'));
  folderModalSubmit.addEventListener('click', triggerCreateFolder);
  newFolderName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') triggerCreateFolder();
  });

  // Nickname change trigger
  nicknameTrigger.addEventListener('click', () => {
    nicknameInput.value = nickname;
    nicknameModal.classList.remove('hidden');
    nicknameInput.focus();
  });

  nicknameModalSubmit.addEventListener('click', saveNickname);
  nicknameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveNickname();
  });

  // Lightbox Preview Close
  previewCloseBtn.addEventListener('click', closePreview);
  previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) closePreview();
  });

  // Chat form submit
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !socket) return;

    socket.send(JSON.stringify({
      type: 'comment',
      user: nickname,
      text: text,
      taggedFile: currentTaggedFile   // null if no tag
    }));

    clearTaggedFile();
    chatInput.value = '';
    chatInput.focus();
  });

  // Search input filter
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const filtered = currentFiles.filter(file => file.name.toLowerCase().includes(query));
    renderFiles(filtered);
  });

  // Sort selector change
  sortSelect.addEventListener('change', () => {
    renderFiles(currentFiles);
  });

  // Refresh button
  refreshBtn.addEventListener('click', async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    refreshIcon.style.animation = 'spin 0.7s linear infinite';
    try {
      await fetchFiles(currentPath);
      await fetchComments();
      if (!isHost) await checkAndInitAutoSync();
      showToast('Refreshed', 'success');
    } finally {
      refreshIcon.style.animation = 'spin 0.7s linear 1';
      setTimeout(() => {
        refreshIcon.style.animation = '';
        refreshBtn.disabled = false;
      }, 700);
    }
  });

  // Tag indicator clear button
  tagIndicatorClear.addEventListener('click', () => clearTaggedFile());

  // Filter tabs
  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      chatFilter = tab.dataset.filter;
      applyFilter();
    });
  });

  // Drag and Drop files/folders
  setupDragAndDrop();
}

// -------------------------------------------------------------
// DRAG AND DROP HANDLER
// -------------------------------------------------------------
function setupDragAndDrop() {
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
  });

  dropZone.addEventListener('drop', async (e) => {
    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return;

    const items = dataTransfer.items;
    if (items && items.length > 0) {
      // Process DataTransferItems to support directory structures
      const uploadQueue = [];
      
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (typeof item.webkitGetAsEntry === 'function') {
          const entry = item.webkitGetAsEntry();
          if (entry) {
            uploadQueue.push(traverseEntry(entry));
          }
        }
      }

      try {
        const results = await Promise.all(uploadQueue);
        const allUploadedFiles = results.flat();
        
        if (allUploadedFiles.length > 0) {
          uploadFiles(allUploadedFiles);
        }
      } catch (err) {
        console.error('Error traversing files:', err);
        showToast('Error parsing dropped files', 'error');
      }
    } else if (dataTransfer.files.length > 0) {
      // Fallback for flat files
      handleStandardUpload(dataTransfer.files);
    }
  });
}

// Recursively traverse FileSystemEntry (file/directory) and return flat list of files with their relative paths
async function traverseEntry(entry, path = '') {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    });
    return [{ file, path: path + file.name }];
  } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    
    // Directories must read entries in chunks (HTML5 spec)
    const readAllEntries = async () => {
      const entries = [];
      const readChunk = async () => {
        const chunk = await new Promise((resolve, reject) => {
          dirReader.readEntries(resolve, reject);
        });
        if (chunk.length > 0) {
          entries.push(...chunk);
          return readChunk();
        }
        return entries;
      };
      return readChunk();
    };

    const childEntries = await readAllEntries();
    const traversePromises = childEntries.map(child => traverseEntry(child, path + entry.name + '/'));
    const subResults = await Promise.all(traversePromises);
    return subResults.flat();
  }
  return [];
}

// -------------------------------------------------------------
// CORE API CALLS
// -------------------------------------------------------------

// Fetch Files
async function fetchFiles(pathVal) {
  try {
    const response = await fetch(`/api/files?path=${encodeURIComponent(pathVal)}`);
    if (!response.ok) {
      throw new Error('Failed to retrieve file list');
    }
    const data = await response.json();
    currentFiles = data.files;
    renderFiles(currentFiles);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Create Folder
async function triggerCreateFolder() {
  const name = newFolderName.value.trim();
  if (!name) return;

  try {
    const response = await fetch('/api/create-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        parentPath: currentPath,
        nickname: nickname
      })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to create folder');
    }
    
    folderModal.classList.add('hidden');
    showToast(`Created folder "${name}"`, 'success');
    fetchFiles(currentPath);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Delete Item
async function triggerDeleteItem(itemPath) {
  if (!confirm(`Are you sure you want to delete "${itemPath.split('/').pop()}"?`)) return;

  try {
    const response = await fetch('/api/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: itemPath,
        nickname: nickname
      })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to delete item');
    }

    showToast('Deleted item successfully', 'success');
    fetchFiles(currentPath);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Upload Files helper
function handleStandardUpload(filesList) {
  const uploadArray = [];
  for (let i = 0; i < filesList.length; i++) {
    uploadArray.push({
      file: filesList[i],
      path: filesList[i].name
    });
  }
  uploadFiles(uploadArray);
}

function handleFolderUpload(filesList) {
  const uploadArray = [];
  for (let i = 0; i < filesList.length; i++) {
    const file = filesList[i];
    // webkitRelativePath contains "foldername/subfolder/file.txt"
    const filePath = file.webkitRelativePath || file.name;
    uploadArray.push({
      file: file,
      path: filePath
    });
  }
  uploadFiles(uploadArray);
}

// Main upload handler (handles file items array with paths)
function uploadFiles(itemsArray) {
  const formData = new FormData();
  
  formData.append('destPath', currentPath);
  formData.append('nickname', nickname);
  
  itemsArray.forEach(item => {
    formData.append('files', item.file);
    formData.append('paths', item.path);
  });

  // Configure AJAX Request with progress monitor
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);
  
  // Show progress bar
  progressContainer.classList.remove('hidden');
  progressFileInfo.textContent = `Uploading ${itemsArray.length} item(s)...`;
  updateProgress(0);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percentage = Math.round((e.loaded / e.total) * 100);
      updateProgress(percentage);
    }
  };

  xhr.onload = () => {
    progressContainer.classList.add('hidden');
    if (xhr.status >= 200 && xhr.status < 300) {
      showToast('Uploaded items successfully!', 'success');
      fetchFiles(currentPath);
    } else {
      let errMsg = 'Failed to upload files';
      try {
        const resObj = JSON.parse(xhr.responseText);
        errMsg = resObj.error || errMsg;
      } catch(e) {}
      showToast(errMsg, 'error');
    }
    // reset upload input fields
    uploadFilesInput.value = '';
    uploadFolderInput.value = '';
  };

  xhr.onerror = () => {
    progressContainer.classList.add('hidden');
    showToast('Network error during file upload', 'error');
  };

  xhr.send(formData);
}

function updateProgress(percentage) {
  progressPercentVal.textContent = `${percentage}%`;
  progressFill.style.width = `${percentage}%`;
}

// Fetch Comments list
async function fetchComments() {
  try {
    const response = await fetch('/api/comments');
    if (!response.ok) throw new Error('Failed to retrieve comments');
    const comments = await response.json();
    allMessages = comments;
    applyFilter();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// -------------------------------------------------------------
// RENDERING & INTERFACE ACTIONS
// -------------------------------------------------------------

// Render file items
function renderFiles(files) {
  filesContainer.innerHTML = '';
  
  if (files.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  
  emptyState.classList.add('hidden');

  // Sort files before rendering
  const sortCriteria = sortSelect.value;
  const sortedFiles = sortItems(files, sortCriteria);

  // If in list view, prepend the header row
  if (viewMode === 'list') {
    const headerEl = document.createElement('div');
    headerEl.className = 'file-list-header';
    headerEl.innerHTML = `
      <div class="header-col col-name">Name</div>
      <div class="header-col col-size">Size</div>
      <div class="header-col col-time">Date Modified</div>
      <div class="header-col col-user">Uploaded By</div>
      <div class="header-col col-actions" style="text-align: right; padding-right: 12px;">Actions</div>
    `;
    filesContainer.appendChild(headerEl);
  }
  
  sortedFiles.forEach(file => {
    const isDir = file.type === 'directory';
    const itemEl = document.createElement('div');
    itemEl.className = `file-item ${file.type}`;
    itemEl.dataset.path = file.path; // for highlight-by-badge
    
    // File Action triggers
    const downloadUrl = `/api/download?path=${encodeURIComponent(file.path)}`;
    
    // Get correct File SVG icon based on type / extension
    const iconSvg = getFileIcon(file);
    
    // Render structure depending on view mode
    if (viewMode === 'grid') {
      itemEl.innerHTML = `
        <div class="file-icon-wrapper">${iconSvg}</div>
        <div class="file-name" title="${file.name}">${file.name}</div>
        <div class="file-meta">${isDir ? 'Folder' : formatSize(file.size)}</div>
        <div class="file-actions">
          <a class="action-icon-btn download-action" href="${downloadUrl}" title="Download">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          </a>
          <button class="action-icon-btn tag-btn tag-action" title="Tag in comment">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.41l9 9c.36.37.86.59 1.41.59.55 0 1.05-.22 1.41-.58l7-7c.37-.36.59-.86.59-1.42 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>
          </button>
          <button class="action-icon-btn delete-btn delete-action" title="Delete">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      `;
    } else {
      // List view with columns
      const timeStr = formatTimestamp(file.uploadedAt || file.updatedAt);
      itemEl.innerHTML = `
        <div class="file-details-row">
          <div class="file-icon-wrapper">${iconSvg}</div>
          <div class="file-name" title="${file.name}">${file.name}</div>
        </div>
        <div class="file-size">${isDir ? 'Folder' : formatSize(file.size)}</div>
        <div class="file-time" title="${timeStr}">${timeStr}</div>
        <div class="file-user" title="${file.uploadedBy || 'System'}">${file.uploadedBy || 'System'}</div>
        <div class="file-actions">
          <a class="action-icon-btn download-action" href="${downloadUrl}" title="Download">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          </a>
          <button class="action-icon-btn tag-btn tag-action" title="Tag in comment">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.41l9 9c.36.37.86.59 1.41.59.55 0 1.05-.22 1.41-.58l7-7c.37-.36.59-.86.59-1.42 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>
          </button>
          <button class="action-icon-btn delete-btn delete-action" title="Delete">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      `;
    }

    // Double-click folder or single click preview file
    itemEl.addEventListener('click', (e) => {
      // Prevent triggering if clicked on action buttons
    if (e.target.closest('.download-action') || e.target.closest('.delete-action') || e.target.closest('.tag-action')) {
      return;
    }
      
      if (isDir) {
        navigateTo(file.path);
      } else {
        openPreview(file);
      }
    });

    // Wire delete button
    const deleteBtn = itemEl.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerDeleteItem(file.path);
    });

    // Wire tag button
    const tagBtn = itemEl.querySelector('.tag-btn');
    if (tagBtn) {
      tagBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setTaggedFile({ path: file.path, name: file.name });
      });
    }

    filesContainer.appendChild(itemEl);
  });
}

// Navigation Helper
function navigateTo(pathVal) {
  currentPath = pathVal;
  renderBreadcrumbs();
  fetchFiles(currentPath);
  // Clear search bar
  searchInput.value = '';
}

// Render Breadcrumbs
function renderBreadcrumbs() {
  breadcrumbs.innerHTML = '';
  
  // Home node
  const homeSpan = document.createElement('span');
  homeSpan.className = `breadcrumb-item ${currentPath === '' ? 'active' : ''}`;
  homeSpan.textContent = 'Home';
  homeSpan.addEventListener('click', () => {
    if (currentPath !== '') navigateTo('');
  });
  breadcrumbs.appendChild(homeSpan);
  
  if (currentPath === '') return;
  
  const segments = currentPath.split('/');
  let cumulativePath = '';
  
  segments.forEach((segment, index) => {
    cumulativePath += (index === 0 ? '' : '/') + segment;
    const isLast = index === segments.length - 1;
    
    const segmentSpan = document.createElement('span');
    segmentSpan.className = `breadcrumb-item ${isLast ? 'active' : ''}`;
    segmentSpan.textContent = segment;
    
    const targetPath = cumulativePath;
    if (!isLast) {
      segmentSpan.addEventListener('click', () => navigateTo(targetPath));
    }
    breadcrumbs.appendChild(segmentSpan);
  });
}

// Push a new message into the master list and re-render
function appendMessage(message) {
  allMessages.push(message);
  applyFilter();
}

// Same as receiveMessage — alias for legacy calls
function receiveMessage(message) {
  appendMessage(message);
}

// Re-render chat with current filter applied
function applyFilter() {
  chatMessages.innerHTML = '';
  const filtered = allMessages.filter(msg => {
    if (chatFilter === 'all') return true;
    if (chatFilter === 'messages') return msg.type === 'comment';
    if (chatFilter === 'tagged') return msg.type === 'comment' && msg.taggedFile;
    return true;
  });
  filtered.forEach(renderSingleMessage);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Render one message bubble into the chat DOM
function renderSingleMessage(message) {
  const isMe = message.user === nickname;
  const itemEl = document.createElement('div');

  if (message.type === 'notification') {
    itemEl.className = 'message-bubble notification';
    itemEl.innerHTML = `
      <div class="msg-text-box">
        <strong>${escapeHTML(message.user)}</strong> ${escapeHTML(message.text)}
      </div>
    `;
  } else {
    itemEl.className = `message-bubble ${isMe ? 'outgoing' : 'incoming'}`;
    const date = new Date(message.timestamp);
    const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Build the file tag badge if this comment is tagged to a file/folder
    const tagBadgeHtml = message.taggedFile ? `
      <div class="file-tag-badge" data-path="${escapeHTML(message.taggedFile.path)}">
        <svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.41l9 9c.36.37.86.59 1.41.59.55 0 1.05-.22 1.41-.58l7-7c.37-.36.59-.86.59-1.42 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>
        ${escapeHTML(message.taggedFile.name)}
      </div>` : '';

    itemEl.innerHTML = `
      ${tagBadgeHtml}
      <div class="msg-meta">
        <span class="msg-sender">${escapeHTML(message.user)}</span>
        <span class="msg-time">${timeString}</span>
      </div>
      <div class="msg-text-box">${linkify(escapeHTML(message.text))}</div>
    `;

    // Wire badge click → highlight file in list
    if (message.taggedFile) {
      const badge = itemEl.querySelector('.file-tag-badge');
      badge.addEventListener('click', () => highlightFile(message.taggedFile.path));
    }
  }

  chatMessages.appendChild(itemEl);
}

// Nickname Helpers
function showNicknameModal() {
  const adjectives = ['Cool', 'Swift', 'Bright', 'Neon', 'Lunar', 'Cyber', 'Deep', 'Retro', 'Epic'];
  const nouns = ['Panda', 'Eagle', 'Husky', 'Fox', 'Falcon', 'Lynx', 'Phoenix', 'Dolphin', 'Matrix'];
  const randNick = `${adjectives[Math.floor(Math.random() * adjectives.length)]}${nouns[Math.floor(Math.random() * nouns.length)]}`;
  
  nicknameInput.value = randNick;
  nicknameModal.classList.remove('hidden');
  nicknameInput.focus();
}

function saveNickname() {
  const inputVal = nicknameInput.value.trim();
  if (!inputVal) return;

  nickname = inputVal;
  localStorage.setItem('airbridge_nickname', nickname);
  nicknameModal.classList.add('hidden');

  updateNicknameUI();

  // Connect to the app
  if (!socket) {
    initApp();
  }
}

function updateNicknameUI() {
  userNicknameDisplay.textContent = nickname;
  headerUserAvatar.textContent = nickname.substring(0, 2);
}

// -------------------------------------------------------------
// FILE PREVIEW MEDIA HANDLER
// -------------------------------------------------------------
async function openPreview(file) {
  previewFilenameTxt.textContent = file.name;
  previewDownloadBtn.href = `/api/download?path=${encodeURIComponent(file.path)}`;
  
  const downloadUrl = `/api/download?path=${encodeURIComponent(file.path)}`;
  previewContentBox.innerHTML = '<span style="color:var(--text-secondary);">Loading preview...</span>';
  previewModal.classList.remove('hidden');

  const mimeType = file.mime || '';
  
  if (mimeType.startsWith('image/')) {
    previewContentBox.innerHTML = `<img src="${downloadUrl}" alt="${escapeHTML(file.name)}">`;
  } else if (mimeType.startsWith('video/')) {
    previewContentBox.innerHTML = `
      <video controls autoplay>
        <source src="${downloadUrl}" type="${mimeType}">
        Your browser does not support the video tag.
      </video>`;
  } else if (mimeType.startsWith('audio/')) {
    previewContentBox.innerHTML = `
      <audio controls autoplay>
        <source src="${downloadUrl}" type="${mimeType}">
        Your browser does not support the audio tag.
      </audio>`;
  } else if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/javascript' || mimeType === 'application/x-javascript' || file.name.endsWith('.txt') || file.name.endsWith('.md') || file.name.endsWith('.html') || file.name.endsWith('.css') || file.name.endsWith('.js') || file.name.endsWith('.json')) {
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error('Could not fetch file preview');
      const text = await response.text();
      // Cap at 100kb for performance
      const truncatedText = text.length > 102400 ? text.substring(0, 102400) + '\n\n... [Truncated for preview length] ...' : text;
      previewContentBox.innerHTML = `<div class="text-preview-box">${escapeHTML(truncatedText)}</div>`;
    } catch(err) {
      previewContentBox.innerHTML = `<span style="color:var(--danger);">${escapeHTML(err.message)}</span>`;
    }
  } else {
    // Unsupported binary type preview fallback
    previewContentBox.innerHTML = `
      <div class="binary-preview-box">
        <svg viewBox="0 0 24 24" width="72" height="72">
          <path fill="currentColor" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
        </svg>
        <p style="margin-bottom:15px;">Preview not available for this file type</p>
        <a class="action-btn primary-btn" href="${downloadUrl}">Download File (${formatSize(file.size)})</a>
      </div>
    `;
  }
}

function closePreview() {
  // Clear preview src/autoplay nodes
  previewContentBox.innerHTML = '';
  previewModal.classList.add('hidden');
}

// -------------------------------------------------------------
// AUTO-SYNC: Download files from host to guest automatically
// -------------------------------------------------------------
async function checkAndInitAutoSync() {
  try {
    const res = await fetch('/api/ishost');
    const data = await res.json();
    isHost = data.isHost;
    if (isHost) return; // Host doesn't need to auto-download its own files

    showSyncStatus('🔄 Checking for new files...');
    const syncRes = await fetch('/api/sync');
    const syncData = await syncRes.json();
    const allFiles = syncData.files || [];

    const toDownload = allFiles.filter(f => !syncedPaths.has(f.path));

    if (toDownload.length === 0) {
      showSyncStatus(`✅ All files up to date (${allFiles.length} file${allFiles.length !== 1 ? 's' : ''})`, true);
      return;
    }

    showSyncStatus(`⬇️ Syncing ${toDownload.length} new file${toDownload.length !== 1 ? 's' : ''}...`);
    for (const f of toDownload) {
      enqueueSyncDownload(f.path, f.path.split('/').pop());
    }
  } catch (err) {
    console.warn('Auto-sync check failed:', err);
  }
}

function enqueueSyncDownload(filePath, fileName) {
  // Avoid duplicate downloads
  if (syncedPaths.has(filePath)) return;
  // Avoid duplicate queue entries
  if (syncQueue.some(q => q.path === filePath)) return;
  syncQueue.push({ path: filePath, name: fileName });
  processSyncQueue();
}

async function processSyncQueue() {
  if (syncBusy || syncQueue.length === 0) return;
  syncBusy = true;

  while (syncQueue.length > 0) {
    const { path: filePath, name: fileName } = syncQueue.shift();
    try {
      showSyncStatus(`⬇️ Downloading: ${fileName}`);
      await downloadFileInBackground(filePath, fileName);
      syncedPaths.add(filePath);
      saveSyncedPaths();
    } catch (err) {
      console.warn('Failed to auto-download:', filePath, err);
    }
  }

  syncBusy = false;
  showSyncStatus('✅ Sync complete', true);
}

async function downloadFileInBackground(filePath, fileName) {
  const url = `/api/download?path=${encodeURIComponent(filePath)}`;
  // Use fetch + blob so the download works reliably in Electron
  // (anchor-click tricks are unreliable and browser-dependent)
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${fileName}`);
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }, 500);
}

// ─── 5-second polling fallback ───────────────────────────────────────────────
// WebSocket is the primary realtime channel, but if a packet is missed
// (brief disconnect, router quirk, etc.) this poller catches any new files.
let lastSyncHash = '';

async function startPollingSync() {
  if (isHost) return; // host is the source, nothing to poll
  // Wait a moment for isHost to be populated by checkAndInitAutoSync
  await new Promise(r => setTimeout(r, 2000));
  if (isHost) return;

  setInterval(async () => {
    try {
      const res = await fetch('/api/sync');
      if (!res.ok) return;
      const data = await res.json();
      const files = data.files || [];

      // Build a lightweight hash: sorted paths joined
      const hash = files.map(f => f.path + ':' + f.size).sort().join('|');
      if (hash === lastSyncHash) return; // nothing changed
      lastSyncHash = hash;

      // Refresh the visible file list
      fetchFiles(currentPath);

      // Queue any new files for download
      const toDownload = files.filter(f => !syncedPaths.has(f.path));
      if (toDownload.length > 0) {
        showSyncStatus(`⬇️ ${toDownload.length} new file${toDownload.length > 1 ? 's' : ''} detected...`);
        toDownload.forEach(f => enqueueSyncDownload(f.path, f.path.split('/').pop()));
      }
    } catch (err) {
      // Silently ignore — host may be temporarily unreachable
    }
  }, 5000);
}
// ─────────────────────────────────────────────────────────────────────────────

// -------------------------------------------------------------
// TAGGED COMMENT HELPERS
// -------------------------------------------------------------

function setTaggedFile(file) {
  currentTaggedFile = { path: file.path, name: file.name };
  tagIndicatorName.textContent = file.name;
  tagIndicator.classList.remove('hidden');
  // Switch to All tab so the user can see the thread context
  chatInput.focus();
  // Scroll chat to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function clearTaggedFile() {
  currentTaggedFile = null;
  tagIndicator.classList.add('hidden');
  tagIndicatorName.textContent = '';
}

// Highlight a file in the file list. Navigates to parent dir first if needed.
function highlightFile(filePath) {
  const parentDir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
  if (parentDir !== currentPath) {
    // Navigate to the folder that contains this file, then highlight
    navigateTo(parentDir);
    setTimeout(() => doHighlight(filePath), 350);
  } else {
    doHighlight(filePath);
  }
}

function doHighlight(filePath) {
  const item = filesContainer.querySelector(`.file-item[data-path="${CSS.escape(filePath)}"]`);
  if (!item) {
    showToast('File not visible in current folder', 'info');
    return;
  }
  item.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Remove first to allow re-triggering
  item.classList.remove('highlighted');
  void item.offsetWidth; // force reflow
  item.classList.add('highlighted');
  setTimeout(() => item.classList.remove('highlighted'), 2000);
}

function saveSyncedPaths() {
  try {
    localStorage.setItem('airbridge_synced', JSON.stringify([...syncedPaths]));
  } catch(e) {}
}

let syncStatusTimeout = null;
function showSyncStatus(message, autoHide = false) {
  let el = document.getElementById('sync-status-bar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sync-status-bar';
    el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(20,21,41,0.92);border:1px solid rgba(99,179,237,0.4);color:#a0c4ff;padding:8px 20px;border-radius:30px;font-size:13px;z-index:9999;backdrop-filter:blur(12px);box-shadow:0 4px 20px rgba(0,0,0,0.4);transition:opacity 0.4s ease;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.style.opacity = '1';
  el.textContent = message;
  if (syncStatusTimeout) clearTimeout(syncStatusTimeout);
  if (autoHide) {
    syncStatusTimeout = setTimeout(() => { el.style.opacity = '0'; }, 3000);
  }
}

// -------------------------------------------------------------
// UTILITIES AND HELPERS
// -------------------------------------------------------------
function sortItems(items, criteria) {
  const [field, direction] = criteria.split('-');
  const dirMultiplier = direction === 'asc' ? 1 : -1;

  // Separate folders and files to keep folders always at top
  const folders = items.filter(i => i.type === 'directory');
  const files = items.filter(i => i.type === 'file');

  const compare = (a, b) => {
    let valA, valB;
    if (field === 'name') {
      valA = a.name.toLowerCase();
      valB = b.name.toLowerCase();
    } else if (field === 'time') {
      valA = new Date(a.uploadedAt || a.updatedAt).getTime();
      valB = new Date(b.uploadedAt || b.updatedAt).getTime();
    } else if (field === 'user') {
      valA = (a.uploadedBy || 'System').toLowerCase();
      valB = (b.uploadedBy || 'System').toLowerCase();
    }
    if (valA < valB) return -1 * dirMultiplier;
    if (valA > valB) return 1 * dirMultiplier;
    return 0;
  };

  folders.sort(compare);
  files.sort(compare);

  return [...folders, ...files];
}

function formatTimestamp(isoStr) {
  if (!isoStr) return '';
  const date = new Date(isoStr);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

function linkify(text) {
  const urlRegex =/(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
  return text.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan);text-decoration:underline;">${url}</a>`;
  });
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let iconSvg = '';
  if (type === 'success') {
    iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>`;
  } else if (type === 'error') {
    iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
  } else {
    iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`;
  }
  
  toast.innerHTML = `${iconSvg} <span>${escapeHTML(message)}</span>`;
  toastContainer.appendChild(toast);
  
  // Fade out and remove
  setTimeout(() => {
    toast.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => {
      toast.remove();
    }, 500);
  }, 4000);
}

// Icon mapper depending on file metadata
function getFileIcon(file) {
  const isDir = file.type === 'directory';
  const name = file.name.toLowerCase();
  
  if (isDir) {
    return `<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.11-.89-2-2-2h-8l-2-2z"/></svg>`;
  }
  
  // Extension matches
  const ext = name.split('.').pop();
  
  // Image types
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext)) {
    return `<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-4.86 8.86l-3 3.87L9 13.14 6 17h12l-3.86-5.14z"/></svg>`;
  }
  
  // Video types
  if (['mp4', 'mkv', 'webm', 'avi', 'mov', 'flv'].includes(ext)) {
    return `<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>`;
  }
  
  // Audio types
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) {
    return `<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
  }
  
  // PDF
  if (ext === 'pdf') {
    return `<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v1.25c0 .41-.34.75-.75.75s-.75-.34-.75-.75V8.5h2.25c.83 0 1.5.67 1.5 1.5zm6.25 1.75c0 .41-.34.75-.75.75H15v1.25c0 .41-.34.75-.75.75s-.75-.34-.75-.75V8.5h3c.41 0 .75.34.75.75v1.5zm-3.75-2.75h1.5v1.5H14V8.5zm-5 1.5H10v1H9v-1zm10.75.75c0 .41-.34.75-.75.75H19v.75c0 .41-.34.75-.75.75s-.75-.34-.75-.75V8.5H19c.41 0 .75.34.75.75v1.5z"/></svg>`;
  }

  // Code/Text file
  if (['txt', 'md', 'html', 'css', 'js', 'json', 'c', 'cpp', 'py', 'java', 'go', 'php'].includes(ext)) {
    return `<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`;
  }
  
  // Generic File fallback
  return `<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/></svg>`;
}
