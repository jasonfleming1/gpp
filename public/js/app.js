// ============================================
// LENIS SMOOTH SCROLLING
// ============================================

let lenis;

function initLenis() {
  if (typeof Lenis === 'undefined') return;

  lenis = new Lenis({
    duration: 1.2,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    orientation: 'vertical',
    gestureOrientation: 'vertical',
    smoothWheel: true,
    wheelMultiplier: 1,
    touchMultiplier: 2,
    infinite: false,
  });

  function raf(time) {
    lenis.raf(time);
    requestAnimationFrame(raf);
  }

  requestAnimationFrame(raf);
}

// Initialize Lenis on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLenis);
} else {
  initLenis();
}

// ============================================
// ALERT MANAGER - Modal-based notifications
// ============================================

class AlertManager {
  constructor() {
    this.alertContainer = null;
    this.init();
  }

  init() {
    // Create alert container if it doesn't exist
    if (!document.getElementById('alertContainer')) {
      this.alertContainer = document.createElement('div');
      this.alertContainer.id = 'alertContainer';
      this.alertContainer.className = 'alert-container';
      document.body.appendChild(this.alertContainer);
    } else {
      this.alertContainer = document.getElementById('alertContainer');
    }
  }

  // Show toast notification
  showAlert(message, type = 'info', duration = 3000) {
    const alertTypes = {
      success: { bg: 'var(--semantic-success)', icon: this.getIcon('success') },
      error: { bg: 'var(--semantic-error)', icon: this.getIcon('error') },
      warning: { bg: 'var(--semantic-warning)', icon: this.getIcon('warning') },
      info: { bg: 'var(--semantic-info)', icon: this.getIcon('info') }
    };

    const config = alertTypes[type] || alertTypes.info;

    const alert = document.createElement('div');
    alert.className = 'toast-alert';
    alert.style.cssText = `
      background: ${config.bg};
      color: white;
      padding: 1rem 1.5rem;
      border-radius: 0.75rem;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-weight: 500;
      font-size: 0.875rem;
      animation: slideInRight 0.3s ease;
      max-width: 400px;
    `;
    alert.innerHTML = `${config.icon}<span>${message}</span>`;

    this.alertContainer.appendChild(alert);

    if (duration > 0) {
      setTimeout(() => {
        alert.style.animation = 'slideOutRight 0.3s ease forwards';
        setTimeout(() => alert.remove(), 300);
      }, duration);
    }

    return alert;
  }

  getIcon(type) {
    const icons = {
      success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      error: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      warning: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };
    return icons[type] || icons.info;
  }

  // Show confirmation modal
  showConfirm(options = {}) {
    const {
      title = 'Confirm Action',
      message = 'Are you sure?',
      confirmText = 'Confirm',
      cancelText = 'Cancel',
      confirmClass = 'btn-danger',
      onConfirm = () => {},
      onCancel = () => {}
    } = options;

    // Remove existing confirm modal
    const existing = document.getElementById('confirmModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'confirmModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 440px;">
        <div class="modal-header">
          <h2>${title}</h2>
          <button class="modal-close" id="confirmModalClose">&times;</button>
        </div>
        <div class="modal-body">
          <p style="margin: 0; color: var(--text-secondary);">${message}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="confirmModalCancel">${cancelText}</button>
          <button class="btn ${confirmClass}" id="confirmModalConfirm">${confirmText}</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeModal = () => {
      modal.remove();
    };

    modal.querySelector('#confirmModalClose').onclick = () => {
      closeModal();
      onCancel();
    };

    modal.querySelector('#confirmModalCancel').onclick = () => {
      closeModal();
      onCancel();
    };

    modal.querySelector('#confirmModalConfirm').onclick = () => {
      closeModal();
      onConfirm();
    };

    // Close on backdrop click
    modal.onclick = (e) => {
      if (e.target === modal) {
        closeModal();
        onCancel();
      }
    };

    return modal;
  }
}

// Global alert manager instance
const alertManager = new AlertManager();

// ============================================
// THEME HANDLING
// ============================================

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  updateThemeIcon();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  // Sun icon for dark mode (click to switch to light)
  const sunIcon = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';

  // Moon icon for light mode (click to switch to dark)
  const moonIcon = '<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  btn.innerHTML = isDark ? sunIcon : moonIcon;
  btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

// Initialize theme before DOM loads to prevent flash
initTheme();

// ============================================
// DOM READY
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  // Theme toggle
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme);
    updateThemeIcon();
  }

  // Import button - open modal
  const importBtn = document.getElementById('importBtn');
  if (importBtn) {
    importBtn.addEventListener('click', openImportModal);
  }

  // Delete all button
  const deleteAllBtn = document.getElementById('deleteAllBtn');
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', deleteAllData);
  }
});

// ============================================
// IMPORT MODAL
// ============================================

function openImportModal() {
  const modal = document.getElementById('importModal');
  if (modal) {
    modal.classList.remove('hidden');
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
  }
}

function closeImportModal() {
  const modal = document.getElementById('importModal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function doImport() {
  const fileInput = document.getElementById('fileInput');
  const clearCheckbox = document.getElementById('clearDataCheckbox');
  const btn = document.getElementById('doImportBtn');

  if (!fileInput || !fileInput.files.length) {
    alertManager.showAlert('Please select an Excel file to import', 'warning');
    return;
  }

  const clearData = clearCheckbox && clearCheckbox.checked;

  if (clearData) {
    alertManager.showConfirm({
      title: 'Clear Existing Data?',
      message: 'This will delete ALL existing data before importing. This cannot be undone.',
      confirmText: 'Clear & Import',
      confirmClass: 'btn-danger',
      onConfirm: () => performImport(fileInput.files[0], true, btn)
    });
  } else {
    performImport(fileInput.files[0], false, btn);
  }
}

async function performImport(file, clearData, btn) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('clearData', clearData ? 'true' : 'false');

  try {
    btn.textContent = 'Importing...';
    btn.disabled = true;

    const res = await fetch('/api/tfs/import', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();

    if (data.success) {
      alertManager.showAlert(data.message, 'success');
      closeImportModal();
      setTimeout(() => window.location.reload(), 1500);
    } else {
      throw new Error(data.error || 'Import failed');
    }
  } catch (error) {
    alertManager.showAlert('Import error: ' + error.message, 'error');
  } finally {
    btn.textContent = 'Import';
    btn.disabled = false;
  }
}

// ============================================
// DELETE ALL
// ============================================

function deleteAllData() {
  alertManager.showConfirm({
    title: 'Delete All Data?',
    message: 'This will permanently remove ALL tasks, estimates, quality scores, and developer records. This action cannot be undone!',
    confirmText: 'Delete Everything',
    confirmClass: 'btn-danger',
    onConfirm: () => {
      alertManager.showConfirm({
        title: 'Final Confirmation',
        message: 'Are you absolutely sure? All data will be permanently deleted.',
        confirmText: 'Yes, Delete All',
        confirmClass: 'btn-danger',
        onConfirm: performDeleteAll
      });
    }
  });
}

async function performDeleteAll() {
  const btn = document.getElementById('deleteAllBtn');
  try {
    if (btn) {
      btn.textContent = 'Deleting...';
      btn.disabled = true;
    }

    const res = await fetch('/api/tfs/delete-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await res.json();

    if (data.success) {
      alertManager.showAlert(data.message, 'success');
      setTimeout(() => window.location.reload(), 1500);
    } else {
      throw new Error(data.error || 'Delete failed');
    }
  } catch (error) {
    alertManager.showAlert('Delete error: ' + error.message, 'error');
  } finally {
    if (btn) {
      btn.textContent = 'Delete All';
      btn.disabled = false;
    }
  }
}
