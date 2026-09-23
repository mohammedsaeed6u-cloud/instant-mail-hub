let currentAccountId = null;
let currentMessageId = null;
let accounts = [];
let pollInterval = null;

const STORAGE_KEY = 'instant_mail_accounts_v1';

// DOM Elements
const accountsListEl = document.getElementById('accounts-list');
const accountsCountEl = document.getElementById('accounts-count');
const currentEmailEl = document.getElementById('current-email');
const btnCopyEmail = document.getElementById('btn-copy-email');
const btnRefresh = document.getElementById('btn-refresh');
const autoRefreshCheck = document.getElementById('auto-refresh-check');
const messagesListEl = document.getElementById('messages-list');
const messagesCountEl = document.getElementById('messages-count');

// Viewer Elements
const emptyViewerEl = document.getElementById('empty-viewer');
const messageDetailEl = document.getElementById('message-detail');
const otpCardEl = document.getElementById('otp-card');
const otpCodeEl = document.getElementById('otp-code');
const btnCopyOtp = document.getElementById('btn-copy-otp');
const msgSubjectEl = document.getElementById('msg-subject');
const msgFromEl = document.getElementById('msg-from');
const msgToEl = document.getElementById('msg-to');
const msgDateEl = document.getElementById('msg-date');
const msgIframeEl = document.getElementById('msg-iframe');
const msgTextContentEl = document.getElementById('msg-text-content');
const tabBtns = document.querySelectorAll('.tab-btn');

// Modal Elements
const createModal = document.getElementById('create-modal');
const btnOpenCreate = document.getElementById('btn-open-create');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnCancelModal = document.getElementById('btn-cancel-modal');
const createForm = document.getElementById('create-account-form');
const selectDomain = document.getElementById('select-domain');
const inputUsername = document.getElementById('input-username');
const inputNote = document.getElementById('input-note');
const toastEl = document.getElementById('toast');

// Backup Elements
const btnExport = document.getElementById('btn-export-accounts');
const btnImport = document.getElementById('btn-import-accounts');
const fileImport = document.getElementById('file-import-accounts');

// Toast Notification
function showToast(message, duration = 3000) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  setTimeout(() => {
    toastEl.classList.add('hidden');
  }, duration);
}

// Copy to Clipboard
async function copyToClipboard(text, successMsg = 'تم النسخ بنجاح!') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg);
  } catch (err) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast(successMsg);
  }
}

// Format Date
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString('ar-EG');
}

// LocalStorage Helpers
function getSavedAccounts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function persistAccounts(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('LocalStorage save error:', e);
  }
}

// Fetch Domains
async function loadDomains() {
  try {
    const res = await fetch('/api/domains');
    const data = await res.json();
    if (data.domains && data.domains.length > 0) {
      selectDomain.innerHTML = data.domains.map(d => `<option value="${d}">${d}</option>`).join('');
    } else {
      selectDomain.innerHTML = '<option value="">لا تتوفر نطاقات حالياً</option>';
    }
  } catch (err) {
    console.error('Failed to load domains:', err);
  }
}

// Load Accounts (from LocalStorage, with fallback migration from server)
async function loadAccounts() {
  accounts = getSavedAccounts();

  // If local storage is empty, try migrating from server /api/accounts (for local mode)
  if (accounts.length === 0) {
    try {
      const res = await fetch('/api/accounts');
      if (res.ok) {
        const data = await res.json();
        if (data.accounts && data.accounts.length > 0) {
          accounts = data.accounts;
          persistAccounts(accounts);
        }
      }
    } catch (e) {
      // serverless or no /api/accounts
    }
  }

  renderAccounts();

  if (accounts.length > 0 && !currentAccountId) {
    selectAccount(accounts[0].id);
  } else if (accounts.length === 0) {
    currentAccountId = null;
    currentEmailEl.textContent = 'لا يوجد إيميل منشأ بعد';
    btnCopyEmail.disabled = true;
    messagesListEl.innerHTML = '<div class="empty-state">اضغط على زر "إنشاء بريد جديد" للبدء</div>';
    emptyViewerEl.classList.remove('hidden');
    messageDetailEl.classList.add('hidden');
  }
}

// Render Accounts List
function renderAccounts() {
  accountsCountEl.textContent = accounts.length;
  if (accounts.length === 0) {
    accountsListEl.innerHTML = '<div class="empty-state">لا توجد حسابات حتى الآن</div>';
    return;
  }

  accountsListEl.innerHTML = accounts.map(acc => `
    <div class="account-item ${acc.id === currentAccountId ? 'active' : ''}" data-id="${acc.id}">
      <div class="account-row">
        <span class="account-email" title="${acc.address}">${acc.address}</span>
        <div class="account-actions">
          <button class="icon-btn copy-acc-btn" data-email="${acc.address}" title="نسخ">📋</button>
          <button class="icon-btn delete-btn" data-id="${acc.id}" title="حذف">🗑️</button>
        </div>
      </div>
      ${acc.note ? `<span class="account-note">${acc.note}</span>` : ''}
    </div>
  `).join('');

  document.querySelectorAll('.account-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.account-actions')) return;
      selectAccount(item.dataset.id);
    });
  });

  document.querySelectorAll('.copy-acc-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(btn.dataset.email, 'تم نسخ الإيميل!');
    });
  });

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('هل أنت متأكد من رغبتك في حذف هذا الإيميل؟')) return;
      await deleteAccount(btn.dataset.id);
    });
  });
}

// Select Account
async function selectAccount(id) {
  currentAccountId = id;
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;

  currentEmailEl.textContent = acc.address;
  btnCopyEmail.disabled = false;
  renderAccounts();
  await loadMessages();
}

// Delete Account
async function deleteAccount(id) {
  const acc = accounts.find(a => a.id === id);
  if (acc && acc.token) {
    // Attempt remote deletion silently
    fetch(`/api/accounts/delete?id=${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${acc.token}` }
    }).catch(() => {});
  }

  accounts = accounts.filter(a => a.id !== id);
  persistAccounts(accounts);
  showToast('تم حذف الحساب بنجاح');
  if (currentAccountId === id) currentAccountId = null;
  await loadAccounts();
}

// Load Messages for current account
async function loadMessages(isSilent = false) {
  if (!currentAccountId) return;
  const acc = accounts.find(a => a.id === currentAccountId);
  if (!acc || !acc.token) return;

  if (!isSilent) {
    messagesListEl.innerHTML = '<div class="loading-state">جاري فحص الرسائل...</div>';
  }

  try {
    // Try Vercel route first: /api/messages with header
    let res = await fetch('/api/messages', {
      headers: { 'Authorization': `Bearer ${acc.token}` }
    });

    // Fallback to local server route if 404
    if (res.status === 404) {
      res = await fetch(`/api/accounts/${currentAccountId}/messages`);
    }

    const data = await res.json();
    const messages = data.messages || [];
    messagesCountEl.textContent = `${messages.length} رسائل`;

    if (messages.length === 0) {
      messagesListEl.innerHTML = `
        <div class="empty-state">
          <p>لا توجد رسائل واردة حتى الآن.</p>
          <small>صندوق الوارد يفحص تلقائياً كل 5 ثوانٍ</small>
        </div>
      `;
      if (!currentMessageId) {
        emptyViewerEl.classList.remove('hidden');
        messageDetailEl.classList.add('hidden');
      }
      return;
    }

    messagesListEl.innerHTML = messages.map(m => `
      <div class="message-item ${m.id === currentMessageId ? 'active' : ''} ${!m.seen ? 'unseen' : ''}" data-id="${m.id}">
        <div class="msg-item-top">
          <span class="msg-sender">${m.from}</span>
          <span class="msg-date">${formatDate(m.createdAt)}</span>
        </div>
        <div class="msg-subject-preview">${m.subject}</div>
        <div class="msg-snippet">${m.intro || ''}</div>
        ${m.otp ? `<div class="msg-otp-tag">🔑 كود: ${m.otp}</div>` : ''}
      </div>
    `).join('');

    document.querySelectorAll('.message-item').forEach(item => {
      item.addEventListener('click', () => {
        selectMessage(item.dataset.id);
      });
    });

    if (!currentMessageId && messages.length > 0) {
      selectMessage(messages[0].id);
    }
  } catch (err) {
    console.error('Failed to load messages:', err);
    if (!isSilent) {
      messagesListEl.innerHTML = '<div class="loading-state">فشل الاتصال بجلب الرسائل</div>';
    }
  }
}

// Select & View Specific Message
async function selectMessage(msgId) {
  currentMessageId = msgId;
  renderMessagesActiveState();

  const acc = accounts.find(a => a.id === currentAccountId);
  if (!acc || !acc.token) return;

  try {
    // Try Vercel serverless query first
    let res = await fetch(`/api/messages?msgId=${msgId}`, {
      headers: { 'Authorization': `Bearer ${acc.token}` }
    });

    // Fallback to local server route if needed
    if (res.status === 404) {
      res = await fetch(`/api/accounts/${currentAccountId}/messages/${msgId}`);
    }

    const msg = await res.json();

    emptyViewerEl.classList.add('hidden');
    messageDetailEl.classList.remove('hidden');

    msgSubjectEl.textContent = msg.subject || '(بدون عنوان)';
    msgFromEl.textContent = msg.from ? `${msg.from.name || ''} <${msg.from.address}>` : 'غير معروف';
    msgToEl.textContent = (msg.to || []).map(t => t.address).join(', ');
    msgDateEl.textContent = formatDate(msg.createdAt);

    if (msg.otp) {
      otpCardEl.classList.remove('hidden');
      otpCodeEl.textContent = msg.otp;
      btnCopyOtp.onclick = () => copyToClipboard(msg.otp, 'تم نسخ كود التحقق!');
    } else {
      otpCardEl.classList.add('hidden');
    }

    if (msg.html) {
      msgIframeEl.srcdoc = msg.html;
    } else {
      msgIframeEl.srcdoc = `<div style="font-family:sans-serif;padding:20px;white-space:pre-wrap;">${msg.text || ''}</div>`;
    }

    msgTextContentEl.textContent = msg.text || '(لا يوجد نص عادي)';
  } catch (err) {
    console.error('Failed to fetch message details:', err);
    showToast('فشل تحميل تفاصيل الرسالة');
  }
}

function renderMessagesActiveState() {
  document.querySelectorAll('.message-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === currentMessageId);
  });
}

// Modal Handlers
btnOpenCreate.addEventListener('click', () => {
  createModal.classList.remove('hidden');
  inputUsername.value = '';
  inputNote.value = '';
});

const closeModal = () => createModal.classList.add('hidden');
btnCloseModal.addEventListener('click', closeModal);
btnCancelModal.addEventListener('click', closeModal);

createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = inputUsername.value.trim();
  const domain = selectDomain.value;
  const note = inputNote.value.trim();

  const submitBtn = document.getElementById('btn-submit-create');
  submitBtn.disabled = true;
  submitBtn.textContent = 'جاري الإنشاء...';

  try {
    const res = await fetch('/api/accounts/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, domain, note })
    });
    const data = await res.json();
    if (data.success && data.account) {
      accounts.unshift(data.account);
      persistAccounts(accounts);

      showToast(`تم إنشاء الإيميل: ${data.account.address}`);
      closeModal();
      renderAccounts();
      selectAccount(data.account.id);
    } else {
      showToast(data.error || 'فشل إنشاء الحساب');
    }
  } catch (err) {
    showToast('خطأ أثناء إنشاء الحساب');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'إنشاء وحفظ البريد';
  }
});

// Top bar Actions
btnCopyEmail.addEventListener('click', () => {
  const acc = accounts.find(a => a.id === currentAccountId);
  if (acc) copyToClipboard(acc.address, 'تم نسخ الإيميل إلى الحافظة!');
});

btnRefresh.addEventListener('click', () => {
  loadMessages(false);
  showToast('تم تحديث الرسائل');
});

// Tab Switcher
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    if (tab === 'html') {
      msgIframeEl.classList.remove('hidden');
      msgTextContentEl.classList.add('hidden');
    } else {
      msgIframeEl.classList.add('hidden');
      msgTextContentEl.classList.remove('hidden');
    }
  });
});

// Auto Refresh Polling
function setupAutoRefresh() {
  if (pollInterval) clearInterval(pollInterval);
  if (autoRefreshCheck.checked) {
    pollInterval = setInterval(() => {
      if (currentAccountId) {
        loadMessages(true);
      }
    }, 5000);
  }
}

autoRefreshCheck.addEventListener('change', setupAutoRefresh);

// Export & Import Backup Handlers
btnExport.addEventListener('click', () => {
  if (accounts.length === 0) {
    return showToast('لا توجد حسابات لتصديرها');
  }
  const blob = new Blob([JSON.stringify(accounts, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `instant_mail_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  showToast('تم تحميل ملف النسخة الاحتياطية بنجاح 💾');
});

btnImport.addEventListener('click', () => {
  fileImport.click();
});

fileImport.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const imported = JSON.parse(event.target.result);
      if (Array.isArray(imported)) {
        // Merge without duplicates
        const existingIds = new Set(accounts.map(a => a.id));
        let addedCount = 0;
        for (const item of imported) {
          if (item.id && !existingIds.has(item.id)) {
            accounts.push(item);
            addedCount++;
          }
        }
        persistAccounts(accounts);
        renderAccounts();
        showToast(`تم استيراد ${addedCount} حساب بنجاح! 🎉`);
        if (accounts.length > 0 && !currentAccountId) {
          selectAccount(accounts[0].id);
        }
      } else {
        showToast('ملف غير صالح');
      }
    } catch (err) {
      showToast('خطأ في قراءة الملف');
    }
  };
  reader.readAsText(file);
});

// Init
window.addEventListener('DOMContentLoaded', async () => {
  await loadDomains();
  await loadAccounts();
  setupAutoRefresh();
});
