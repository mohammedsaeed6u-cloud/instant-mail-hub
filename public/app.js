let currentAccountId = null;
let currentMessageId = null;
let accounts = [];
let pollInterval = null;

const STORAGE_KEY = 'instant_mail_accounts_v2';

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
const tabCreateNew = document.getElementById('tab-create-new');
const tabReclaimOld = document.getElementById('tab-reclaim-old');
const createForm = document.getElementById('create-account-form');
const reclaimForm = document.getElementById('reclaim-account-form');
const selectDomain = document.getElementById('select-domain');
const inputUsername = document.getElementById('input-username');
const inputNote = document.getElementById('input-note');
const inputReclaimAddress = document.getElementById('input-reclaim-address');
const selectReclaimDomain = document.getElementById('select-reclaim-domain');
const inputReclaimNote = document.getElementById('input-reclaim-note');
const btnCancelReclaim = document.getElementById('btn-cancel-reclaim');
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

// Load Accounts from Cloud Database
async function loadAccounts() {
  // 1. Initial fast render from localStorage cache
  const cached = getSavedAccounts();
  if (cached.length > 0 && accounts.length === 0) {
    accounts = cached;
    renderAccounts();
    if (!currentAccountId) selectAccount(accounts[0].id);
  }

  // 2. Fetch authoritative accounts list from server (Supabase Postgres)
  try {
    const res = await fetch('/api/accounts');
    if (res.ok) {
      const data = await res.json();
      if (data.accounts && Array.isArray(data.accounts)) {
        accounts = data.accounts;
        persistAccounts(accounts);
        renderAccounts();

        if (accounts.length > 0 && !currentAccountId) {
          selectAccount(accounts[0].id);
        } else if (currentAccountId) {
          const stillExists = accounts.some(a => a.id === currentAccountId);
          if (!stillExists && accounts.length > 0) {
            selectAccount(accounts[0].id);
          }
        }
      }
    }
  } catch (err) {
    console.warn('Network fetch accounts failed, using cached list:', err.message);
  }

  if (accounts.length === 0) {
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
          <button class="icon-btn copy-acc-btn" data-email="${acc.address}" title="نسخ البريد">📋</button>
          <button class="icon-btn delete-btn" data-id="${acc.id}" title="حذف">🗑️</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:2px;">
        ${acc.note ? `<span class="account-note">${acc.note}</span>` : '<span></span>'}
        <span class="badge" style="background:#1e3a8a;color:#93c5fd;font-size:0.68rem;padding:2px 6px;">دائم ♾️</span>
      </div>
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
      if (!confirm('هل أنت متأكد من حذف هذا الحساب؟')) return;
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
  try {
    await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
  } catch (e) {}

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
  if (!acc) return;

  if (!isSilent) {
    messagesListEl.innerHTML = '<div class="loading-state">جاري فحص الرسائل الدائمة والواردة...</div>';
  }

  try {
    const queryParams = new URLSearchParams({
      address: acc.address,
      provider: acc.provider || 'guerrilla'
    });
    if (acc.token) queryParams.set('token', acc.token);

    const res = await fetch(`/api/messages?${queryParams.toString()}`, {
      headers: {
        'Authorization': `Bearer ${acc.token || ''}`,
        'X-Provider': acc.provider || 'guerrilla',
        'X-Address': acc.address
      }
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const messages = data.messages || [];

    messagesCountEl.textContent = `${messages.length} رسائل`;

    if (messages.length === 0) {
      messagesListEl.innerHTML = `
        <div class="empty-state">
          <p>لا توجد رسائل واردة حتى الآن لهذا البريد.</p>
          <small>صندوق الوارد يفحص تلقائياً كل 5 ثوانٍ، وكل رسالة تصل تُحفظ دائماً 💾</small>
        </div>
      `;
      if (!currentMessageId) {
        emptyViewerEl.classList.remove('hidden');
        messageDetailEl.classList.add('hidden');
      }
      return;
    }

    messagesListEl.innerHTML = messages.map(m => {
      const isFb = (m.from && (m.from.includes('facebook') || m.from.address?.includes('facebook'))) || (m.subject && m.subject.toLowerCase().includes('facebook'));
      return `
        <div class="message-item ${m.id === currentMessageId ? 'active' : ''} ${!m.seen ? 'unseen' : ''}" data-id="${m.id}" style="${isFb ? 'border-right: 3px solid #1877f2;' : ''}">
          <div class="msg-item-top">
            <span class="msg-sender">${typeof m.from === 'object' ? (m.from.name || m.from.address) : m.from}</span>
            <span class="msg-date">${formatDate(m.createdAt)}</span>
          </div>
          <div class="msg-subject-preview">${m.subject}</div>
          <div class="msg-snippet">${m.intro || ''}</div>
          ${m.otp ? `<div class="msg-otp-tag" style="background:#1e3a8a;color:#60a5fa;display:inline-block;padding:3px 8px;border-radius:6px;font-size:0.75rem;font-weight:bold;margin-top:6px;">🔑 كود: ${m.otp}</div>` : ''}
        </div>
      `;
    }).join('');

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
      messagesListEl.innerHTML = `<div class="loading-state">فشل جلب الرسائل (${err.message})<br><button onclick="loadMessages(false)" class="btn btn-sm btn-outline" style="margin-top:8px">إعادة المحاولة 🔄</button></div>`;
    }
  }
}

// Select & View Specific Message
async function selectMessage(msgId) {
  currentMessageId = msgId;
  renderMessagesActiveState();

  const acc = accounts.find(a => a.id === currentAccountId);
  if (!acc) return;

  try {
    const queryParams = new URLSearchParams({
      msgId: msgId,
      address: acc.address,
      provider: acc.provider || 'guerrilla'
    });
    if (acc.token) queryParams.set('token', acc.token);

    const res = await fetch(`/api/messages?${queryParams.toString()}`, {
      headers: {
        'Authorization': `Bearer ${acc.token || ''}`,
        'X-Provider': acc.provider || 'guerrilla',
        'X-Address': acc.address
      }
    });

    const msg = await res.json();
    if (!res.ok) throw new Error(msg.error || 'Failed to fetch message');

    emptyViewerEl.classList.add('hidden');
    messageDetailEl.classList.remove('hidden');

    msgSubjectEl.textContent = msg.subject || '(بدون عنوان)';
    msgFromEl.textContent = msg.from ? (typeof msg.from === 'object' ? `${msg.from.name || ''} <${msg.from.address || ''}>` : msg.from) : 'غير معروف';
    msgToEl.textContent = (msg.to || []).map(t => (typeof t === 'object' ? t.address : t)).join(', ') || acc.address;
    msgDateEl.textContent = formatDate(msg.createdAt);

    if (msg.otp) {
      otpCardEl.classList.remove('hidden');
      otpCodeEl.textContent = msg.otp;
      btnCopyOtp.onclick = () => copyToClipboard(msg.otp, 'تم نسخ كود التحقق بنجاح! 🔑');
    } else {
      otpCardEl.classList.add('hidden');
    }

    if (msg.html) {
      msgIframeEl.srcdoc = msg.html;
    } else {
      msgIframeEl.srcdoc = `<div style="font-family:sans-serif;padding:20px;white-space:pre-wrap;line-height:1.6;">${msg.text || ''}</div>`;
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

// Modal Handlers & Tab Switching
btnOpenCreate.addEventListener('click', () => {
  createModal.classList.remove('hidden');
  inputUsername.value = '';
  inputNote.value = '';
  inputReclaimAddress.value = '';
  inputReclaimNote.value = '';
  switchModalTab('create');
});

const closeModal = () => createModal.classList.add('hidden');
btnCloseModal.addEventListener('click', closeModal);
btnCancelModal.addEventListener('click', closeModal);
btnCancelReclaim.addEventListener('click', closeModal);

function switchModalTab(tab) {
  if (tab === 'create') {
    tabCreateNew.classList.add('active');
    tabReclaimOld.classList.remove('active');
    createForm.classList.remove('hidden');
    reclaimForm.classList.add('hidden');
  } else {
    tabReclaimOld.classList.add('active');
    tabCreateNew.classList.remove('active');
    reclaimForm.classList.remove('hidden');
    createForm.classList.add('hidden');
  }
}

tabCreateNew.addEventListener('click', () => switchModalTab('create'));
tabReclaimOld.addEventListener('click', () => switchModalTab('reclaim'));

// Submit Create Form
createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = inputUsername.value.trim();
  const domain = selectDomain.value || 'sharklasers.com';
  const note = inputNote.value.trim();

  const submitBtn = document.getElementById('btn-submit-create');
  submitBtn.disabled = true;
  submitBtn.textContent = 'جاري الإنشاء والحفظ بالسحابة...';

  try {
    const res = await fetch('/api/accounts/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, domain, note, isPermanent: true })
    });
    const data = await res.json();
    if (data.success && data.account) {
      accounts = accounts.filter(a => a.address !== data.account.address);
      accounts.unshift(data.account);
      persistAccounts(accounts);

      showToast(`تم إنشاء البريد الدائم: ${data.account.address} ♾️`);
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
    submitBtn.textContent = 'إنشاء وحفظ البريد في السحابة';
  }
});

// Submit Reclaim Form
reclaimForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const rawInput = inputReclaimAddress.value.trim();
  const domain = selectReclaimDomain.value || 'sharklasers.com';
  const note = inputReclaimNote.value.trim();

  if (!rawInput) {
    return showToast('يرجى إدخال اسم المستخدم أو البريد');
  }

  const submitBtn = document.getElementById('btn-submit-reclaim');
  submitBtn.disabled = true;
  submitBtn.textContent = 'جاري استرجاع وربط الحساب...';

  try {
    const res = await fetch('/api/accounts/reclaim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: rawInput, domain, note })
    });
    const data = await res.json();
    if (data.success && data.account) {
      accounts = accounts.filter(a => a.address !== data.account.address);
      accounts.unshift(data.account);
      persistAccounts(accounts);

      showToast(`تم استرجاع الحساب بنجاح: ${data.account.address} 🎉`);
      closeModal();
      renderAccounts();
      selectAccount(data.account.id);
    } else {
      showToast(data.error || 'فشل استرجاع الحساب');
    }
  } catch (err) {
    showToast('خطأ في الاتصال أثناء استرجاع الحساب');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '🔗 ربط واسترجاع الحساب الآن';
  }
});

// Top bar Actions
btnCopyEmail.addEventListener('click', () => {
  const acc = accounts.find(a => a.id === currentAccountId);
  if (acc) copyToClipboard(acc.address, 'تم نسخ الإيميل إلى الحافظة!');
});

btnRefresh.addEventListener('click', () => {
  loadMessages(false);
  showToast('تم فحص وتحديث الرسائل');
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

// Auto Refresh Polling (Every 5 seconds)
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
  showToast('تم تحميل نسخة الحسابات بنجاح 💾');
});

btnImport.addEventListener('click', () => {
  fileImport.click();
});

fileImport.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const imported = JSON.parse(event.target.result);
      if (Array.isArray(imported)) {
        let addedCount = 0;
        for (const item of imported) {
          if (item.address) {
            await fetch('/api/accounts/reclaim', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ address: item.address, note: item.note })
            }).catch(() => {});
            addedCount++;
          }
        }
        await loadAccounts();
        showToast(`تم استيراد ومزامنة ${addedCount} حساب مع السحابة! 🎉`);
      } else {
        showToast('ملف غير صالح');
      }
    } catch (err) {
      showToast('خطأ في قراءة ملف النسخة الاحتياطية');
    }
  };
  reader.readAsText(file);
});

// Init on Load
window.addEventListener('DOMContentLoaded', async () => {
  await loadAccounts();
  setupAutoRefresh();
});
