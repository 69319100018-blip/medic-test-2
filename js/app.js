// User records and permissions are hydrated from the authenticated API session.
const userProfiles = {};
let users = {};

const manualUrl = "https://docs.google.com/spreadsheets/d/1vGjzD5YZiiBs65yBodjtxsoUPQVr_EMMnfqRXWbOZrI/edit?gid=749978115#gid=749978115";
const rulesUrl = "https://sites.google.com/bic.ac.th/mediclightcity/%E0%B8%84%E0%B8%93%E0%B8%AA%E0%B8%A1%E0%B8%9A%E0%B8%95%E0%B8%82%E0%B8%AD%E0%B8%87%E0%B8%81%E0%B8%B2%E0%B8%A3%E0%B9%80%E0%B8%9B%E0%B8%99%E0%B9%81%E0%B8%9E%E0%B8%97%E0%B8%A2";

// ============================================================
// DATA LAYER — transient UI state; authenticated records are hydrated from the API
// ============================================================
let shiftLog = {};
let currentUser = null;
let historyViewUser = null;
let realtimeInterval = null;
let elapsedInterval = null;
let loginBgIndex = 0;
let loginBgInterval = null;
let centralFund = null;
let stockItems = [];
let stockOffline = true;
let stockWithdrawals = [];
let vehicles = [];
let vehicleOffline = true;
let doctors = [];
let doctorsOffline = true;
let currentDutyMembers = [];
let currentDutyLoading = false;
let currentDutyRefreshInterval = null;
let currentDutyElapsedInterval = null;


const SHIFT_LOCAL_KEY = 'medicShiftLog';
const FUND_LOCAL_KEY = 'medicCentralFund';
const STOCK_LOCAL_KEY = 'medicStockItems';
const STOCK_WITHDRAWALS_LOCAL_KEY = 'medicStockWithdrawals';
const VEHICLE_LOCAL_KEY = 'medicVehicles';
const DOCTORS_LOCAL_KEY = 'medicDoctors';

// Cancel superseded panel animations when users switch menus quickly.
const activePanelAnimations = new WeakMap();

function getDefaultFundState() {
    return {
        balance: 70000,
        allocations: {
            cash: 40000,
            deposit: 20000,
            reserve: 10000
        },
        totals: { income: 0, expense: 0 },
        history: []
    };
}

function thaiNow() {
    const now = new Date();
    return {
        now,
        date: now.toLocaleDateString('th-TH'),
        time: now.toLocaleTimeString('th-TH', { hour12: false }),
        iso: now.toISOString()
    };
}

function calcDuration(checkinDatetime, now) {
    let totalSec = Math.max(0, Math.floor((now - new Date(checkinDatetime)) / 1000));
    const hours = Math.floor(totalSec / 3600);
    totalSec %= 3600;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours} ชม.`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes} นาที`);
    parts.push(`${seconds} วินาที`);
    return parts.join(' ');
}

function loadJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (e) {
        return fallback;
    }
}

function saveJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function loadAllData() {
    shiftLog = loadJSON(SHIFT_LOCAL_KEY, {});
    centralFund = loadJSON(FUND_LOCAL_KEY, getDefaultFundState());
    if (!centralFund || typeof centralFund !== 'object') centralFund = getDefaultFundState();
    if (!centralFund.allocations) centralFund.allocations = getDefaultFundState().allocations;
    if (!Array.isArray(centralFund.history)) centralFund.history = [];
}

function saveShiftLog() {
    saveJSON(SHIFT_LOCAL_KEY, shiftLog);
}

function saveFund() {
    saveJSON(FUND_LOCAL_KEY, centralFund);
}

function loadStockData() {
    stockItems = loadJSON(STOCK_LOCAL_KEY, []);
    if (!Array.isArray(stockItems)) stockItems = [];
    stockOffline = true;
}

function saveStockLocal() {
    saveJSON(STOCK_LOCAL_KEY, stockItems);
}

function loadVehicleData() {
    vehicles = loadJSON(VEHICLE_LOCAL_KEY, []);
    if (!Array.isArray(vehicles)) vehicles = [];
    vehicleOffline = true;
}

function saveVehicleLocal() {
    saveJSON(VEHICLE_LOCAL_KEY, vehicles);
}

function loadDoctorsData() {
    // รายชื่อแพทย์อิงจาก userProfiles (Neon users) เท่านั้น
    syncDoctorsFromUsers();
}

function saveDoctorsLocal() {
    saveJSON(DOCTORS_LOCAL_KEY, doctors);
}

async function loadStockWithdrawals() {
    if (!canViewMonitoring(currentUser)) {
        stockWithdrawals = [];
        return stockWithdrawals;
    }
    if (typeof apiLoadStockWithdrawals !== 'function') {
        throw new Error('ไม่พบ API สำหรับโหลดประวัติสต็อก');
    }
    const rows = await apiLoadStockWithdrawals();
    stockWithdrawals = Array.isArray(rows) ? rows : [];
    return stockWithdrawals;
}

function saveStockWithdrawalsLocal() {
    saveJSON(STOCK_WITHDRAWALS_LOCAL_KEY, stockWithdrawals);
}

function renderStockWithdrawals() {
    const list = document.getElementById('stockHistoryList');
    if (!list) return;

    const entries = Array.isArray(stockWithdrawals) ? stockWithdrawals : [];
    const summary = document.getElementById('stockHistorySummary');
    if (summary) summary.textContent = `ทั้งหมด ${entries.length.toLocaleString('th-TH')} รายการ`;

    if (!entries.length) {
        list.innerHTML = '<div class="fund-history-empty">ยังไม่มีประวัติการเบิกหรือเติมสต็อก</div>';
        return;
    }

    list.innerHTML = entries.map((entry) => {
        const isAdd = entry.isAdd === true;
        const action = isAdd ? 'เติมสต็อก' : 'เบิก/ใช้สต็อก';
        const actor = userProfiles[entry.username]?.name || entry.username || 'ไม่ระบุ';
        const requester = entry.requester || (isAdd ? '-' : 'ไม่ระบุ');
        const quantity = Number(entry.quantity) || 0;
        const price = Number(entry.price) || 0;
        const priceLabel = price > 0 ? ` • ราคา/ชิ้น ${price.toLocaleString('th-TH')} บาท` : '';
        return `
            <div class="fund-history-item">
                <div>
                    <strong>${action} · ${escapeHtml(entry.stockName || 'รายการสต็อก')}</strong>
                    <span>ผู้ทำรายการ: ${escapeHtml(actor)} · ผู้เบิก: ${escapeHtml(requester)}</span>
                </div>
                <div class="fund-history-meta">
                    <strong>${isAdd ? '+' : '−'}${quantity.toLocaleString('th-TH')} ชิ้น</strong>
                    <span>${escapeHtml(entry.date || '-')} ${escapeHtml(entry.time || '-')}${priceLabel}</span>
                </div>
            </div>
        `;
    }).join('');
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function refreshShiftViews() {
    renderProfile();
    renderLog();
    renderTeamStatus();
    renderForceOut();
    updateActionButtons();
    if (typeof loadCurrentDuty === 'function') loadCurrentDuty();
}

/* ==========================================================================
   CURRENT ON-DUTY TEAM — overview-only live status
   ========================================================================== */
function formatCurrentDutyElapsed(checkInAt) {
    const timestamp = new Date(checkInAt).getTime();
    if (!Number.isFinite(timestamp)) return 'กำลังปฏิบัติหน้าที่';
    const total = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return `เข้าเวรแล้ว ${hours} ชม. ${minutes} นาที`;
    if (minutes > 0) return `เข้าเวรแล้ว ${minutes} นาที`;
    return `เข้าเวรแล้ว ${seconds} วินาที`;
}

function renderCurrentDuty() {
    const list = document.getElementById('currentDutyList');
    const count = document.getElementById('currentDutyCount');
    const updated = document.getElementById('currentDutyUpdated');
    if (!list) return;

    const members = Array.isArray(currentDutyMembers) ? currentDutyMembers : [];
    if (count) count.textContent = `${members.length.toLocaleString('th-TH')} คน`;

    if (!members.length) {
        list.innerHTML = `
            <div class="current-duty-empty">
                <i class="bi bi-person-check"></i>
                <strong>ขณะนี้ยังไม่มีผู้เข้าเวร</strong>
                <span>รายชื่อจะแสดงที่นี่เมื่อมีสมาชิกกดเข้าเวร</span>
            </div>`;
    } else {
        list.innerHTML = members.map((member) => {
            const profile = userProfiles[member.username] || {};
            const avatar = member.avatar || profile.avatar || '';
            const avatarMarkup = avatar
                ? `<img class="current-duty-avatar" src="${escapeHtml(avatar)}" alt="" loading="lazy">`
                : `<span class="current-duty-avatar current-duty-initial">${escapeHtml(String(member.name || member.username || '?').trim().slice(0, 1))}</span>`;
            const checkInTime = member.checkInTime || (member.checkInAt
                ? new Date(member.checkInAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' })
                : '--:--');
            return `
                <article class="current-duty-card">
                    <div class="current-duty-person">
                        ${avatarMarkup}
                        <div class="current-duty-person-info">
                            <strong>${escapeHtml(member.name || profile.name || member.username)}</strong>
                            <span>${escapeHtml(member.role || profile.role || 'ไม่ระบุตำแหน่ง')}</span>
                        </div>
                    </div>
                    <div class="current-duty-meta">
                        <span class="current-duty-start"><i class="bi bi-clock"></i> เข้าเวร ${escapeHtml(checkInTime)}</span>
                        <span class="current-duty-elapsed" data-duty-start="${escapeHtml(member.checkInAt || '')}">${formatCurrentDutyElapsed(member.checkInAt)}</span>
                    </div>
                </article>`;
        }).join('');
    }

    if (updated) updated.textContent = `อัปเดต ${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`;
}

async function loadCurrentDuty() {
    if (currentDutyLoading || typeof apiLoadCurrentDuty !== 'function') return;
    const list = document.getElementById('currentDutyList');
    if (!list) return;
    currentDutyLoading = true;
    try {
        const result = await apiLoadCurrentDuty();
        currentDutyMembers = Array.isArray(result) ? result : [];
        renderCurrentDuty();
    } catch (err) {
        if (!currentDutyMembers.length) {
            list.innerHTML = `
                <div class="current-duty-empty is-error">
                    <i class="bi bi-cloud-slash"></i>
                    <strong>โหลดสถานะผู้เข้าเวรไม่สำเร็จ</strong>
                    <span>${escapeHtml(err.message || 'กรุณาลองรีเฟรชอีกครั้ง')}</span>
                </div>`;
        }
    } finally {
        currentDutyLoading = false;
    }
}

function initCurrentDutyPanel() {
    if (!document.getElementById('currentDutyPanel')) return;
    loadCurrentDuty();
    if (currentDutyRefreshInterval) clearInterval(currentDutyRefreshInterval);
    if (currentDutyElapsedInterval) clearInterval(currentDutyElapsedInterval);
    currentDutyRefreshInterval = setInterval(loadCurrentDuty, 30000);
    currentDutyElapsedInterval = setInterval(() => {
        document.querySelectorAll('#currentDutyList [data-duty-start]').forEach((node) => {
            node.textContent = formatCurrentDutyElapsed(node.dataset.dutyStart);
        });
    }, 60000);
    document.getElementById('btnCurrentDutyRefresh')?.addEventListener('click', loadCurrentDuty);
}

/* ---------- Login video background + mouse focus ---------- */
const loginVideoPlaylist = [
    'assets/videos/bg1-h264.mp4',
    'assets/videos/bg3-h264.mp4',
    'assets/videos/bg3.mp4'  // ใช้คลิปที่มีอยู่จริงใน repo สำหรับรายการที่ 3
];

function formatElapsed(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function nowTime() {
    return new Date().toLocaleTimeString('th-TH', { hour12: false });
}

function todayDate() {
    return new Date().toLocaleDateString('th-TH');
}

function getTodayLogs(username) {
    const logs = shiftLog[username] || [];
    return logs.filter((item) => {
        const logDate = new Date(item.datetime || item.date);
        return logDate.toLocaleDateString('th-TH') === todayDate();
    });
}

function getOpenCheckIn(username) {
    return getTodayLogs(username).slice().reverse().find((log) => log.type === 'เข้าเวร' && !log.duration);
}


function renderHistoryControls() {
    const historySection = document.getElementById('historySection');
    if (!historySection) return;
    const existing = document.getElementById('historySelectorContainer');
    if (existing) existing.remove();
    if (!canViewMonitoring(currentUser)) {
        historyViewUser = currentUser;
        return;
    }
    const container = document.createElement('div');
    container.id = 'historySelectorContainer';
    container.className = 'history-filter';
    container.innerHTML = `
        <label for="historySelect">เลือกผู้ใช้งานเพื่อดูประวัติ</label>
        <select id="historySelect"></select>
        <span class="history-highlight">กำลังดู: <strong id="historyLabel"></strong></span>
    `;
    historySection.insertBefore(container, historySection.querySelector('.panel-header').nextSibling);
    const select = container.querySelector('select');
    const label = container.querySelector('#historyLabel');
    Object.keys(users).forEach((username) => {
        const profile = userProfiles[username];
        if (!profile) return;
        const option = document.createElement('option');
        option.value = username;
        option.textContent = `${profile.name} • ${profile.role}`;
        select.appendChild(option);
    });
    historyViewUser = historyViewUser || currentUser;
    select.value = historyViewUser;
    label.textContent = userProfiles[historyViewUser]?.name || 'ไม่ระบุ';
    select.addEventListener('change', (event) => {
        historyViewUser = event.target.value;
        label.textContent = userProfiles[historyViewUser]?.name || 'ไม่ระบุ';
        renderLog();
    });
}

function getHistoryTarget() {
    return historyViewUser || currentUser;
}

function updateCurrentTime() {
    const currentTime = document.getElementById('currentTime');
    if (currentTime) currentTime.textContent = nowTime();
}

function startClock() {
    if (elapsedInterval) clearInterval(elapsedInterval);
    updateCurrentTime();
    elapsedInterval = setInterval(updateCurrentTime, 1000);
}

function canViewMonitoring(username) {
    return userProfiles[username]?.canViewMonitoring === true;
}

function isAdmin(username) {
    return userProfiles[username]?.isAdmin === true;
}

function canManageStock(username) {
    const profile = userProfiles[username];
    if (!profile) return false;
    // เฉพาะแอดมิน และ ผู้อำนวยการ (ไม่ใช่รองผอ.) เท่านั้นที่จัดการสต็อกได้
    if (profile.isAdmin) return true;
    const role = (profile.role || '').toLowerCase();
    return role.includes('ผู้อำนวยการ') && !role.includes('รอง');
}

function canManageDoctors(username) {
    // เฉพาะแอดมิน และ ผอ. (ไม่ใช่รอง) เท่านั้นที่เพิ่ม/ลบรายชื่อแพทย์ได้
    return canManageStock(username);
}

const Toast = window.Swal ? Swal.mixin({
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    timer: 2200,
    timerProgressBar: true,
    showClass: { popup: 'toast-in' },
    hideClass: { popup: 'toast-out' },
    didOpen: (toast) => {
        toast.addEventListener('mouseenter', Swal.stopTimer);
        toast.addEventListener('mouseleave', Swal.resumeTimer);
    }
}) : null;

function showAlert(title, text, icon = 'info') {
    if (window.Swal) {
        if (icon === 'success' && Toast) {
            Toast.fire({ icon, title, text });
            return;
        }
        Swal.fire({
            title,
            text,
            icon,
            confirmButtonText: 'ตกลง',
            confirmButtonColor: '#2563eb',
            showClass: { popup: 'pop-in' },
            hideClass: { popup: 'pop-out' }
        });
        return;
    }
    alert(`${title}\n${text}`);
}

function updateActionButtons() {
    const btnIn = document.getElementById('btnCheckIn');
    const btnOut = document.getElementById('btnCheckOut');
    const status = getOpenCheckIn(currentUser);
    if (!btnIn || !btnOut) return;
    btnIn.disabled = Boolean(status);
    btnOut.disabled = !Boolean(status);
    btnIn.classList.toggle('cta-glow', !btnIn.disabled);
    btnOut.classList.toggle('cta-glow', !btnOut.disabled);
}

function renderCentralFund() {
    const balanceSummary = document.getElementById('fundBalanceSummary');
    const chart = document.getElementById('fundChart');
    const legend = document.getElementById('fundChartLegend');
    const totalValue = document.getElementById('fundTotalValue');
    const summaryList = document.getElementById('fundSummaryList');
    const historyList = document.getElementById('fundHistoryList');
    if (!balanceSummary || !chart || !legend || !totalValue || !summaryList || !historyList) return;

    const items = [
        { label: 'เงินสด', value: Number(centralFund.allocations?.cash) || 0, color: '#2563eb' },
        { label: 'เงินฝาก', value: Number(centralFund.allocations?.deposit) || 0, color: '#16a34a' },
        { label: 'สำรอง', value: Number(centralFund.allocations?.reserve) || 0, color: '#f59e0b' }
    ];
    const total = items.reduce((sum, item) => sum + item.value, 0);
    const maxValue = Math.max(...items.map((item) => item.value), 1);

    animateMoneyText(balanceSummary, centralFund.balance, (v) => `ยอดรวม ${v.toLocaleString('th-TH')} บาท`);
    animateMoneyText(totalValue, centralFund.balance, (v) => `${v.toLocaleString('th-TH')} บาท`);

    const incomeEl = document.getElementById('fundIncomeTotal');
    const expenseEl = document.getElementById('fundExpenseTotal');
    const income = Number(centralFund.totals?.income) || 0;
    const expense = Number(centralFund.totals?.expense) || 0;
    if (incomeEl) animateMoneyText(incomeEl, income, (v) => `${v.toLocaleString('th-TH')} บาท`);
    if (expenseEl) animateMoneyText(expenseEl, expense, (v) => `${v.toLocaleString('th-TH')} บาท`);

    chart.classList.remove('bump');
    void chart.offsetWidth;
    chart.classList.add('bump');
    setTimeout(() => chart.classList.remove('bump'), 600);

    // แผนภูมิแท่ง — ความสูงเทียบกับยอดสูงสุด เห็นสัดส่วนแต่ละประเภทชัดเจน
    chart.innerHTML = items.map((item) => {
        const heightPct = item.value > 0 ? Math.max(4, Math.round((item.value / maxValue) * 100)) : 0;
        return `
        <div class="fund-bar-col">
            <span class="fund-bar-value">${item.value.toLocaleString('th-TH')}</span>
            <div class="fund-bar-track">
                <div class="fund-bar-fill" style="height:${heightPct}%; background:linear-gradient(180deg, ${item.color}, ${item.color}99);"></div>
            </div>
            <span class="fund-bar-label">${item.label}</span>
        </div>`;
    }).join('');

    legend.innerHTML = items.map((item) => `
        <div class="fund-legend-item">
            <span class="fund-dot" style="background:${item.color}"></span>
            <div>
                <strong>${item.label}</strong>
                <small>${item.value.toLocaleString('th-TH')} บาท</small>
            </div>
        </div>
    `).join('');

    summaryList.innerHTML = items.map((item) => `
        <div class="fund-summary-row">
            <span>${item.label}</span>
            <strong>${item.value.toLocaleString('th-TH')} บาท</strong>
        </div>
    `).join('');

    if (!centralFund.history.length) {
        historyList.innerHTML = '<div class="fund-history-empty">ยังไม่มีรายการฝาก/ถอน</div>';
        return;
    }

    historyList.innerHTML = centralFund.history.slice(0, 6).map((entry) => `
        <div class="fund-history-item">
            <div>
                <strong>${entry.type}</strong>
                <span>${entry.username ? `${userProfiles[entry.username]?.name || entry.username} • ` : ''}${entry.note || 'ไม่มีหมายเหตุ'}</span>
            </div>
            <div class="fund-history-meta">
                <strong>${Number(entry.amount).toLocaleString('th-TH')} บาท</strong>
                <span>${entry.date} ${entry.time}</span>
            </div>
        </div>
    `).join('');
}

// ฝาก/ถอนเงินกองกลาง — บันทึกลงฐานข้อมูลกลาง ทุกคนเห็นอัพเดท
async function handleFundTransaction(type) {
    const amountInput = document.getElementById('fundAmountInput');
    const noteInput = document.getElementById('fundNoteInput');
    const amount = Number(amountInput?.value);
    if (!amountInput || !Number.isFinite(amount) || amount <= 0) {
        showAlert('ข้อมูลไม่ถูกต้อง', 'กรุณากรอกจำนวนเงินที่มากกว่า 0', 'warning');
        return;
    }
    if (type === 'withdraw' && amount > centralFund.balance) {
        showAlert('ยอดเงินไม่เพียงพอ', 'จำนวนเงินถอนเกินยอดคงเหลือในกองกลาง', 'error');
        return;
    }

    const btn = document.getElementById(type === 'deposit' ? 'btnFundDeposit' : 'btnFundWithdraw');
    if (btn) btn.disabled = true;
    try {
        const t = thaiNow();
        const note = noteInput?.value.trim() || '';
        if (type === 'deposit') {
            centralFund.balance = (Number(centralFund.balance) || 0) + amount;
            centralFund.allocations.cash = (Number(centralFund.allocations.cash) || 0) + amount;
            centralFund.totals.income = (Number(centralFund.totals?.income) || 0) + amount;
        } else {
            centralFund.balance = (Number(centralFund.balance) || 0) - amount;
            centralFund.allocations.cash = Math.max(0, (Number(centralFund.allocations.cash) || 0) - amount);
            centralFund.totals.expense = (Number(centralFund.totals?.expense) || 0) + amount;
        }
        if (!Array.isArray(centralFund.history)) centralFund.history = [];
        centralFund.history.unshift({
            username: currentUser,
            type: type === 'deposit' ? 'ฝาก' : 'ถอน',
            amount,
            note,
            date: t.date,
            time: t.time
        });
        saveFund();
        renderCentralFund();
        amountInput.value = '';
        if (noteInput) noteInput.value = '';
        celebrate({ particleCount: 70, spread: 65, origin: { y: 0.6 }, colors: ['#fbbf24', '#f59e0b', '#22c55e'] });
        showAlert(`${type === 'deposit' ? 'ฝากเงิน' : 'ถอนเงิน'}สำเร็จ`, `จำนวน ${amount.toLocaleString('th-TH')} บาท เรียบร้อย`, 'success');
    } catch (err) {
        showAlert('ทำรายการไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// เพิ่มเงินฝาก/เงินสำรอง — เฉพาะแอดมิน/ผอ. เท่านั้น
async function handleFundAdminAdd(target) {
    if (!isAdmin(currentUser)) return;
    const amountInput = document.getElementById('fundAdminAmountInput');
    const noteInput = document.getElementById('fundAdminNoteInput');
    const amount = Number(amountInput?.value);
    if (!amountInput || !Number.isFinite(amount) || amount <= 0) {
        showAlert('ข้อมูลไม่ถูกต้อง', 'กรุณากรอกจำนวนเงินที่มากกว่า 0', 'warning');
        return;
    }

    const btn = document.getElementById(target === 'deposit' ? 'btnFundAddDeposit' : 'btnFundAddReserve');
    if (btn) btn.disabled = true;
    try {
        const t = thaiNow();
        const note = noteInput?.value.trim() || '';
        if (target === 'deposit') {
            centralFund.allocations.deposit = (Number(centralFund.allocations.deposit) || 0) + amount;
            centralFund.balance = (Number(centralFund.balance) || 0) + amount;
        } else {
            centralFund.allocations.reserve = (Number(centralFund.allocations.reserve) || 0) + amount;
            centralFund.balance = (Number(centralFund.balance) || 0) + amount;
        }
        if (!Array.isArray(centralFund.history)) centralFund.history = [];
        centralFund.history.unshift({
            username: currentUser,
            type: target === 'deposit' ? 'เพิ่มเงินฝาก' : 'เพิ่มเงินสำรอง',
            amount,
            note,
            date: t.date,
            time: t.time
        });
        saveFund();
        renderCentralFund();
        amountInput.value = '';
        if (noteInput) noteInput.value = '';
        celebrate({ particleCount: 70, spread: 65, origin: { y: 0.6 }, colors: ['#fbbf24', '#f59e0b', '#22c55e'] });
        showAlert('เพิ่มเงินสำเร็จ', `เพิ่ม${target === 'deposit' ? 'เงินฝาก' : 'เงินสำรอง'} ${amount.toLocaleString('th-TH')} บาท เรียบร้อย`, 'success');
    } catch (err) {
        showAlert('ทำรายการไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ============================================================
// STOCK — ระบบสต็อกอุปกรณ์
// สถานะคำนวณอัตโนมัติจาก จำนวนคงเหลือ เทียบกับ จำนวนขั้นต่ำ
// ============================================================
function getStockStatus(item) {
    // ถ้ามีการตั้งสถานะด้วยตนเอง (เฉพาะแอดมิน/ผอ./รองผอ.)
    const manual = item.manualStatus;
    if (manual && manual !== 'auto') {
        const map = {
            'ready':   { key: 'ok',      label: 'พร้อมใช้งาน', missing: 0 },
            'ordered': { key: 'ordered', label: 'สั่งซื้อแล้ว', missing: 0 },
            'waiting': { key: 'waiting', label: 'รอรับของ',    missing: 0 },
            'damaged': { key: 'damaged', label: 'ชำรุด',        missing: 0 }
        };
        if (map[manual]) return map[manual];
    }
    const qty = Number(item.quantity) || 0;
    const min = Number(item.minQuantity) || 0;
    const missing = Math.max(0, min - qty);
    if (qty <= 0) return { key: 'out', label: 'ขาดสต็อก', missing };
    if (qty < min) return { key: 'low', label: 'ใกล้หมด', missing };
    return { key: 'ok', label: 'พร้อมใช้งาน', missing: 0 };
}

function renderStock() {
    const list = document.getElementById('stockList');
    if (!list) return;
    const addedByLabel = document.getElementById('stockAddedByLabel');
    if (addedByLabel) addedByLabel.textContent = userProfiles[currentUser]?.name || currentUser || '-';

    const statuses = stockItems.map(getStockStatus);
    const lowCount = statuses.filter((s) => s.key === 'low').length;
    const outCount = statuses.filter((s) => s.key === 'out').length;
    const missingTotal = statuses.reduce((sum, s) => sum + s.missing, 0);

    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setText('stockStatTotal', stockItems.length);
    setText('stockStatLow', lowCount);
    setText('stockStatOut', outCount);
    setText('stockStatMissing', `${missingTotal.toLocaleString('th-TH')} ชิ้น`);
    setText('stockSummaryPill', `ทั้งหมด ${stockItems.length} รายการ • ขาด ${missingTotal.toLocaleString('th-TH')} ชิ้น`);

    if (!stockItems.length) {
        list.innerHTML = '<div class="log-item"><strong>ยังไม่มีรายการสต็อก</strong><span>เริ่มเพิ่มอุปกรณ์ชิ้นแรกจากฟอร์มด้านบน</span></div>';
        return;
    }

    const isManager = canManageStock(currentUser);
    list.innerHTML = stockItems.map((item, i) => {
        const s = statuses[i];
        const addedByName = userProfiles[item.addedBy]?.name || item.addedBy || 'ไม่ระบุ';
        return `
        <div class="stock-item">
            <div class="stock-item-head">
                <div>
                    <strong>${escapeHtml(item.name)}</strong>
                    ${isManager ? `<span class="stock-meta">👤 เพิ่มโดย ${escapeHtml(addedByName)}${item.date ? ` • ${item.date} ${item.time || ''}` : ''}</span>` : ''}
                </div>
                <span class="badge stock-${s.key}">${s.label}</span>
            </div>
            <div class="stock-item-body">
                <span>คงเหลือ <strong>${Number(item.quantity).toLocaleString('th-TH')}</strong> / ขั้นต่ำ ${Number(item.minQuantity).toLocaleString('th-TH')} ชิ้น</span>
                ${isManager ? `<span>แหล่งที่มา: ${escapeHtml(item.source || 'ไม่ระบุ')}</span>` : ''}
                ${s.missing > 0
                    ? `<span class="stock-missing">⚠️ ขาดอีก ${s.missing.toLocaleString('th-TH')} ชิ้น</span>`
                    : '<span class="stock-ok">✔ สต็อกเพียงพอ</span>'}
            </div>
            <div class="stock-item-actions">
                ${isManager ? `
                    <label class="stock-status-control">
                        <span class="stock-meta">สถานะ</span>
                        <select class="stock-status-select" data-id="${item.id}" aria-label="เปลี่ยนสถานะ ${escapeHtml(item.name)}">
                            <option value="auto" ${(item.manualStatus || 'auto') === 'auto' ? 'selected' : ''}>อัตโนมัติ</option>
                            <option value="ready" ${item.manualStatus === 'ready' ? 'selected' : ''}>พร้อมใช้งาน</option>
                            <option value="ordered" ${item.manualStatus === 'ordered' ? 'selected' : ''}>สั่งซื้อแล้ว</option>
                            <option value="waiting" ${item.manualStatus === 'waiting' ? 'selected' : ''}>รอรับของ</option>
                            <option value="damaged" ${item.manualStatus === 'damaged' ? 'selected' : ''}>ชำรุด</option>
                        </select>
                    </label>
                    <button class="btn btn-secondary btn-small stock-adjust" data-id="${item.id}" data-delta="1" type="button">＋ เติมสต็อก</button>
                ` : ''}
                <button class="btn btn-secondary btn-small stock-adjust" data-id="${item.id}" data-delta="-1" type="button" ${Number(item.quantity) <= 0 ? 'disabled' : ''}>− ใช้/เบิก</button>
                ${isManager ? `<button class="btn btn-danger btn-small stock-remove" data-id="${item.id}" type="button">ลบ</button>` : ''}
            </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.stock-adjust').forEach((btn) => {
        btn.addEventListener('click', () => promptAdjustStock(btn.dataset.id, Number(btn.dataset.delta)));
    });
    list.querySelectorAll('.stock-remove').forEach((btn) => {
        btn.addEventListener('click', () => confirmRemoveStock(btn.dataset.id));
    });
    list.querySelectorAll('.stock-status-select').forEach((sel) => {
        sel.addEventListener('change', (e) => handleStockStatusChange(e.target.dataset.id, e.target.value));
    });
    staggerChildren(list);
}

// เพิ่มสต็อก — บันทึกชื่อผู้เพิ่มจากบัญชีที่ล็อกอินอัตโนมัติ
async function handleAddStock() {
    const nameInput = document.getElementById('stockNameInput');
    const qtyInput = document.getElementById('stockQtyInput');
    const minInput = document.getElementById('stockMinInput');
    const sourceInput = document.getElementById('stockSourceInput');
    const name = nameInput?.value.trim();
    const quantity = Math.max(0, Math.floor(Number(qtyInput?.value) || 0));
    const minQuantity = Math.max(0, Math.floor(Number(minInput?.value) || 0));
    const source = sourceInput?.value.trim() || '';
    if (!name) {
        showAlert('ข้อมูลไม่ครบ', 'กรุณากรอกชื่ออุปกรณ์', 'warning');
        nameInput?.classList.add('input-error');
        setTimeout(() => nameInput?.classList.remove('input-error'), 700);
        return;
    }

    const btn = document.getElementById('btnAddStock');
    if (btn) btn.disabled = true;
    try {
        const now = new Date();
        stockItems.unshift({
            id: Date.now(),
            name,
            quantity,
            minQuantity,
            source: source || 'ไม่ระบุแหล่งที่มา',
            addedBy: currentUser,
            manualStatus: 'auto',
            date: now.toLocaleDateString('th-TH'),
            time: now.toLocaleTimeString('th-TH', { hour12: false })
        });
        saveStockLocal();
        renderStock();
        nameInput.value = '';
        qtyInput.value = '';
        minInput.value = '';
        sourceInput.value = '';
        celebrate({ particleCount: 70, spread: 65, origin: { y: 0.6 }, colors: ['#2563eb', '#22c55e', '#fbbf24'] });
        showAlert('เพิ่มสต็อกสำเร็จ', `${name} จำนวน ${quantity.toLocaleString('th-TH')} ชิ้น เรียบร้อย`, 'success');
    } catch (err) {
        showAlert('เพิ่มสต็อกไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// เติม/เบิกสต็อก — เติมถามแค่จำนวน / เบิกต้องระบุ "ผู้เบิก" + จำนวนเสมอ
async function promptAdjustStock(id, direction) {
    const item = stockItems.find((s) => String(s.id) === String(id));
    if (!item) return;
    const isAdd = direction > 0;
    let amount = 1;
    let requester = '';
    let price = 0;

    if (isAdd) {
        // เติมสต็อก — ถามแค่จำนวนเหมือนเดิม
        if (window.Swal) {
            const result = await Swal.fire({
                title: `เติมสต็อก "${item.name}"`,
                input: 'number',
                inputValue: 1,
                inputAttributes: { min: 1, step: 1 },
                showCancelButton: true,
                confirmButtonText: 'เติมสต็อก',
                cancelButtonText: 'ยกเลิก',
                confirmButtonColor: '#16a34a'
            });
            if (!result.isConfirmed) return;
            amount = Math.floor(Number(result.value));
        } else {
            const raw = prompt('จำนวนที่เติม (ชิ้น):', '1');
            if (raw === null) return;
            amount = Math.floor(Number(raw));
        }
    } else {
        // ใช้/เบิก — ต้องกรอกชื่อผู้เบิกด้วยเสมอ เพื่อให้แอดมิน/ผอ. ตรวจสอบย้อนหลังได้
        if (window.Swal) {
            const result = await Swal.fire({
                title: `ใช้/เบิก "${item.name}"`,
                html: `
                    <div style="text-align:left; display:grid; gap:10px;">
                        <label style="display:grid; gap:4px; font-size:14px;">
                            ชื่อผู้เบิก
                            <input id="swalRequesterInput" class="swal2-input" style="margin:0;" placeholder="ชื่อผู้เบิกอุปกรณ์" autocomplete="off">
                        </label>
                        <label style="display:grid; gap:4px; font-size:14px;">
                            จำนวนที่เบิก (ชิ้น)
                            <input id="swalAmountInput" type="number" class="swal2-input" style="margin:0;" min="1" step="1" value="1">
                        </label>
                        <label style="display:grid; gap:4px; font-size:14px;">
                            ราคาต่อชิ้น (บาท)
                            <input id="swalPriceInput" type="number" class="swal2-input" style="margin:0;" min="0" step="1" placeholder="ระบุราคาต่อชิ้น" value="0">
                        </label>
                    </div>`,
                showCancelButton: true,
                confirmButtonText: 'เบิกออก',
                cancelButtonText: 'ยกเลิก',
                confirmButtonColor: '#dc2626',
                focusConfirm: false,
                preConfirm: () => {
                    const requesterVal = document.getElementById('swalRequesterInput')?.value.trim();
                    const amountVal = Math.floor(Number(document.getElementById('swalAmountInput')?.value));
                    const priceVal = Math.floor(Number(document.getElementById('swalPriceInput')?.value)) || 0;
                    if (!requesterVal) {
                        Swal.showValidationMessage('กรุณากรอกชื่อผู้เบิก');
                        return false;
                    }
                    if (!Number.isFinite(amountVal) || amountVal <= 0) {
                        Swal.showValidationMessage('กรุณาระบุจำนวนมากกว่า 0');
                        return false;
                    }
                    if (priceVal < 0) {
                        Swal.showValidationMessage('ราคาต้องไม่ติดลบ');
                        return false;
                    }
                    return { requesterVal, amountVal, priceVal };
                }
            });
            if (!result.isConfirmed) return;
            requester = result.value.requesterVal;
            amount = result.value.amountVal;
            price = result.value.priceVal;
        } else {
            const nameRaw = prompt('ชื่อผู้เบิกอุปกรณ์:', '');
            if (nameRaw === null) return;
            requester = nameRaw.trim();
            if (!requester) {
                showAlert('ข้อมูลไม่ครบ', 'กรุณาระบุชื่อผู้เบิก', 'warning');
                return;
            }
            const raw = prompt('จำนวนที่เบิก (ชิ้น):', '1');
            if (raw === null) return;
            amount = Math.floor(Number(raw));
            const priceRaw = prompt('ราคาต่อชิ้น (บาท):', '0');
            if (priceRaw === null) return;
            price = Math.floor(Number(priceRaw)) || 0;
        }
    }

    if (!Number.isFinite(amount) || amount <= 0) {
        showAlert('จำนวนไม่ถูกต้อง', 'กรุณาระบุจำนวนมากกว่า 0', 'warning');
        return;
    }
    if (!isAdd && amount > Number(item.quantity)) {
        showAlert('สต็อกไม่พอ', `คงเหลือเพียง ${item.quantity} ชิ้น`, 'error');
        return;
    }
    const delta = isAdd ? amount : -amount;
    try {
        item.quantity = Math.max(0, Number(item.quantity) + delta);
        saveStockLocal();
        if (!isAdd) {
            const now = new Date();
            stockWithdrawals.unshift({
                itemId: item.id,
                itemName: item.name,
                requester,
                username: currentUser,
                quantity: amount,
                price,
                date: now.toLocaleDateString('th-TH'),
                time: now.toLocaleTimeString('th-TH', { hour12: false })
            });
            saveStockWithdrawalsLocal();
        }
        renderStock();
        if (!isAdd && canViewMonitoring(currentUser)) renderStockWithdrawals();
        showAlert(
            isAdd ? 'เติมสต็อกแล้ว' : 'เบิกอุปกรณ์แล้ว',
            isAdd ? `${item.name} +${amount} ชิ้น` : `${item.name} −${amount} ชิ้น • ผู้เบิก: ${escapeHtml(requester)}`,
            'success'
        );
    } catch (err) {
        showAlert('ทำรายการไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    }
}

async function handleStockStatusChange(id, newStatus) {
    const allowed = ['auto', 'ready', 'ordered', 'waiting', 'damaged'];
    const item = stockItems.find((s) => String(s.id) === String(id));
    if (!item || !allowed.includes(newStatus)) return;

    const selector = Array.from(document.querySelectorAll('.stock-status-select'))
        .find((element) => String(element.dataset.id) === String(id));
    if (selector) selector.disabled = true;
    try {
        if (typeof apiUpdateStock !== 'function') throw new Error('ไม่พบ API สำหรับบันทึกสถานะสต็อก');
        await apiUpdateStock(id, { manualStatus: newStatus });
        stockItems = await apiLoadStock();
        renderStock();
        const statusLabel = { auto: 'อัตโนมัติ', ready: 'พร้อมใช้งาน', ordered: 'สั่งซื้อแล้ว', waiting: 'รอรับของ', damaged: 'ชำรุด' };
        showAlert('อัปเดตสถานะแล้ว', `${escapeHtml(item.name)} → ${statusLabel[newStatus]}`, 'success');
    } catch (err) {
        try { stockItems = await apiLoadStock(); } catch (_) {}
        renderStock();
        showAlert('อัปเดตสถานะไม่สำเร็จ', err.message || 'กรุณาลองใหม่', 'error');
    }
}

async function confirmRemoveStock(id) {
    const item = stockItems.find((s) => String(s.id) === String(id));
    if (!item) return;
    let confirmed = true;
    if (window.Swal) {
        const result = await Swal.fire({
            title: 'ลบรายการนี้?',
            text: `"${item.name}" จะถูกลบออกจากสต็อก`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'ลบรายการ',
            cancelButtonText: 'ยกเลิก',
            confirmButtonColor: '#dc2626'
        });
        confirmed = result.isConfirmed;
    } else {
        confirmed = confirm(`ลบ "${item.name}" ออกจากสต็อก?`);
    }
    if (!confirmed) return;
    try {
        stockItems = stockItems.filter((s) => String(s.id) !== String(id));
        saveStockLocal();
        renderStock();
        showAlert('ลบรายการแล้ว', `${item.name} ถูกลบออกจากสต็อก`, 'success');
    } catch (err) {
        showAlert('ลบไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    }
}

// ============================================================
// VEHICLE — ระบบทะเบียนรถ
// ทุกคนเพิ่ม/ดูรถของตัวเองได้ แอดมิน/ผอ. ดูของทุกคนได้ในการ์ดแยก
// ============================================================
function vehicleItemHtml(v, { showOwner } = {}) {
    const ownerName = userProfiles[v.username]?.name || v.username || 'ไม่ระบุ';
    const canRemove = v.username === currentUser || isAdmin(currentUser);
    return `
        <div class="stock-item">
            <div class="stock-item-head">
                <div>
                    <strong>${escapeHtml((v.plate || '').toUpperCase())}</strong>
                    <span class="stock-meta">${escapeHtml(v.model)}${showOwner ? ` • เจ้าของ: ${escapeHtml(ownerName)}` : ''}${v.date ? ` • เพิ่มเมื่อ ${v.date} ${v.time || ''}` : ''}</span>
                </div>
            </div>
            ${canRemove ? `
            <div class="stock-item-actions">
                <button class="btn btn-danger btn-small vehicle-remove" data-id="${v.id}" type="button">ลบ</button>
            </div>` : ''}
        </div>`;
}

function renderVehicles() {
    const ownerLabel = document.getElementById('vehicleOwnerLabel');
    if (ownerLabel) ownerLabel.textContent = userProfiles[currentUser]?.name || currentUser || '-';

    const myVehicles = vehicles.filter((v) => v.username === currentUser);
    const summaryPill = document.getElementById('vehicleSummaryPill');
    if (summaryPill) summaryPill.textContent = `ทั้งหมด ${myVehicles.length} คัน`;

    const myList = document.getElementById('vehicleMyList');
    if (myList) {
        myList.innerHTML = myVehicles.length
            ? myVehicles.map((v) => vehicleItemHtml(v, { showOwner: false })).join('')
            : '<div class="log-item"><strong>ยังไม่มีรถของคุณ</strong><span>เพิ่มทะเบียนรถคันแรกจากฟอร์มด้านบน</span></div>';
        myList.querySelectorAll('.vehicle-remove').forEach((btn) => {
            btn.addEventListener('click', () => confirmRemoveVehicle(btn.dataset.id));
        });
    }

    const adminWrap = document.getElementById('vehicleAdminWrap');
    const allList = document.getElementById('vehicleAllList');
    if (adminWrap && allList) {
        const canSeeAll = canViewMonitoring(currentUser) || isAdmin(currentUser);
        adminWrap.classList.toggle('hidden', !canSeeAll);
        if (canSeeAll) {
            allList.innerHTML = vehicles.length
                ? vehicles.map((v) => vehicleItemHtml(v, { showOwner: true })).join('')
                : '<div class="log-item"><strong>ยังไม่มีรถในระบบ</strong><span>ยังไม่มีใครเพิ่มทะเบียนรถ</span></div>';
            allList.querySelectorAll('.vehicle-remove').forEach((btn) => {
                btn.addEventListener('click', () => confirmRemoveVehicle(btn.dataset.id));
            });
        }
    }
    staggerChildren(myList);
}

// เพิ่มทะเบียนรถ — ผูกกับบัญชีที่ล็อกอินอัตโนมัติ
async function handleAddVehicle() {
    const plateInput = document.getElementById('vehiclePlateInput');
    const modelInput = document.getElementById('vehicleModelInput');
    const plate = plateInput?.value.trim();
    const model = modelInput?.value.trim();
    if (!plate || !model) {
        showAlert('ข้อมูลไม่ครบ', 'กรุณากรอกเลขทะเบียนและรุ่นรถให้ครบ', 'warning');
        if (!plate) { plateInput?.classList.add('input-error'); setTimeout(() => plateInput?.classList.remove('input-error'), 700); }
        if (!model) { modelInput?.classList.add('input-error'); setTimeout(() => modelInput?.classList.remove('input-error'), 700); }
        return;
    }

    const btn = document.getElementById('btnAddVehicle');
    if (btn) btn.disabled = true;
    try {
        const now = new Date();
        vehicles.unshift({
            id: Date.now(),
            username: currentUser,
            plate,
            model,
            date: now.toLocaleDateString('th-TH'),
            time: now.toLocaleTimeString('th-TH', { hour12: false })
        });
        saveVehicleLocal();
        renderVehicles();
        plateInput.value = '';
        modelInput.value = '';
        celebrate({ particleCount: 70, spread: 65, origin: { y: 0.6 }, colors: ['#2563eb', '#16a34a', '#fbbf24'] });
        showAlert('เพิ่มรถสำเร็จ', `${plate.toUpperCase()} • ${model}`, 'success');
    } catch (err) {
        showAlert('เพิ่มรถไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function confirmRemoveVehicle(id) {
    const item = vehicles.find((v) => String(v.id) === String(id));
    if (!item) return;
    if (item.username !== currentUser && !isAdmin(currentUser)) {
        showAlert('ไม่มีสิทธิ์', 'ลบได้เฉพาะรถของตัวเอง หรือแอดมิน/ผอ. เท่านั้น', 'warning');
        return;
    }
    let confirmed = true;
    if (window.Swal) {
        const result = await Swal.fire({
            title: 'ลบรายการนี้?',
            text: `"${item.plate.toUpperCase()}" จะถูกลบออกจากทะเบียนรถ`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'ลบรายการ',
            cancelButtonText: 'ยกเลิก',
            confirmButtonColor: '#dc2626'
        });
        confirmed = result.isConfirmed;
    } else {
        confirmed = confirm(`ลบ "${item.plate.toUpperCase()}" ออกจากทะเบียนรถ?`);
    }
    if (!confirmed) return;
    try {
        vehicles = vehicles.filter((v) => String(v.id) !== String(id));
        saveVehicleLocal();
        renderVehicles();
        showAlert('ลบรายการแล้ว', `${item.plate.toUpperCase()} ถูกลบออกจากทะเบียนรถ`, 'success');
    } catch (err) {
        showAlert('ลบไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    }
}

// ============================================================
// DOCTORS — แสดงรายชื่อจาก users ใน Neon เท่านั้น (อ่านอย่างเดียว)
// จัดกลุ่ม/เรียงตามลำดับตำแหน่งแบบหน้าเว็บ MEDIC LIGHT CITY (รายชื่อแพทย์)
// https://sites.google.com/bic.ac.th/mediclightcity/รายชื่อแพทย์
// ============================================================
// ลำดับตำแหน่ง + ปลอกแขน ตามเว็บไซต์ทางการ
const ROLE_HIERARCHY = [
    { rank: 1, keys: ['แอดมินแพทย์', 'แอดมิน', 'admin'],           label: 'แอดมินแพทย์',           armband: null,        armbandLabel: null },
    { rank: 2, keys: ['ผู้อำนวยการแพทย์', 'ผู้อำนวยการ'],         label: 'ผู้อำนวยการแพทย์',     armband: 'rainbow',  armbandLabel: 'ปลอกแขนสี รุ้ง' },
    { rank: 3, keys: ['รองผู้อำนวยการแพทย์', 'รอง.ผู้อำนวยการ', 'รองผู้อำนวยการ', 'รอง.ผอ', 'รองผอ'], label: 'รองผู้อำนวยการแพทย์', armband: 'rainbow', armbandLabel: 'ปลอกแขนสี รุ้ง' },
    { rank: 4, keys: ['ส่วนกลาง'],                               label: 'ส่วนกลาง',             armband: 'black',    armbandLabel: 'ปลอกแขนสี ดำ' },
    { rank: 5, keys: ['แพทย์ชำนาญการ', 'ชำนาญการ'],               label: 'แพทย์ชำนาญการ',       armband: 'white',    armbandLabel: 'ปลอกแขนสี ขาว' },
    { rank: 6, keys: ['แพทย์', 'หมอ', 'doctor'],                  label: 'แพทย์',                 armband: 'red',      armbandLabel: 'ปลอกแขนสี แดง' },
    { rank: 7, keys: ['นักเรียนแพทย์', 'นักเรียน'],               label: 'นักเรียนแพทย์',       armband: 'blue',     armbandLabel: 'ปลอกแขนสี ฟ้า' },
    { rank: 8, keys: ['พยาบาล', 'nurse'],                         label: 'พยาบาล',               armband: null,        armbandLabel: null },
    { rank: 9, keys: ['ผู้ช่วย', 'assistant'],                    label: 'ผู้ช่วย',               armband: null,        armbandLabel: null }
];

function normalizeRoleText(role) {
    return String(role || '').toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
}

function getRoleMeta(role) {
    const raw = String(role || '').trim();
    const n = normalizeRoleText(raw);
    // ตรวจจากเฉพาะเจาะจง → กว้าง (เรียง keys ยาวก่อนภายในแต่ละ rank อยู่แล้ว)
    for (const entry of ROLE_HIERARCHY) {
        for (const key of entry.keys) {
            const nk = normalizeRoleText(key);
            if (!nk) continue;
            // แอดมิน / ส่วนกลาง / ชำนาญการ / นักเรียน — match ตรงๆ
            if (entry.rank === 1 || entry.rank === 4 || entry.rank === 5 || entry.rank === 7) {
                if (n.includes(nk) || nk.includes(n)) return entry;
            }
            // ผู้อำนวยการ (ไม่ใช่รอง)
            if (entry.rank === 2) {
                if (n.includes('ผู้อำนวยการ') && !n.includes('รอง')) return entry;
            }
            // รองผู้อำนวยการ
            if (entry.rank === 3) {
                if (n.includes('รอง') && (n.includes('ผู้อำนวยการ') || n.includes('ผอ'))) return entry;
            }
            // แพทย์ ทั่วไป — ต้องไม่ใช่ตำแหน่งอื่นที่มีคำว่าแพทย์
            if (entry.rank === 6) {
                if ((n.includes('แพทย์') || n.includes('หมอ') || n === 'doctor') &&
                    !n.includes('แอดมิน') && !n.includes('ผู้อำนวยการ') && !n.includes('ชำนาญ') &&
                    !n.includes('นักเรียน') && !n.includes('ส่วนกลาง')) {
                    return entry;
                }
            }
            if (entry.rank >= 8 && n.includes(nk)) return entry;
        }
    }
    return { rank: 90, keys: [], label: raw || 'อื่นๆ', armband: null, armbandLabel: null };
}

function getRoleRank(role) {
    return getRoleMeta(role).rank;
}

function armbandDotHtml(armband) {
    if (!armband) return '';
    const colors = {
        rainbow: 'linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#c77dff)',
        black: '#1a1a1a',
        white: '#f5f5f5',
        red: '#e53935',
        blue: '#42a5f5'
    };
    const bg = colors[armband] || '#888';
    const border = armband === 'white' ? '1px solid rgba(0,0,0,0.25)' : '1px solid rgba(255,255,255,0.2)';
    return `<span class="armband-dot" title="${armband}" style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${bg};border:${border};vertical-align:middle;margin-right:6px;"></span>`;
}

function syncDoctorsFromUsers() {
    const profiles = (typeof userProfiles === 'object' && userProfiles) ? userProfiles : {};
    doctors = Object.entries(profiles).map(([username, u], i) => {
        const onDuty = typeof getOpenCheckIn === 'function' ? Boolean(getOpenCheckIn(username)) : false;
        const meta = getRoleMeta(u?.role);
        return {
            id: username || i,
            name: u?.name || username,
            role: u?.role || '-',
            note: u?.desc || '',
            username,
            onDuty,
            roleRank: meta.rank,
            roleLabel: meta.label,
            armband: meta.armband,
            armbandLabel: meta.armbandLabel
        };
    }).sort((a, b) => {
        // 1) ตำแหน่งตามลำดับเว็บไซต์
        if (a.roleRank !== b.roleRank) return a.roleRank - b.roleRank;
        // 2) สถานะเข้าเวร (อยู่ในเวรก่อน)
        if (a.onDuty !== b.onDuty) return a.onDuty ? -1 : 1;
        // 3) ชื่อ
        return String(a.name).localeCompare(String(b.name), 'th');
    });
}

function doctorItemHtml(d) {
    const statusBadge = d.onDuty
        ? '<span class="badge in" style="margin-left:8px;font-size:0.75rem;">เข้าแล้ว</span>'
        : '<span class="badge out" style="margin-left:8px;font-size:0.75rem;">ยังไม่เข้า</span>';
    return `
        <div class="stock-item member-card" style="padding:14px;">
            <div class="stock-item-head">
                <div>
                    <strong>${escapeHtml(d.name)}</strong>${statusBadge}
                    <span class="stock-meta">${escapeHtml(d.role || '-')}${d.username ? ` • ${escapeHtml(d.username)}` : ''}${d.note ? ` • ${escapeHtml(d.note)}` : ''}</span>
                </div>
            </div>
        </div>`;
}

function renderDoctors() {
    syncDoctorsFromUsers();
    const summaryPill = document.getElementById('doctorsSummaryPill');
    if (summaryPill) {
        const onDutyCount = doctors.filter((d) => d.onDuty).length;
        summaryPill.textContent = `ทั้งหมด ${doctors.length} คน · เข้าเวร ${onDutyCount}`;
    }

    const formWrap = document.getElementById('doctorsAddFormWrap');
    if (formWrap) formWrap.classList.add('hidden');

    const list = document.getElementById('doctorsList');
    if (list) {
        if (!doctors.length) {
            list.innerHTML = '<div class="log-item"><strong>ยังไม่มีสมาชิกในระบบ</strong><span>เมื่อมีคนสมัครหรือมีบัญชีใน Neon จะแสดงที่นี่</span></div>';
        } else {
            // จัดกลุ่มตามลำดับตำแหน่งแบบเว็บไซต์ (ใช้ roleLabel + rank)
            const groups = [];
            let currentKey = null;
            let currentGroup = null;
            doctors.forEach((d) => {
                const key = `${d.roleRank}|${d.roleLabel}`;
                if (key !== currentKey) {
                    currentKey = key;
                    currentGroup = {
                        label: d.roleLabel,
                        armband: d.armband,
                        armbandLabel: d.armbandLabel,
                        items: []
                    };
                    groups.push(currentGroup);
                }
                currentGroup.items.push(d);
            });
            list.innerHTML = groups.map((g) => {
                const band = g.armbandLabel
                    ? `<span style="opacity:0.85;font-weight:500;"> · ${armbandDotHtml(g.armband)}${escapeHtml(g.armbandLabel)}</span>`
                    : '';
                return `
                <div class="doctors-group" style="margin-bottom:18px;">
                    <div class="doctors-group-title" style="font-size:0.95rem;font-weight:700;margin:10px 0 8px;padding:6px 10px;border-radius:8px;background:rgba(255,255,255,0.06);border-left:3px solid rgba(77,150,255,0.7);">
                        ${escapeHtml(g.label)}${band}
                        <span style="opacity:0.65;font-weight:500;font-size:0.8rem;margin-left:6px;">(${g.items.length} คน)</span>
                    </div>
                    ${g.items.map((d) => doctorItemHtml(d)).join('')}
                </div>`;
            }).join('');
        }
        staggerChildren(list);
    }
}

async function handleAddDoctor() {
    if (!canManageDoctors(currentUser)) {
        showAlert('ไม่มีสิทธิ์', 'เฉพาะแอดมินและผู้อำนวยการเท่านั้นที่เพิ่มรายชื่อแพทย์ได้', 'warning');
        return;
    }
    const nameInput = document.getElementById('doctorNameInput');
    const roleInput = document.getElementById('doctorRoleInput');
    const noteInput = document.getElementById('doctorNoteInput');
    const name = nameInput?.value.trim();
    const role = roleInput?.value.trim() || '';
    const note = noteInput?.value.trim() || '';
    if (!name) {
        showAlert('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อแพทย์', 'warning');
        nameInput?.classList.add('input-error');
        setTimeout(() => nameInput?.classList.remove('input-error'), 700);
        return;
    }

    const btn = document.getElementById('btnAddDoctor');
    if (btn) btn.disabled = true;
    try {
        const now = new Date();
        doctors.unshift({
            id: Date.now(),
            name,
            role,
            note,
            addedBy: currentUser,
            date: now.toLocaleDateString('th-TH'),
            time: now.toLocaleTimeString('th-TH', { hour12: false })
        });
        saveDoctorsLocal();
        renderDoctors();
        if (nameInput) nameInput.value = '';
        if (roleInput) roleInput.value = '';
        if (noteInput) noteInput.value = '';
        celebrate({ particleCount: 70, spread: 65, origin: { y: 0.6 }, colors: ['#2563eb', '#16a34a', '#a78bfa'] });
        showAlert('เพิ่มรายชื่อสำเร็จ', name, 'success');
    } catch (err) {
        showAlert('เพิ่มรายชื่อไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function confirmRemoveDoctor(id) {
    if (!canManageDoctors(currentUser)) {
        showAlert('ไม่มีสิทธิ์', 'เฉพาะแอดมินและผู้อำนวยการเท่านั้นที่ลบรายชื่อแพทย์ได้', 'warning');
        return;
    }
    const item = doctors.find((d) => String(d.id) === String(id));
    if (!item) return;
    let confirmed = true;
    if (window.Swal) {
        const result = await Swal.fire({
            title: 'ลบรายชื่อนี้?',
            text: `"${item.name}" จะถูกลบออกจากรายชื่อแพทย์`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'ลบรายชื่อ',
            cancelButtonText: 'ยกเลิก',
            confirmButtonColor: '#dc2626'
        });
        confirmed = result.isConfirmed;
    } else {
        confirmed = confirm(`ลบ "${item.name}" ออกจากรายชื่อแพทย์?`);
    }
    if (!confirmed) return;
    try {
        doctors = doctors.filter((d) => String(d.id) !== String(id));
        saveDoctorsLocal();
        renderDoctors();
        showAlert('ลบรายชื่อแล้ว', `${item.name} ถูกลบออกจากรายชื่อแพทย์`, 'success');
    } catch (err) {
        showAlert('ลบไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    }
}

function renderProfile() {
    const profile = userProfiles[currentUser];
    if (!profile) return;
    document.getElementById('profileName').textContent = profile.name;
    document.getElementById('profileRole').textContent = profile.role;
    const avatarSrc = profile.avatar || 'assets/images/IMG_4433.jpg';
    const userAvatar = document.getElementById('userAvatar');
    if (userAvatar) {
        userAvatar.src = avatarSrc;
        userAvatar.alt = `${profile.name} avatar`;
    }
    const brandAvatar = document.getElementById('brandAvatar');
    if (brandAvatar) brandAvatar.src = avatarSrc;
    const statusLabel = document.getElementById('userStatus');
    const currentCheckIn = getOpenCheckIn(currentUser);
    if (statusLabel) {
        statusLabel.textContent = currentCheckIn ? 'อยู่ในเวร' : 'ยังไม่เข้าเวร';
        statusLabel.style.color = currentCheckIn ? '#16a34a' : '';
    }
    const statusDot = document.getElementById('avatarStatusDot');
    if (statusDot) {
        statusDot.classList.toggle('on-duty', !!currentCheckIn);
    }
    highlightActiveAvatarPreset(avatarSrc);
}

const AVATAR_PRESETS = [
    'assets/images/talos.jpg',
    'assets/images/IMG_4433.jpg',
    'assets/images/123.jpg',
    'assets/images/bg-fivem.png'
];

function highlightActiveAvatarPreset(currentSrc) {
    const grid = document.getElementById('avatarPresetGrid');
    if (!grid) return;
    grid.querySelectorAll('.avatar-preset-item').forEach((img) => {
        const src = img.getAttribute('data-src') || img.getAttribute('src');
        img.classList.toggle('is-active', src === currentSrc);
    });
}

function openAvatarPicker(opts = {}) {
    const panel = document.getElementById('avatarPickerPanel');
    if (!panel) {
        const input = document.getElementById('avatarFileInput');
        if (input) input.click();
        else if (typeof showAlert === 'function') {
            showAlert('ไม่พบแผงเปลี่ยนรูป', 'รีเฟรชหน้าเว็บแล้วลองใหม่', 'warning');
        }
        return;
    }
    panel.classList.remove('hidden');
    panel.style.display = 'block';
    panel.hidden = false;

    const grid = document.getElementById('avatarPresetGrid');
    if (grid) {
        grid.innerHTML = AVATAR_PRESETS.map((src) =>
            `<img class="avatar-preset-item" src="${src}" data-src="${src}" alt="preset" title="เลือกรูปนี้" role="button">`
        ).join('');
        grid.querySelectorAll('.avatar-preset-item').forEach((img) => {
            img.addEventListener('click', () => saveUserAvatar(img.getAttribute('data-src')));
        });
    }
    highlightActiveAvatarPreset(userProfiles[currentUser]?.avatar);

    try {
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (_e) { /* ignore */ }

    if (opts.openFile) {
        const input = document.getElementById('avatarFileInput');
        if (input) setTimeout(() => input.click(), 80);
    }
}

function closeAvatarPicker() {
    const panel = document.getElementById('avatarPickerPanel');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.style.display = '';
}

function resizeImageToDataUrl(file, maxSize = 320, quality = 0.82) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith('image/')) {
            reject(new Error('กรุณาเลือกไฟล์รูปภาพ'));
            return;
        }
        if (file.size > 8 * 1024 * 1024) {
            reject(new Error('ไฟล์ใหญ่เกิน 8MB'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('โหลดรูปไม่สำเร็จ'));
            img.onload = () => {
                let { width, height } = img;
                const scale = Math.min(1, maxSize / Math.max(width, height));
                width = Math.round(width * scale);
                height = Math.round(height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                let dataUrl = canvas.toDataURL('image/jpeg', quality);
                // ถ้ายังใหญ่ ลดคุณภาพ
                if (dataUrl.length > 500000) {
                    dataUrl = canvas.toDataURL('image/jpeg', 0.65);
                }
                resolve(dataUrl);
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

async function saveUserAvatar(avatar) {
    if (!currentUser || !avatar) return;
    try {
        if (typeof apiUpdateAvatar === 'function' && sessionStorage.getItem('medicToken')) {
            const res = await apiUpdateAvatar(avatar);
            const u = res?.user;
            if (u && userProfiles[currentUser]) {
                userProfiles[currentUser].avatar = u.avatar || avatar;
            } else if (userProfiles[currentUser]) {
                userProfiles[currentUser].avatar = avatar;
            }
            try {
                const p = JSON.parse(sessionStorage.getItem('medicProfile') || '{}');
                p.avatar = userProfiles[currentUser].avatar;
                sessionStorage.setItem('medicProfile', JSON.stringify(p));
            } catch (_e) { /* ignore */ }
        } else {
            // โหมด localStorage
            if (userProfiles[currentUser]) userProfiles[currentUser].avatar = avatar;
            try {
                localStorage.setItem('medicAvatar_' + currentUser, avatar);
            } catch (_e) {
                showAlert('บันทึกไม่สำเร็จ', 'ที่เก็บในเครื่องเต็มหรือไม่รองรับรูปขนาดนี้', 'warning');
                return;
            }
        }
        renderProfile();
        closeAvatarPicker();
        showAlert('อัปเดตรูปโปรไฟล์แล้ว', 'บันทึกเรียบร้อย', 'success');
    } catch (err) {
        showAlert('อัปเดตรูปไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    }
}

async function handleAvatarFileChange(event) {
    const file = event.target?.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
        showAlert('กำลังประมวลผลรูป...', 'ย่อขนาดให้อัตโนมัติ', 'info');
        const dataUrl = await resizeImageToDataUrl(file);
        await saveUserAvatar(dataUrl);
    } catch (err) {
        showAlert('อัปโหลดไม่สำเร็จ', err.message || 'ลองใหม่', 'error');
    }
}

function setupAvatarPicker() {
    // ใช้ event delegation — ผูกครั้งเดียวบน document แน่นอนว่ากดแล้วทำงาน
    if (!window.__avatarPickerDelegated) {
        window.__avatarPickerDelegated = true;
        document.addEventListener('click', (e) => {
            const t = e.target;
            if (!t || !t.closest) return;
            if (t.closest('#btnEditAvatar') || t.closest('#btnChangeAvatar')) {
                e.preventDefault();
                e.stopPropagation();
                openAvatarPicker();
                return;
            }
            if (t.closest('#btnCloseAvatarPicker')) {
                e.preventDefault();
                closeAvatarPicker();
                return;
            }
            if (t.closest('#btnResetAvatar')) {
                e.preventDefault();
                const fallback = AVATAR_PRESETS[0] || 'assets/images/IMG_4433.jpg';
                saveUserAvatar(fallback);
                return;
            }
            if (t.closest('#btnUploadAvatar')) {
                e.preventDefault();
                const input = document.getElementById('avatarFileInput');
                if (input) input.click();
                return;
            }
        });
    }

    const fileInput = document.getElementById('avatarFileInput');
    if (fileInput && !fileInput.dataset.bound) {
        fileInput.dataset.bound = '1';
        fileInput.addEventListener('change', handleAvatarFileChange);
    }

    // โหลด avatar จาก local (โหมด offline)
    try {
        const localAv = localStorage.getItem('medicAvatar_' + currentUser);
        if (localAv && userProfiles[currentUser] && (!userProfiles[currentUser].avatar || !sessionStorage.getItem('medicToken'))) {
            userProfiles[currentUser].avatar = localAv;
        }
    } catch (_e) { /* ignore */ }
}

function renderLog() {
    const list = document.getElementById('logList');
    const currentDate = document.getElementById('currentDate');
    const historyLabel = document.getElementById('historyLabel');
    if (!list || !currentDate) return;
    const targetUser = getHistoryTarget();
    list.innerHTML = '';
    currentDate.textContent = todayDate();
    if (historyLabel) {
        historyLabel.textContent = userProfiles[targetUser]?.name || 'ไม่ระบุ';
    }
    const logs = (shiftLog[targetUser] || []).slice().reverse();
    if (!logs.length) {
        list.innerHTML = '<div class="log-item"><strong>ยังไม่มีบันทึก</strong><span>เริ่มต้นด้วยการเข้าเวรครั้งแรก</span></div>';
        staggerChildren(list);
        return;
    }
    logs.forEach((log) => {
        const card = document.createElement('div');
        card.className = 'log-item';
        if (log.type === 'เข้าเวร') {
            card.innerHTML = `<strong>✅ เข้าเวร</strong><span>${log.date} เวลา ${log.time}</span>`;
        } else {
            const forced = log.isForced ? ' (บังคับ)' : '';
            card.innerHTML = `<strong>🚪 ออกเวร</strong><span>${log.date} เวลา ${log.time} ${log.duration ? `(${log.duration})` : ''}${forced}</span>`;
        }
        list.appendChild(card);
    });
    staggerChildren(list);
}

function renderTeamStatus() {
    const panel = document.getElementById('statusPanel');
    if (!panel) return;
    panel.innerHTML = '';
    panel.className = 'status-panel';

    Object.keys(users).forEach((username) => {
        const profile = userProfiles[username];
        if (!profile) return;
        const checkIn = getOpenCheckIn(username);
        const elapsed = checkIn ? formatElapsed(Math.floor((new Date() - new Date(checkIn.datetime)) / 1000)) : null;
        const card = document.createElement('div');
        card.className = 'status-card';
        card.innerHTML = `
            <div class="status-row">
                <div>
                    <strong>${profile.name}</strong>
                    <span>${profile.role}</span>
                </div>
                <span class="badge ${checkIn ? 'in' : 'out'}">${checkIn ? 'เข้าแล้ว' : 'ยังไม่เข้า'}</span>
            </div>
            ${checkIn ? `<span>เข้าเวรเมื่อ ${new Date(checkIn.datetime).toLocaleTimeString('th-TH', { hour12: false })} | ทำงาน ${elapsed}</span>` : ''}
            <div class="status-row" style="margin-top: 12px; gap: 10px;">
                <button class="btn btn-secondary btn-small view-history" data-user="${username}" type="button">ดูประวัติ</button>
                ${checkIn ? `<button class="btn btn-danger btn-small force-logout" data-user="${username}" type="button">ออกเวร</button>` : ''}
            </div>
        `;
        panel.appendChild(card);
    });

    // Bind buttons inside the panel
    panel.querySelectorAll('.view-history').forEach((button) => {
        button.addEventListener('click', (event) => {
            const username = event.currentTarget.dataset.user;
            openUserHistory(username);
        });
    });
    panel.querySelectorAll('.force-logout').forEach((button) => {
        button.addEventListener('click', (event) => {
            const username = event.currentTarget.dataset.user;
            confirmForceOut(username);
        });
    });
    staggerChildren(panel);
}

function renderForceOut() {
    const panel = document.getElementById('forceOutPanel');
    if (!panel) return;
    panel.innerHTML = '';
    let hasActive = false;
    Object.keys(users).forEach((username) => {
        const profile = userProfiles[username];
        const checkIn = getOpenCheckIn(username);
        if (!checkIn) return;
        hasActive = true;
        const card = document.createElement('div');
        card.className = 'forceout-card';
        card.innerHTML = `
            <div class="status-row">
                <div>
                    <strong>${profile.name}</strong>
                    <span>เข้าเวร ${checkIn.date} เวลา ${new Date(checkIn.datetime).toLocaleTimeString('th-TH', { hour12: false })}</span>
                </div>
                <button class="btn btn-danger force-logout" data-user="${username}">ออกเวร</button>
            </div>
        `;
        card.querySelector('.force-logout').addEventListener('click', () => confirmForceOut(username));
        panel.appendChild(card);
    });
    if (!hasActive) {
        panel.innerHTML = '<div class="forceout-card"><strong>ไม่มีผู้ใช้งานที่ต้องออกเวร</strong><span>พนักงานทุกคนได้ออกเวรแล้วหรือยังไม่ได้เข้าเวร</span></div>';
    }
    staggerChildren(panel);
}

// บังคับออกเวร — บันทึกในเครื่อง
async function confirmForceOut(username) {
    try {
        const open = getOpenCheckIn(username);
        if (!open) throw new Error('ไม่พบเวรที่ค้างอยู่');
        const t = thaiNow();
        const duration = calcDuration(open.datetime, t.now);
        open.duration = duration;
        open.outTime = t.time;
        if (!shiftLog[username]) shiftLog[username] = [];
        shiftLog[username].push({
            type: 'ออกเวร',
            date: t.date,
            time: t.time,
            duration,
            isForced: true
        });
        saveShiftLog();
        refreshShiftViews();
        showAlert('ออกเวรสำเร็จ', `${userProfiles[username].name} ถูกออกเวรเรียบร้อยแล้ว`, 'success');
    } catch (err) {
        showAlert('ทำรายการไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    }
}

// เข้าเวร — บันทึกในเครื่อง
async function handleCheckIn() {
    const btn = document.getElementById('btnCheckIn');
    if (btn) btn.disabled = true;
    try {
        if (getOpenCheckIn(currentUser)) throw new Error('เข้าเวรอยู่แล้ว');
        const t = thaiNow();
        if (!shiftLog[currentUser]) shiftLog[currentUser] = [];
        shiftLog[currentUser].push({
            type: 'เข้าเวร',
            datetime: t.iso,
            date: t.date,
            time: t.time
        });
        saveShiftLog();
        refreshShiftViews();
        celebrate({ particleCount: 110, spread: 80, origin: { y: 0.65 }, colors: ['#22c55e', '#2563eb', '#a78bfa', '#fbbf24'] });
        showAlert('เข้าเวรสำเร็จ', `${userProfiles[currentUser].name} เข้าเวรเรียบร้อย`, 'success');
    } catch (err) {
        showAlert('เข้าเวรไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    } finally {
        updateActionButtons();
    }
}

// ออกเวร — บันทึกในเครื่อง
async function handleCheckOut() {
    const btn = document.getElementById('btnCheckOut');
    if (btn) btn.disabled = true;
    try {
        const open = getOpenCheckIn(currentUser);
        if (!open) throw new Error('ไม่พบเวรที่ค้างอยู่');
        const t = thaiNow();
        const duration = calcDuration(open.datetime, t.now);
        open.duration = duration;
        open.outTime = t.time;
        if (!shiftLog[currentUser]) shiftLog[currentUser] = [];
        shiftLog[currentUser].push({
            type: 'ออกเวร',
            date: t.date,
            time: t.time,
            duration,
            isForced: false
        });
        saveShiftLog();
        refreshShiftViews();
        celebrate({ particleCount: 60, spread: 60, origin: { y: 0.65 }, colors: ['#f87171', '#fb923c', '#fbbf24'] });
        showAlert('ออกเวรสำเร็จ', `${userProfiles[currentUser].name} ออกเวรเรียบร้อย (${duration})`, 'success');
    } catch (err) {
        showAlert('ออกเวรไม่สำเร็จ', err.message || 'ลองใหม่อีกครั้ง', 'error');
    } finally {
        updateActionButtons();
    }
}

function openUserHistory(username) {
    if (!canViewMonitoring(currentUser)) {
        showAlert('ไม่มีสิทธิ์เข้าถึง', 'เฉพาะผู้ใช้ที่มีสิทธิ์เท่านั้น', 'warning');
        return;
    }
    historyViewUser = username;
    const select = document.getElementById('historySelect');
    if (select) select.value = username;
    const label = document.getElementById('historyLabel');
    if (label) label.textContent = userProfiles[username]?.name || 'ไม่ระบุ';
    renderLog();
    setDashboardPanelActive('historySection');
}

function setDashboardPanelActive(target) {
    const workspace = document.getElementById('workspaceMain') || document.querySelector('main.dashboard-grid');
    if (!workspace) return null;

    const panels = Array.from(workspace.querySelectorAll(':scope > .panel'));
    const nextPanel = panels.find((panel) => panel.id === target);
    if (!nextPanel) return null;

    const changed = nextPanel.classList.contains('hidden');
    panels.forEach((panel) => {
        const active = panel === nextPanel;
        panel.classList.toggle('hidden', !active);
        panel.setAttribute('aria-hidden', String(!active));
        panel.inert = !active;
    });

    document.querySelectorAll('.nav-link').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.target === target);
        btn.setAttribute('aria-current', btn.dataset.target === target ? 'page' : 'false');
    });

    if (changed) playSectionEnter(nextPanel);
    return nextPanel;
}

function handleMenuSwitch(event) {
    const target = event.currentTarget.dataset.target;
    if (!target) return;
    if ((target === 'adminSection' || target === 'stockHistorySection') && !canViewMonitoring(currentUser)) {
        showAlert('ไม่มีสิทธิ์เข้าถึง', 'เฉพาะผู้ใช้ที่มีสิทธิ์เท่านั้น', 'warning');
        return;
    }
    if ((target === 'securitySection' || target === 'membersSection' || target === 'intelSection') && !isAdmin(currentUser)) {
        showAlert('ไม่มีสิทธิ์เข้าถึง', 'เฉพาะแอดมินเท่านั้น', 'warning');
        return;
    }
    if (target === 'intelSection' && !window.__intelUnlocked) {
        showAlert('เมนูลับ', 'ยังไม่ได้ปลดล็อกเมนู Intel', 'warning');
        return;
    }

    setDashboardPanelActive(target);

    if (target === 'leaveRequestsSection') loadLeaveRequests();

    // Shared data is hydrated during dashboard startup. Do not refetch it
    // every time a user opens the stock history panel.
    if (target === 'intelSection' && typeof setupIntelAdmin === 'function') {
        setupIntelAdmin();
    }
}

function handleTabSwitch(event) {
    const mode = event.currentTarget.dataset.mode;
    if (!mode) return;

    const statusPanel = document.getElementById('statusPanel');
    const forceOutPanel = document.getElementById('forceOutPanel');
    const nextPanel = mode === 'status' ? statusPanel : forceOutPanel;
    if (!nextPanel) return;

    const changed = nextPanel.classList.contains('hidden');
    document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    [[statusPanel, mode === 'status'], [forceOutPanel, mode === 'forceout']].forEach(([panel, active]) => {
        if (!panel) return;
        panel.classList.toggle('hidden', !active);
        panel.setAttribute('aria-hidden', String(!active));
        panel.inert = !active;
    });

    if (changed) playSectionEnter(nextPanel);
}

function bindDashboardEvents() {
    document.getElementById('btnCheckIn')?.addEventListener('click', handleCheckIn);
    document.getElementById('btnCheckOut')?.addEventListener('click', handleCheckOut);
    document.getElementById('btnManual')?.addEventListener('click', () => window.open(manualUrl, '_blank'));
    document.getElementById('btnRules')?.addEventListener('click', () => window.open(rulesUrl, '_blank'));
    document.getElementById('btnFundDeposit')?.addEventListener('click', () => handleFundTransaction('deposit'));
    document.getElementById('btnFundWithdraw')?.addEventListener('click', () => handleFundTransaction('withdraw'));
    document.getElementById('btnFundAddDeposit')?.addEventListener('click', () => handleFundAdminAdd('deposit'));
    document.getElementById('btnFundAddReserve')?.addEventListener('click', () => handleFundAdminAdd('reserve'));
    document.getElementById('btnAddStock')?.addEventListener('click', handleAddStock);
    document.getElementById('btnAddVehicle')?.addEventListener('click', handleAddVehicle);
    document.getElementById('btnAddDoctor')?.addEventListener('click', handleAddDoctor);
    document.getElementById('btnLogout')?.addEventListener('click', () => {
        sessionStorage.removeItem('loggedInUser');
        sessionStorage.removeItem('medicUser');
        sessionStorage.removeItem('medicProfile');
        sessionStorage.removeItem('medicToken');
        window.location.href = 'index.html';
    });
    document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', handleMenuSwitch));
    document.querySelectorAll('.tab-btn').forEach((tab) => tab.addEventListener('click', handleTabSwitch));
    setupAvatarPicker();
}

function setDashboardLoading(isLoading) {
    const workspace = document.getElementById('workspaceMain');
    if (!workspace) return;
    workspace.classList.toggle('is-loading', Boolean(isLoading));
    workspace.setAttribute('aria-busy', String(Boolean(isLoading)));
}

async function initDashboard() {
    setDashboardLoading(true);
    currentUser = sessionStorage.getItem('loggedInUser') || sessionStorage.getItem('medicUser');
    const hasApiToken = typeof getToken === 'function' && !!getToken();
    if (!currentUser || !hasApiToken) {
        if (typeof clearSession === 'function') clearSession();
        window.location.href = 'index.html';
        return;
    }
    // sync ทั้งสอง key กันดีดออก
    sessionStorage.setItem('loggedInUser', currentUser);
    startClock();
    bindDashboardEvents();

    // Load the server-backed state before rendering any dashboard data.
    try {
        await loadAllData();
    } catch (err) {
        showAlert('เชื่อมต่อฐานข้อมูลไม่สำเร็จ', 'กรุณารีเฟรชหน้าเว็บอีกครั้ง', 'error');
    }
    if (window.__apiDataLoaded !== true) {
        setDashboardLoading(false);
        showAlert('ยังไม่สามารถเปิดแดชบอร์ดได้', 'ไม่สามารถโหลดข้อมูลจากเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง', 'error');
        return;
    }

    renderProfile();
    initLeaveRequests();
    renderHistoryControls();
    renderLog();
    renderTeamStatus();
    renderForceOut();
    renderCentralFund();
    renderStock();
    renderVehicles();
    renderDoctors();
    initCalendarFeature();
    initCurrentDutyPanel();
    updateActionButtons();
    if (!canViewMonitoring(currentUser)) {
        document.getElementById('adminSection')?.classList.add('hidden');
        document.getElementById('stockHistorySection')?.classList.add('hidden');
        document.querySelectorAll('.nav-link').forEach((link) => {
            if (link.dataset.target === 'adminSection' || link.dataset.target === 'stockHistorySection') {
                link.classList.add('hidden');
            }
        });
    } else {
        renderStockWithdrawals();
    }
    document.getElementById('fundAdminCard')?.classList.toggle('hidden', !isAdmin(currentUser));
    document.getElementById('stockAddFormWrap')?.classList.toggle('hidden', !canManageStock(currentUser));
    document.getElementById('doctorsAddFormWrap')?.classList.add('hidden');

    // ผูกคีย์ลัดเมนูลับ Intel (Num1 × 3)
    if (typeof setupIntelUnlock === 'function') {
        try { setupIntelUnlock(); } catch (_e) { /* ignore */ }
    }

    // Reveal the hydrated workspace only after all initial renderers complete.
    setDashboardLoading(false);
    const firstPanel = document.getElementById('overviewSection');
    if (firstPanel && !firstPanel.classList.contains('hidden')) playSectionEnter(firstPanel);
}


function handleLogin(e) {
    e.preventDefault();
    const usernameInput = document.getElementById('usernameInput');
    const passwordInput = document.getElementById('passwordInput');
    const btn = document.getElementById('btnLogin');
    const username = (usernameInput?.value || '').trim().toLowerCase();
    const password = passwordInput?.value || '';

    if (typeof apiLogin !== 'function') {
        showAlert('ระบบยืนยันตัวตนไม่พร้อม', 'ไม่พบ API client — กรุณารีเฟรชหน้าเว็บหรือติดต่อผู้ดูแลระบบ', 'error');
        return;
    }
    if (!username || !password) {
        showAlert('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน', 'warning');
        return;
    }

    if (btn) btn.disabled = true;
    apiLogin(username, password)
        .then((result) => {
            sessionStorage.setItem('loggedInUser', result.username);
            if (result.profile && typeof userProfiles !== 'undefined') userProfiles[result.username] = result.profile;
            window.location.href = 'dashboard.html';
        })
        .catch((err) => {
            const page = document.getElementById('loginPage') || document.querySelector('.login-page');
            page?.classList.add('shake');
            setTimeout(() => page?.classList.remove('shake'), 500);
            showAlert('เข้าสู่ระบบไม่สำเร็จ', err.message || 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'error');
            if (passwordInput) passwordInput.value = '';
        })
        .finally(() => { if (btn) btn.disabled = false; });
}



/* ==========================================================================
   LEAVE REQUESTS — self-service requests and deputy-level approvals
   ========================================================================== */
const leaveUiState = {
    canApprove: false,
    requests: [],
    filter: 'pending',
    loading: false
};

function leaveCanApprove(username) {
    const profile = userProfiles[username];
    if (profile?.isAdmin === true) return true;
    const role = String(profile?.role || '').toLowerCase().replace(/[\s.]/g, '');
    return role.startsWith('รองผู้อำนวยการ') ||
        role.startsWith('ผู้อำนวยการ') ||
        role.startsWith('รองผอ') ||
        role.startsWith('ผอ');
}

function leaveDateLabel(value) {
    if (!value) return '-';
    return new Intl.DateTimeFormat('th-TH', {
        day: 'numeric', month: 'short', year: 'numeric'
    }).format(new Date(`${value}T00:00:00`));
}

function leaveDateRange(request) {
    if (request.startDate === request.endDate) return leaveDateLabel(request.startDate);
    return `${leaveDateLabel(request.startDate)} – ${leaveDateLabel(request.endDate)}`;
}

function leaveStatusInfo(status) {
    const statuses = {
        pending: { label: 'รออนุมัติ', className: 'pending', icon: 'hourglass-split' },
        approved: { label: 'อนุมัติแล้ว', className: 'approved', icon: 'check-circle-fill' },
        rejected: { label: 'ไม่อนุมัติ', className: 'rejected', icon: 'x-circle-fill' }
    };
    return statuses[status] || statuses.pending;
}

function renderLeaveSummary() {
    const counts = {
        total: leaveUiState.requests.length,
        pending: leaveUiState.requests.filter((item) => item.status === 'pending').length,
        approved: leaveUiState.requests.filter((item) => item.status === 'approved').length,
        rejected: leaveUiState.requests.filter((item) => item.status === 'rejected').length
    };
    Object.entries({
        leaveCountTotal: counts.total,
        leaveCountPending: counts.pending,
        leaveCountApproved: counts.approved,
        leaveCountRejected: counts.rejected
    }).forEach(([id, value]) => {
        const node = document.getElementById(id);
        if (node) node.textContent = String(value);
    });
}

function renderLeaveRequests() {
    const list = document.getElementById('leaveRequestList');
    const filterRow = document.getElementById('leaveFilterRow');
    const eyebrow = document.getElementById('leaveListEyebrow');
    const title = document.getElementById('leaveListTitle');
    const count = document.getElementById('leaveVisibleCount');
    const subtitle = document.getElementById('leavePageSubtitle');
    if (!list) return;

    if (filterRow) filterRow.classList.toggle('hidden', !leaveUiState.canApprove);
    if (eyebrow) eyebrow.textContent = leaveUiState.canApprove ? 'TEAM LEAVE REQUESTS' : 'MY LEAVE REQUESTS';
    if (title) title.textContent = leaveUiState.canApprove ? 'คำขอจากสมาชิกทั้งหมด' : 'ประวัติคำขอของฉัน';
    if (subtitle) subtitle.textContent = leaveUiState.canApprove
        ? 'ตรวจสอบและพิจารณาคำขอลาของสมาชิกในทีม'
        : 'ส่งคำขอลาและติดตามผลการพิจารณาของคุณ';

    document.querySelectorAll('[data-leave-filter]').forEach((button) => {
        button.classList.toggle('active', button.dataset.leaveFilter === leaveUiState.filter);
        button.setAttribute('aria-pressed', button.dataset.leaveFilter === leaveUiState.filter ? 'true' : 'false');
    });

    const requests = leaveUiState.canApprove && leaveUiState.filter !== 'all'
        ? leaveUiState.requests.filter((item) => item.status === leaveUiState.filter)
        : leaveUiState.requests;
    if (count) count.textContent = `${requests.length} รายการ`;

    if (!requests.length) {
        const message = leaveUiState.canApprove && leaveUiState.filter === 'pending'
            ? 'ไม่มีคำขอที่รอการอนุมัติ'
            : 'ยังไม่มีคำขอลาในรายการนี้';
        list.innerHTML = `
            <div class="leave-empty-state">
                <i class="bi bi-inbox"></i>
                <strong>${message}</strong>
                <span>${leaveUiState.canApprove ? 'เมื่อมีสมาชิกส่งคำขอ รายการจะปรากฏที่นี่' : 'คำขอที่คุณส่งจะปรากฏที่นี่'}</span>
            </div>`;
        return;
    }

    list.innerHTML = requests.map((request) => {
        const status = leaveStatusInfo(request.status);
        const requester = leaveUiState.canApprove
            ? `<div class="leave-requester"><strong>${escapeHtml(request.requesterName || request.username)}</strong><span>${escapeHtml(request.requesterRole || 'ไม่ระบุตำแหน่ง')}</span></div>`
            : '';
        const note = request.reviewNote
            ? `<div class="leave-review-note ${request.status}"><strong>${request.status === 'rejected' ? 'เหตุผลที่ไม่อนุมัติ' : 'หมายเหตุผู้พิจารณา'}</strong><span>${escapeHtml(request.reviewNote)}</span></div>`
            : '';
        const reviewer = request.reviewedByName
            ? `<span class="leave-reviewed-by">พิจารณาโดย ${escapeHtml(request.reviewedByName)}</span>`
            : '';
        const actions = leaveUiState.canApprove && request.status === 'pending'
            ? `<div class="leave-request-actions">
                   <button type="button" class="leave-action-btn approve" data-leave-approve="${escapeHtml(request.id)}"><i class="bi bi-check2"></i> อนุมัติ</button>
                   <button type="button" class="leave-action-btn reject" data-leave-reject="${escapeHtml(request.id)}"><i class="bi bi-x-lg"></i> ไม่อนุมัติ</button>
               </div>`
            : '';
        const createdAt = request.createdAt
            ? new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(request.createdAt))
            : '';
        return `
            <article class="leave-request-item">
                <div class="leave-request-top">
                    <div class="leave-type-and-date">
                        <span class="leave-type-chip">${escapeHtml(request.leaveType)}</span>
                        <span class="leave-date-range"><i class="bi bi-calendar3"></i> ${leaveDateRange(request)}</span>
                    </div>
                    <span class="leave-status-badge ${status.className}"><i class="bi bi-${status.icon}"></i> ${status.label}</span>
                </div>
                ${requester}
                <div class="leave-reason"><strong>เหตุผลการลา</strong><p>${escapeHtml(request.reason)}</p></div>
                ${note}
                <div class="leave-request-footer">
                    <span>${createdAt ? `ส่งคำขอเมื่อ ${createdAt}` : ''}</span>
                    ${reviewer}
                </div>
                ${actions}
            </article>`;
    }).join('');
}

async function loadLeaveRequests() {
    if (leaveUiState.loading) return;
    const list = document.getElementById('leaveRequestList');
    leaveUiState.loading = true;
    if (list) list.innerHTML = '<div class="leave-loading"><span class="leave-spinner"></span> กำลังโหลดคำขอ...</div>';
    try {
        const requests = await apiLoadLeaveRequests();
        leaveUiState.requests = Array.isArray(requests) ? requests : [];
        if (!leaveUiState.canApprove) leaveUiState.filter = 'all';
        renderLeaveSummary();
        renderLeaveRequests();
    } catch (err) {
        if (list) list.innerHTML = `<div class="leave-empty-state error"><i class="bi bi-cloud-slash"></i><strong>โหลดคำขอไม่สำเร็จ</strong><span>${escapeHtml(err.message || 'กรุณาลองใหม่อีกครั้ง')}</span><button type="button" class="leave-retry-btn" id="btnLeaveRetry"><i class="bi bi-arrow-clockwise"></i> ลองอีกครั้ง</button></div>`;
    } finally {
        leaveUiState.loading = false;
    }
}

async function submitLeaveRequest(event) {
    event.preventDefault();
    const form = document.getElementById('leaveRequestForm');
    if (!form?.reportValidity()) return;
    const payload = {
        leaveType: document.getElementById('leaveType').value,
        startDate: document.getElementById('leaveStartDate').value,
        endDate: document.getElementById('leaveEndDate').value,
        reason: document.getElementById('leaveReason').value.trim()
    };
    if (payload.endDate < payload.startDate) {
        showAlert('วันที่ไม่ถูกต้อง', 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มลา', 'warning');
        return;
    }

    const button = document.getElementById('btnLeaveSubmit');
    if (button) button.disabled = true;
    try {
        await apiCreateLeaveRequest(payload);
        form.reset();
        showAlert('ส่งคำขอลาแล้ว', 'คำขอของคุณถูกส่งเพื่อรอการพิจารณา', 'success');
        await loadLeaveRequests();
    } catch (err) {
        showAlert('ส่งคำขอไม่สำเร็จ', err.message || 'กรุณาลองใหม่อีกครั้ง', 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function decideLeaveRequest(id, status) {
    if (!leaveUiState.canApprove) return;
    const request = leaveUiState.requests.find((item) => String(item.id) === String(id));
    if (!request || request.status !== 'pending') return;

    let reviewNote = '';
    if (window.Swal) {
        const result = await Swal.fire({
            title: status === 'approved' ? 'ยืนยันอนุมัติคำขอลา?' : 'ไม่อนุมัติคำขอลา',
            text: `${request.requesterName || request.username} · ${request.leaveType} · ${leaveDateRange(request)}`,
            icon: status === 'approved' ? 'question' : 'warning',
            input: status === 'rejected' ? 'textarea' : undefined,
            inputLabel: status === 'rejected' ? 'เหตุผลที่ไม่อนุมัติ' : undefined,
            inputPlaceholder: status === 'rejected' ? 'ระบุเหตุผลให้ผู้ยื่นคำขอทราบ' : undefined,
            inputValidator: status === 'rejected' ? (value) => !String(value || '').trim() || String(value).trim().length < 3
                ? 'กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร' : undefined : undefined,
            showCancelButton: true,
            confirmButtonText: status === 'approved' ? 'อนุมัติ' : 'ยืนยันไม่อนุมัติ',
            cancelButtonText: 'ยกเลิก',
            confirmButtonColor: status === 'approved' ? '#187653' : '#a83f4a',
            reverseButtons: true
        });
        if (!result.isConfirmed) return;
        reviewNote = status === 'rejected' ? String(result.value || '').trim() : '';
    } else {
        if (!window.confirm(status === 'approved' ? 'ยืนยันอนุมัติคำขอลานี้?' : 'ยืนยันไม่อนุมัติคำขอลานี้?')) return;
        if (status === 'rejected') {
            reviewNote = String(window.prompt('ระบุเหตุผลที่ไม่อนุมัติ') || '').trim();
            if (reviewNote.length < 3) return;
        }
    }

    try {
        await apiDecideLeaveRequest({ id, status, reviewNote });
        showAlert(status === 'approved' ? 'อนุมัติคำขอแล้ว' : 'ไม่อนุมัติคำขอแล้ว', request.requesterName || request.username, 'success');
        await loadLeaveRequests();
    } catch (err) {
        showAlert('บันทึกผลการพิจารณาไม่สำเร็จ', err.message || 'กรุณาลองใหม่อีกครั้ง', 'error');
    }
}

function initLeaveRequests() {
    const form = document.getElementById('leaveRequestForm');
    const list = document.getElementById('leaveRequestList');
    const start = document.getElementById('leaveStartDate');
    const end = document.getElementById('leaveEndDate');
    if (!form || !list || window.__leaveRequestsInitialized) return;
    window.__leaveRequestsInitialized = true;
    leaveUiState.canApprove = leaveCanApprove(currentUser);
    leaveUiState.filter = leaveUiState.canApprove ? 'pending' : 'all';
    document.getElementById('leaveFilterRow')?.classList.toggle('hidden', !leaveUiState.canApprove);
    form.addEventListener('submit', submitLeaveRequest);
    start?.addEventListener('change', () => {
        if (start.value) {
            end.min = start.value;
            if (end.value && end.value < start.value) end.value = start.value;
        }
    });
    document.getElementById('btnLeaveRefresh')?.addEventListener('click', loadLeaveRequests);
    document.getElementById('leaveFilterRow')?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-leave-filter]');
        if (!button || !leaveUiState.canApprove) return;
        leaveUiState.filter = button.dataset.leaveFilter;
        renderLeaveRequests();
    });
    list.addEventListener('click', async (event) => {
        const approve = event.target.closest('[data-leave-approve]');
        if (approve) return decideLeaveRequest(approve.dataset.leaveApprove, 'approved');
        const reject = event.target.closest('[data-leave-reject]');
        if (reject) return decideLeaveRequest(reject.dataset.leaveReject, 'rejected');
        if (event.target.closest('#btnLeaveRetry')) return loadLeaveRequests();
    });
}

/* ==========================================================================
   SHARED CALENDAR — events visible to all signed-in users.
   Deputy directors, directors and admins can create, edit and delete events.
   ========================================================================== */
const calendarUiState = {
    month: null,
    selectedDate: '',
    events: [],
    canManage: false,
    editingId: null,
    returnFocus: null
};

function calendarIsoDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function calendarDateFromIso(value) {
    const [year, month, day] = String(value || '').split('-').map(Number);
    return new Date(year, month - 1, day);
}

function calendarThaiDate(value, options = {}) {
    return new Intl.DateTimeFormat('th-TH', {
        weekday: options.weekday || undefined,
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    }).format(calendarDateFromIso(value));
}

function calendarCanManage(username) {
    const profile = userProfiles[username];
    const role = String(profile?.role || '').toLowerCase().replace(/\s+/g, '');
    return profile?.isAdmin === true || role.includes('แอดมิน') || role.includes('ผู้อำนวยการ');
}

function calendarEventTime(event) {
    if (!event.startTime) return 'ตลอดวัน';
    return event.endTime ? `${event.startTime} – ${event.endTime}` : `เริ่ม ${event.startTime}`;
}

function renderCalendarMonth() {
    const monthTitle = document.getElementById('calendarMonthTitle');
    const grid = document.getElementById('calendarGrid');
    if (!monthTitle || !grid || !calendarUiState.month) return;

    const year = calendarUiState.month.getFullYear();
    const month = calendarUiState.month.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    monthTitle.textContent = new Intl.DateTimeFormat('th-TH', {
        month: 'long',
        year: 'numeric'
    }).format(new Date(year, month, 1));

    const today = calendarIsoDate(new Date());
    const cells = [];
    for (let i = 0; i < firstDay; i++) {
        cells.push('<span class="calendar-day-spacer" aria-hidden="true"></span>');
    }
    for (let day = 1; day <= daysInMonth; day++) {
        const date = calendarIsoDate(new Date(year, month, day));
        const count = calendarUiState.events.filter((event) => event.date === date).length;
        const selected = date === calendarUiState.selectedDate;
        const isToday = date === today;
        cells.push(`
            <button type="button"
                class="calendar-day${selected ? ' selected' : ''}${isToday ? ' today' : ''}${count ? ' has-events' : ''}"
                data-calendar-date="${date}"
                aria-pressed="${selected ? 'true' : 'false'}"
                aria-label="${calendarThaiDate(date)} มี ${count} กิจกรรม">
                <span class="calendar-day-number">${day}</span>
                ${count ? `<span class="calendar-day-count">${count > 9 ? '9+' : count}</span>` : '<span class="calendar-day-dot" aria-hidden="true"></span>'}
            </button>
        `);
    }
    const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;
    while (cells.length < totalCells) cells.push('<span class="calendar-day-spacer" aria-hidden="true"></span>');
    grid.innerHTML = cells.join('');
    renderCalendarDayDetails();
}

function renderCalendarDayDetails() {
    const dateLabel = document.getElementById('calendarSelectedDate');
    const eventsList = document.getElementById('calendarEventsList');
    const addButton = document.getElementById('btnCalendarAdd');
    const permissionNote = document.getElementById('calendarPermissionNote');
    if (!eventsList || !calendarUiState.selectedDate) return;

    if (dateLabel) dateLabel.textContent = calendarThaiDate(calendarUiState.selectedDate, { weekday: 'long' });
    if (addButton) addButton.classList.toggle('hidden', !calendarUiState.canManage);
    if (permissionNote) {
        permissionNote.textContent = calendarUiState.canManage
            ? 'คุณสามารถสร้าง แก้ไข และลบกิจกรรมในปฏิทินได้'
            : 'คุณสามารถดูตารางกิจกรรมได้ การสร้างหรือแก้ไขกำหนดให้รองผู้อำนวยการขึ้นไป';
    }

    const events = calendarUiState.events.filter((event) => event.date === calendarUiState.selectedDate);
    if (!events.length) {
        eventsList.innerHTML = '<div class="calendar-empty-state"><i class="bi bi-calendar2-check"></i><strong>ยังไม่มีกิจกรรมในวันนี้</strong><span>เลือกวันอื่นเพื่อดูตาราง หรือรอผู้ดูแลเพิ่มกิจกรรม</span></div>';
        return;
    }

    eventsList.innerHTML = events.map((event) => {
        const description = event.description
            ? `<p class="calendar-event-description">${escapeHtml(event.description).split('\n').join('<br>')}</p>`
            : '';
        const location = event.location
            ? `<span class="calendar-event-location"><i class="bi bi-geo-alt"></i> ${escapeHtml(event.location)}</span>`
            : '';
        const controls = calendarUiState.canManage ? `
            <div class="calendar-event-actions">
                <button type="button" class="calendar-mini-btn" data-calendar-edit="${escapeHtml(event.id)}" aria-label="แก้ไข ${escapeHtml(event.title)}"><i class="bi bi-pencil-square"></i> แก้ไข</button>
                <button type="button" class="calendar-mini-btn danger" data-calendar-delete="${escapeHtml(event.id)}" aria-label="ลบ ${escapeHtml(event.title)}"><i class="bi bi-trash3"></i> ลบ</button>
            </div>` : '';
        return `
            <article class="calendar-event-card">
                <div class="calendar-event-card-top">
                    <span class="calendar-event-time"><i class="bi bi-clock"></i> ${calendarEventTime(event)}</span>
                    ${controls}
                </div>
                <h4>${escapeHtml(event.title)}</h4>
                ${description}
                ${location}
                <span class="calendar-event-author">เพิ่มโดย ${escapeHtml(event.createdByName || 'ไม่ระบุ')}</span>
            </article>
        `;
    }).join('');
}

async function loadCalendarMonth() {
    const eventsList = document.getElementById('calendarEventsList');
    if (!calendarUiState.month) return;
    const year = calendarUiState.month.getFullYear();
    const month = calendarUiState.month.getMonth();
    const from = calendarIsoDate(new Date(year, month, 1));
    const to = calendarIsoDate(new Date(year, month + 1, 0));
    if (eventsList) eventsList.innerHTML = '<div class="calendar-loading"><span class="calendar-spinner"></span> กำลังโหลดกิจกรรม...</div>';

    try {
        calendarUiState.events = await apiLoadCalendarEvents(from, to);
        if (!Array.isArray(calendarUiState.events)) calendarUiState.events = [];
        renderCalendarMonth();
    } catch (err) {
        calendarUiState.events = [];
        renderCalendarMonth();
        if (eventsList) {
            eventsList.innerHTML = `<div class="calendar-empty-state error"><i class="bi bi-cloud-slash"></i><strong>โหลดกิจกรรมไม่สำเร็จ</strong><span>${escapeHtml(err.message || 'กรุณาลองใหม่อีกครั้ง')}</span><button type="button" class="calendar-mini-btn" id="btnCalendarRetry"><i class="bi bi-arrow-clockwise"></i> ลองอีกครั้ง</button></div>`;
        }
    }
}

function hideCalendarForm() {
    const form = document.getElementById('calendarEventForm');
    if (form) form.classList.add('hidden');
    calendarUiState.editingId = null;
}

function showCalendarForm(eventToEdit = null) {
    if (!calendarUiState.canManage) return;
    const form = document.getElementById('calendarEventForm');
    if (!form) return;
    const titleInput = document.getElementById('calendarEventTitle');
    const descriptionInput = document.getElementById('calendarEventDescription');
    const dateInput = document.getElementById('calendarEventDate');
    const startInput = document.getElementById('calendarEventStart');
    const endInput = document.getElementById('calendarEventEnd');
    const locationInput = document.getElementById('calendarEventLocation');
    const formTitle = document.getElementById('calendarFormTitle');
    const formDate = document.getElementById('calendarFormDate');
    const saveButton = document.getElementById('btnCalendarSave');

    calendarUiState.editingId = eventToEdit?.id || null;
    form.reset();
    if (eventToEdit) {
        titleInput.value = eventToEdit.title || '';
        descriptionInput.value = eventToEdit.description || '';
        dateInput.value = eventToEdit.date || calendarUiState.selectedDate;
        startInput.value = eventToEdit.startTime || '';
        endInput.value = eventToEdit.endTime || '';
        locationInput.value = eventToEdit.location || '';
    } else {
        dateInput.value = calendarUiState.selectedDate;
    }
    if (formTitle) formTitle.textContent = eventToEdit ? 'แก้ไขกิจกรรม' : 'เพิ่มกิจกรรมใหม่';
    if (formDate) formDate.textContent = calendarThaiDate(dateInput.value);
    if (saveButton) saveButton.innerHTML = eventToEdit
        ? '<i class="bi bi-check2"></i> บันทึกการแก้ไข'
        : '<i class="bi bi-plus-lg"></i> เพิ่มกิจกรรม';
    form.classList.remove('hidden');
    titleInput.focus();
}

function closeCalendar() {
    const modal = document.getElementById('calendarModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    hideCalendarForm();
    if (calendarUiState.returnFocus && typeof calendarUiState.returnFocus.focus === 'function') {
        calendarUiState.returnFocus.focus();
    }
}

async function openCalendar() {
    const modal = document.getElementById('calendarModal');
    if (!modal) return;
    calendarUiState.returnFocus = document.getElementById('btnCalendar');
    const today = new Date();
    calendarUiState.month = new Date(today.getFullYear(), today.getMonth(), 1);
    calendarUiState.selectedDate = calendarIsoDate(today);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    hideCalendarForm();
    renderCalendarMonth();
    await loadCalendarMonth();
    document.getElementById('btnCalendarClose')?.focus();
}

async function changeCalendarMonth(offset) {
    if (!calendarUiState.month) return;
    calendarUiState.month = new Date(
        calendarUiState.month.getFullYear(),
        calendarUiState.month.getMonth() + offset,
        1
    );
    calendarUiState.selectedDate = calendarIsoDate(calendarUiState.month);
    hideCalendarForm();
    await loadCalendarMonth();
}

async function saveCalendarEvent(event) {
    event.preventDefault();
    if (!calendarUiState.canManage) return;
    const form = document.getElementById('calendarEventForm');
    if (!form?.reportValidity()) return;

    const payload = {
        date: document.getElementById('calendarEventDate').value,
        title: document.getElementById('calendarEventTitle').value.trim(),
        description: document.getElementById('calendarEventDescription').value.trim(),
        startTime: document.getElementById('calendarEventStart').value,
        endTime: document.getElementById('calendarEventEnd').value,
        location: document.getElementById('calendarEventLocation').value.trim()
    };
    if (payload.endTime && !payload.startTime) {
        showAlert('ข้อมูลเวลาไม่ครบ', 'กรุณาระบุเวลาเริ่มก่อนเวลาเสร็จสิ้น', 'warning');
        return;
    }
    const saveButton = document.getElementById('btnCalendarSave');
    if (saveButton) saveButton.disabled = true;
    const editing = Boolean(calendarUiState.editingId);
    try {
        if (editing) {
            await apiUpdateCalendarEvent({ ...payload, id: calendarUiState.editingId });
        } else {
            await apiCreateCalendarEvent(payload);
        }
        const [year, month] = payload.date.split('-').map(Number);
        calendarUiState.month = new Date(year, month - 1, 1);
        calendarUiState.selectedDate = payload.date;
        hideCalendarForm();
        await loadCalendarMonth();
        showAlert(editing ? 'แก้ไขกิจกรรมแล้ว' : 'เพิ่มกิจกรรมแล้ว', payload.title, 'success');
    } catch (err) {
        showAlert('บันทึกกิจกรรมไม่สำเร็จ', err.message || 'กรุณาลองใหม่อีกครั้ง', 'error');
    } finally {
        if (saveButton) saveButton.disabled = false;
    }
}

async function deleteCalendarEvent(id) {
    const event = calendarUiState.events.find((item) => String(item.id) === String(id));
    if (!event || !calendarUiState.canManage) return;
    if (!window.confirm(`ยืนยันลบกิจกรรม "${event.title}" หรือไม่?`)) return;
    try {
        await apiDeleteCalendarEvent(id);
        hideCalendarForm();
        await loadCalendarMonth();
        showAlert('ลบกิจกรรมแล้ว', event.title, 'success');
    } catch (err) {
        showAlert('ลบกิจกรรมไม่สำเร็จ', err.message || 'กรุณาลองใหม่อีกครั้ง', 'error');
    }
}

function initCalendarFeature() {
    const button = document.getElementById('btnCalendar');
    const modal = document.getElementById('calendarModal');
    if (!button || !modal || window.__calendarFeatureInitialized) return;
    window.__calendarFeatureInitialized = true;
    calendarUiState.canManage = calendarCanManage(currentUser);

    button.addEventListener('click', openCalendar);
    document.getElementById('btnCalendarClose')?.addEventListener('click', closeCalendar);
    document.getElementById('btnCalendarPrev')?.addEventListener('click', () => changeCalendarMonth(-1));
    document.getElementById('btnCalendarNext')?.addEventListener('click', () => changeCalendarMonth(1));
    document.getElementById('btnCalendarToday')?.addEventListener('click', async () => {
        const today = new Date();
        calendarUiState.month = new Date(today.getFullYear(), today.getMonth(), 1);
        calendarUiState.selectedDate = calendarIsoDate(today);
        hideCalendarForm();
        await loadCalendarMonth();
    });
    document.getElementById('btnCalendarAdd')?.addEventListener('click', () => showCalendarForm());
    document.getElementById('btnCalendarCancel')?.addEventListener('click', hideCalendarForm);
    document.getElementById('calendarEventForm')?.addEventListener('submit', saveCalendarEvent);
    document.getElementById('calendarEventDate')?.addEventListener('change', (event) => {
        const formDate = document.getElementById('calendarFormDate');
        if (formDate && event.target.value) formDate.textContent = calendarThaiDate(event.target.value);
    });
    document.getElementById('calendarGrid')?.addEventListener('click', (event) => {
        const dayButton = event.target.closest('[data-calendar-date]');
        if (!dayButton) return;
        calendarUiState.selectedDate = dayButton.dataset.calendarDate;
        hideCalendarForm();
        renderCalendarMonth();
    });
    document.getElementById('calendarEventsList')?.addEventListener('click', async (event) => {
        const editButton = event.target.closest('[data-calendar-edit]');
        if (editButton && calendarUiState.canManage) {
            const item = calendarUiState.events.find((entry) => String(entry.id) === editButton.dataset.calendarEdit);
            if (item) showCalendarForm(item);
            return;
        }
        const deleteButton = event.target.closest('[data-calendar-delete]');
        if (deleteButton && calendarUiState.canManage) {
            await deleteCalendarEvent(deleteButton.dataset.calendarDelete);
            return;
        }
        if (event.target.closest('#btnCalendarRetry')) await loadCalendarMonth();
    });
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeCalendar();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeCalendar();
    });
}

/* DASHBOARD NUMPAD 9 THEME TOGGLE */
function applyDashboardTheme(theme) {
    const body = document.body;
    if (!body?.classList.contains('dashboard-body')) return;
    const isDark = theme === 'dark';
    body.classList.toggle('theme-dark', isDark);
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

function setupDashboardThemeShortcut() {
    if (!document.body?.classList.contains('dashboard-body') || window.__dashboardThemeShortcutBound) return;
    window.__dashboardThemeShortcutBound = true;

    // Every dashboard visit starts in dark mode, regardless of the previous session.
    applyDashboardTheme('dark');

    document.addEventListener('keydown', (event) => {
        if (event.code !== 'Numpad9' || event.repeat || event.isComposing) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const target = event.target;
        if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
        event.preventDefault();
        applyDashboardTheme(document.body.classList.contains('theme-dark') ? 'light' : 'dark');
    });
}

function initPage() {
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
        initLoginVideo();
        initLoginFocus();
        const yearEl = document.getElementById('year');
        if (yearEl) yearEl.textContent = new Date().getFullYear();
        return;
    }
    if (document.querySelector('.page-dashboard')) {
        setupDashboardThemeShortcut();
        initDashboard();
        initEntrance();
    }
}

window.addEventListener('DOMContentLoaded', initPage);
window.addEventListener('beforeunload', () => {
    if (elapsedInterval) clearInterval(elapsedInterval);
    if (realtimeInterval) clearInterval(realtimeInterval);
    if (loginBgInterval) clearInterval(loginBgInterval);
});

/* ============================================================
   MODERN FX — ระบบลูกเล่นทันสมัย
   ============================================================ */

// Confetti ฉลอง (ปลอดภัยถ้า CDN โหลดไม่สำเร็จ)
function celebrate(options) {
    if (window.confetti) {
        confetti(Object.assign({ zIndex: 9999, disableForReducedMotion: true }, options));
    }
}

// ตัวเลขเงินนับขึ้น/ลงแบบไหลลื่น
function animateMoneyText(el, target, format) {
    if (!el) return;
    const from = Number(el.dataset.val || 0);
    el.dataset.val = target;
    const duration = 700;
    const start = performance.now();
    function tick(now) {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = format(Math.round(from + (target - from) * eased));
        if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

// รายการทยอยเด้งเข้าทีละใบ
function staggerChildren(container) {
    if (!container) return;
    Array.from(container.children).forEach((child, i) => {
        child.classList.remove('animate-in');
        child.style.animationDelay = `${Math.min(i * 70, 420)}ms`;
        child.classList.add('animate-in');
        child.addEventListener('animationend', () => {
            child.classList.remove('animate-in');
            child.style.animationDelay = '';
        }, { once: true });
    });
}

// Smooth panel entrance without forcing layout or leaving animation classes behind.
function playSectionEnter(element) {
    if (!element || typeof element.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const previous = activePanelAnimations.get(element);
    if (previous) previous.cancel();

    const animation = element.animate(
        [
            { opacity: 0, transform: 'translate3d(0, 12px, 0)' },
            { opacity: 1, transform: 'translate3d(0, 0, 0)' }
        ],
        {
            duration: 360,
            easing: 'cubic-bezier(.22, 1, .36, 1)',
            fill: 'both'
        }
    );

    activePanelAnimations.set(element, animation);
    animation.addEventListener('finish', () => {
        animation.cancel();
        if (activePanelAnimations.get(element) === animation) {
            activePanelAnimations.delete(element);
        }
    }, { once: true });
}

/* ---------- Login: video playlist + mouse-proximity focus ---------- */
function initLoginVideo() {
    const playlist = loginVideoPlaylist;
    const video = document.getElementById('bgVideo');
    const btnPlay = document.getElementById('bgPlayPause');
    const iconPlay = document.getElementById('bgPlayIcon');
    const pickBtns = document.querySelectorAll('.bg-pick');
    if (!video || !playlist.length) return;

    const STORAGE_KEY = 'medic_login_bg_index';
    let index = 0;
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved !== null) index = Math.min(parseInt(saved, 10) || 0, playlist.length - 1);
    } catch (_) {}
    let userPaused = false;

    function updatePickUI() {
        pickBtns.forEach((btn) => {
            btn.classList.toggle('active', parseInt(btn.dataset.bg, 10) === index);
        });
    }

    function loadAndPlay(i) {
        index = ((i % playlist.length) + playlist.length) % playlist.length;
        try { localStorage.setItem(STORAGE_KEY, String(index)); } catch (_) {}
        video.style.display = '';
        video.src = playlist[index];
        video.load();
        updatePickUI();
        if (!userPaused) {
            const p = video.play();
            if (p && p.catch) p.catch(() => {});
        }
    }

    const bgImage = document.getElementById('loginBgImage');
    function hidePoster() {
        if (bgImage) bgImage.classList.add('is-hidden');
        video.style.display = '';
    }
    function showPoster() {
        if (bgImage) bgImage.classList.remove('is-hidden');
    }
    video.addEventListener('playing', hidePoster);
    video.addEventListener('error', showPoster);

    function togglePlay() {
        if (video.paused) {
            userPaused = false;
            video.play().catch(() => {});
            if (iconPlay) iconPlay.className = 'bi bi-pause-fill';
        } else {
            userPaused = true;
            video.pause();
            if (iconPlay) iconPlay.className = 'bi bi-play-fill';
        }
    }

    video.loop = false;
    video.muted = true;
    video.playsInline = true;
    video.addEventListener('ended', () => {
        loadAndPlay(index + 1);
    });

    if (btnPlay) btnPlay.addEventListener('click', togglePlay);
    pickBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            userPaused = false;
            loadAndPlay(parseInt(btn.dataset.bg, 10));
            if (iconPlay) iconPlay.className = 'bi bi-pause-fill';
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.target.matches('input, textarea')) return;
        if (e.code === 'Space') {
            e.preventDefault();
            togglePlay();
        } else if (e.key === '1' || e.key === '2' || e.key === '3') {
            userPaused = false;
            loadAndPlay(parseInt(e.key, 10) - 1);
            if (iconPlay) iconPlay.className = 'bi bi-pause-fill';
        }
    });

    loadAndPlay(index);
}

function initLoginFocus() {
    const page = document.getElementById('loginPage') || document.querySelector('.login-page');
    const card = document.getElementById('loginCard') || document.querySelector('.login-card');
    const bgPanel = document.getElementById('bgControls');
    if (!page || !card) return;

    // ปิดเอฟเฟกต์บนมือถือ / touch / reduced-motion
    const mqMobile = window.matchMedia('(max-width: 900px)');
    const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mqMobile.matches || mqReduce.matches) {
        page.style.setProperty('--focus', '1');
        return;
    }

    let target = 0;   // เริ่มหายสนิท รอเมาส์
    let current = 0;
    let focused = false;
    let raf = null;

    // รัศมี "ใกล้" กว้างขึ้น เพื่อให้พิมพ์/กดฟอร์มได้สบาย
    const NEAR_RADIUS = 160;
    const FAR_RADIUS = 420;

    function clamp(v, a, b) {
        return Math.max(a, Math.min(b, v));
    }

    function distanceToEl(el, mx, my) {
        if (!el) return Infinity;
        const r = el.getBoundingClientRect();
        const cx = clamp(mx, r.left, r.right);
        const cy = clamp(my, r.top, r.bottom);
        const dx = mx - cx;
        const dy = my - cy;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function setTargetFromMouse(mx, my) {
        // กำลังโฟกัสช่องกรอก / ปุ่ม → บังคับชัดเต็มที่
        if (focused) {
            target = 1;
            return;
        }
        const d = Math.min(distanceToEl(card, mx, my), distanceToEl(bgPanel, mx, my));
        if (d <= NEAR_RADIUS) {
            target = 1;
        } else if (d >= FAR_RADIUS) {
            target = 0; // หายสนิท → พื้นหลังสว่างสุด
        } else {
            const t = (d - NEAR_RADIUS) / (FAR_RADIUS - NEAR_RADIUS);
            target = Math.pow(1 - t, 1.6);
        }
    }

    function tick() {
        current += (target - current) * 0.16;
        if (Math.abs(target - current) < 0.001) current = target;
        page.style.setProperty('--focus', current.toFixed(4));
        const near = current > 0.65;
        const faded = current < 0.04;
        card.classList.toggle('is-near', near);
        card.classList.toggle('is-faded', faded);
        page.classList.toggle('ui-hidden', current < 0.06);
        // เมื่อยังมองเห็นพอสมควร ให้คลิกได้เสมอ
        if (!faded) {
            card.style.pointerEvents = 'auto';
        }
        if (Math.abs(target - current) > 0.001) {
            raf = requestAnimationFrame(tick);
        } else {
            raf = null;
        }
    }

    function requestTick() {
        if (!raf) raf = requestAnimationFrame(tick);
    }

    document.addEventListener('mousemove', (e) => {
        setTargetFromMouse(e.clientX, e.clientY);
        requestTick();
    }, { passive: true });

    // คลิกที่การ์ด → โชว์ชัดทันที (กันคลิกไม่ติดตอนกำลังจาง)
    card.addEventListener('pointerdown', () => {
        focused = true;
        target = 1;
        requestTick();
    });

    const inputs = card.querySelectorAll('input, button');
    inputs.forEach((el) => {
        el.addEventListener('focus', () => {
            focused = true;
            target = 1;
            requestTick();
        });
        el.addEventListener('blur', () => {
            // delay เล็กน้อย เผื่อคลิกปุ่ม submit
            setTimeout(() => {
                if (!card.contains(document.activeElement)) {
                    focused = false;
                }
            }, 120);
        });
    });

    // เริ่มหายสนิท — พื้นหลังสว่างชัด
    page.style.setProperty('--focus', '0');
    current = 0;
    target = 0;
    card.classList.add('is-faded');
    page.classList.add('ui-hidden');
}

function initTilt() {
    // kept as no-op for compatibility; focus effect replaces tilt
}

// Animate the shell once. Content panels are animated only when activated.
function initEntrance() {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const items = document.querySelectorAll('.page-dashboard > .topbar, .page-dashboard > .dashboard-nav .nav-link');

    items.forEach((element, index) => {
        if (typeof element.animate !== 'function') return;
        const animation = element.animate(
            [
                { opacity: 0, transform: 'translate3d(0, 8px, 0)' },
                { opacity: 1, transform: 'translate3d(0, 0, 0)' }
            ],
            {
                duration: 320,
                delay: Math.min(index * 22, 160),
                easing: 'cubic-bezier(.22, 1, .36, 1)',
                fill: 'both'
            }
        );
        animation.addEventListener('finish', () => animation.cancel(), { once: true });
    });
}

// Ripple กระจายจากจุดที่กด บนปุ่มทุกปุ่มในระบบ
document.addEventListener('click', (event) => {
    const target = event.target.closest('button, .nav-link, .tab-btn');
    if (!target || target.disabled) return;
    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.1;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
    target.appendChild(ripple);
    setTimeout(() => ripple.remove(), 680);
});
/* ============================================================
   MUSIC PLAYER — เล่นไฟล์/โฟลเดอร์เพลงจากเครื่อง
   ============================================================ */
(function initMusicPlayer() {
    var player = document.getElementById('musicPlayer');
    if (!player) return;

    var audio = document.getElementById('musicAudio');
    var titleEl = document.getElementById('musicTitle');
    var subEl = document.getElementById('musicSubtitle');
    var artEl = document.getElementById('musicArt');
    var playBtn = document.getElementById('musicPlay');
    var playIcon = document.getElementById('musicPlayIcon');
    var prevBtn = document.getElementById('musicPrev');
    var nextBtn = document.getElementById('musicNext');
    var seek = document.getElementById('musicSeek');
    var curTime = document.getElementById('musicCurrent');
    var durTime = document.getElementById('musicDuration');
    var vol = document.getElementById('musicVolume');
    var volIcon = document.getElementById('musicVolIcon');
    var fileInput = document.getElementById('musicFileInput');
    var folderInput = document.getElementById('musicFolderInput');
    var pickFilesBtn = document.getElementById('musicPickFiles');
    var pickFolderBtn = document.getElementById('musicPickFolder');
    var playlistBtn = document.getElementById('musicPlaylistBtn');
    var playlistPanel = document.getElementById('musicPlaylistPanel');
    var playlistEl = document.getElementById('musicPlaylist');
    var playlistEmpty = document.getElementById('musicPlaylistEmpty');
    var playlistClose = document.getElementById('musicPlaylistClose');
    var shuffleBtn = document.getElementById('musicShuffleBtn');

    var tracks = []; // { name, url, file }
    var index = -1;
    var seeking = false;
    // โหมดเล่น: order | repeat-all | repeat-one | shuffle
    var playMode = 'order';
    var PLAY_MODES = ['order', 'repeat-all', 'repeat-one', 'shuffle'];
    var PLAY_MODE_META = {
        order:       { icon: 'bi-arrow-right',   title: 'เล่นตามลำดับ',     active: false },
        'repeat-all':{ icon: 'bi-repeat',        title: 'วนทั้งเพลย์ลิสต์',  active: true  },
        'repeat-one':{ icon: 'bi-repeat-1',      title: 'วนเพลงเดียว',      active: true  },
        shuffle:     { icon: 'bi-shuffle',       title: 'สุ่มเพลง',         active: true  }
    };
    var collapsed = false;

    var AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|webm|opus)$/i;

    // —— Drag + Collapse ——
    var dragHandle = document.getElementById('musicDragHandle');
    var collapseBtn = document.getElementById('musicCollapseBtn');
    var collapseIcon = document.getElementById('musicCollapseIcon');
    var STORAGE_KEY = 'musicPlayerPos';

    // state สำหรับ parallax (rotateX/Y) — ใช้ร่วมกับ drag scale/tilt
    var paraRX = 0, paraRY = 0;
    var PARA_MAX = 7; // องศาสูงสุด
    var dragging = false;

    function applyPosition(left, top, scale, tilt) {
        if (left == null || top == null) return;
        player.style.left = left + 'px';
        player.style.top = top + 'px';
        player.style.bottom = 'auto';
        player.style.right = 'auto';
        var s = scale != null ? scale : 1;
        var r = tilt != null ? tilt : 0;
        player.style.transformOrigin = '50% 50%';
        // รวม drag scale/tilt + parallax 3D
        var parts = [];
        if (s !== 1) parts.push('scale(' + s + ')');
        if (r !== 0) parts.push('rotate(' + r + 'deg)');
        if (paraRX !== 0 || paraRY !== 0) {
            parts.push('perspective(900px) rotateX(' + paraRX + 'deg) rotateY(' + paraRY + 'deg)');
        }
        player.style.transform = parts.length ? parts.join(' ') : 'none';
    }

    function setParallaxLayers(nx, ny) {
        // nx, ny ในช่วง -1..1 — ชั้นใกล้เลื่อนมาก / ชั้นไกลเลื่อนน้อย
        var set = function (name, depth) {
            player.style.setProperty('--px-' + name + '-x', (nx * depth) + 'px');
            player.style.setProperty('--px-' + name + '-y', (ny * depth) + 'px');
        };
        set('art', 10);
        set('info', 6);
        set('ctrl', 8);
        set('prog', 4);
        set('local', 5);
    }

    function clearParallaxLayers() {
        ['art', 'info', 'ctrl', 'prog', 'local'].forEach(function (name) {
            player.style.setProperty('--px-' + name + '-x', '0px');
            player.style.setProperty('--px-' + name + '-y', '0px');
        });
    }

    function updateParallaxFromEvent(e) {
        if (dragging) return;
        var rect = player.getBoundingClientRect();
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        var nx = (e.clientX - cx) / (rect.width / 2);
        var ny = (e.clientY - cy) / (rect.height / 2);
        nx = Math.max(-1, Math.min(1, nx));
        ny = Math.max(-1, Math.min(1, ny));
        // เอียง: เมาส์ขวา → หมุน Y บวก, เมาส์ล่าง → หมุน X ลบ (ธรรมชาติ)
        paraRY = nx * PARA_MAX;
        paraRX = -ny * PARA_MAX;
        player.classList.add('is-parallax');
        setParallaxLayers(nx, ny);
        // อัปเดต transform โดยคง left/top ปัจจุบัน
        var curL = parseFloat(player.style.left);
        var curT = parseFloat(player.style.top);
        if (!isNaN(curL) && !isNaN(curT)) {
            applyPosition(curL, curT, 1, 0);
        } else {
            // ยังอยู่ตำแหน่งกลางเริ่มต้น (translateX -50%)
            player.style.transformOrigin = '50% 50%';
            player.style.transform =
                'translateX(-50%) perspective(900px) rotateX(' + paraRX + 'deg) rotateY(' + paraRY + 'deg)';
        }
    }

    function resetParallax() {
        if (dragging) return;
        paraRX = 0;
        paraRY = 0;
        player.classList.remove('is-parallax');
        clearParallaxLayers();
        var curL = parseFloat(player.style.left);
        var curT = parseFloat(player.style.top);
        if (!isNaN(curL) && !isNaN(curT)) {
            applyPosition(curL, curT, 1, 0);
        } else {
            player.style.transform = 'translateX(-50%)';
        }
    }

    function clampPos(left, top) {
        var rect = player.getBoundingClientRect();
        var maxL = Math.max(0, window.innerWidth - rect.width);
        var maxT = Math.max(0, window.innerHeight - rect.height);
        return {
            left: Math.min(Math.max(0, left), maxL),
            top: Math.min(Math.max(0, top), maxT)
        };
    }

    function savePos() {
        try {
            var rect = player.getBoundingClientRect();
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                left: rect.left,
                top: rect.top,
                collapsed: collapsed
            }));
        } catch (e) {}
    }

    function restorePos() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            var data = JSON.parse(raw);
            if (data.collapsed) {
                collapsed = true;
                player.classList.add('is-collapsed');
                if (collapseIcon) collapseIcon.className = 'bi bi-chevron-up';
                if (collapseBtn) collapseBtn.title = 'ขยาย';
            }
            if (typeof data.left === 'number' && typeof data.top === 'number') {
                // wait a frame so collapsed size is applied
                requestAnimationFrame(function () {
                    var p = clampPos(data.left, data.top);
                    applyPosition(p.left, p.top);
                });
            }
        } catch (e) {}
    }

    if (collapseBtn) {
        collapseBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            collapsed = !collapsed;
            player.classList.toggle('is-collapsed', collapsed);
            if (collapseIcon) {
                collapseIcon.className = collapsed ? 'bi bi-chevron-up' : 'bi bi-chevron-down';
            }
            collapseBtn.title = collapsed ? 'ขยาย' : 'หดย่อ';
            // keep inside viewport after size change
            requestAnimationFrame(function () {
                var rect = player.getBoundingClientRect();
                var p = clampPos(rect.left, rect.top);
                applyPosition(p.left, p.top);
                savePos();
            });
        });
    }

    if (dragHandle) {
        var startX = 0, startY = 0, origL = 0, origT = 0;
        var lastX = 0, lastY = 0, velX = 0, velY = 0;
        var DRAG_SCALE = 1.04;
        var MAX_TILT = 2.8;

        function startDrag(clientX, clientY) {
            dragging = true;
            // ปิด parallax ตอนลาก
            paraRX = 0;
            paraRY = 0;
            player.classList.remove('is-parallax', 'is-releasing');
            clearParallaxLayers();
            player.classList.add('is-dragging');
            var rect = player.getBoundingClientRect();
            // แปลงจาก CSS transform (center) เป็นตำแหน่ง absolute ทันที
            applyPosition(rect.left, rect.top, DRAG_SCALE, 0);
            startX = clientX;
            startY = clientY;
            lastX = clientX;
            lastY = clientY;
            velX = 0;
            velY = 0;
            origL = rect.left;
            origT = rect.top;
        }

        dragHandle.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            startDrag(e.clientX, e.clientY);
        });

        // touch support
        dragHandle.addEventListener('touchstart', function (e) {
            if (e.touches.length !== 1) return;
            var t = e.touches[0];
            startDrag(t.clientX, t.clientY);
        }, { passive: true });

        function onMove(clientX, clientY) {
            if (!dragging) return;
            var dx = clientX - startX;
            var dy = clientY - startY;
            // ความเร็วแบบ smooth สำหรับการเอียง (ลดการกระตุก)
            var rawVx = clientX - lastX;
            var rawVy = clientY - lastY;
            velX = velX * 0.55 + rawVx * 0.45;
            velY = velY * 0.55 + rawVy * 0.45;
            lastX = clientX;
            lastY = clientY;
            // เอียงตามทิศทางลาก (แนวนอนหลัก + แนวตั้งเล็กน้อย)
            var tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, velX * 0.42 + velY * 0.1));
            var p = clampPos(origL + dx, origT + dy);
            applyPosition(p.left, p.top, DRAG_SCALE, tilt);
        }

        function onEnd() {
            if (!dragging) return;
            dragging = false;
            player.classList.remove('is-dragging');
            player.classList.add('is-releasing');
            // คืน scale/tilt กลับปกติแบบนุ่มนวล
            var rect = player.getBoundingClientRect();
            // คำนวณตำแหน่งจริงหลัง scale (getBoundingClientRect รวม scale แล้ว)
            // ใช้ left/top ที่ตั้งไว้แล้ว + transform กลับ
            var curL = parseFloat(player.style.left) || rect.left;
            var curT = parseFloat(player.style.top) || rect.top;
            applyPosition(curL, curT, 1, 0);
            setTimeout(function () {
                player.classList.remove('is-releasing');
            }, 300);
            savePos();
        }

        window.addEventListener('mousemove', function (e) {
            onMove(e.clientX, e.clientY);
        });
        window.addEventListener('mouseup', onEnd);
        window.addEventListener('touchmove', function (e) {
            if (!dragging || e.touches.length !== 1) return;
            e.preventDefault();
            onMove(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: false });
        window.addEventListener('touchend', onEnd);
        window.addEventListener('touchcancel', onEnd);
    }

    // —— Parallax 3D เมื่อชี้เมาส์บนแผง (ปิดตอนลาก) ——
    player.addEventListener('mousemove', function (e) {
        if (dragging) return;
        updateParallaxFromEvent(e);
    });
    player.addEventListener('mouseleave', function () {
        if (dragging) return;
        // รีเซ็ตนุ่ม ๆ
        player.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.25s ease';
        resetParallax();
        setTimeout(function () {
            if (!dragging) player.style.transition = '';
        }, 360);
    });

    // keep inside viewport on resize
    window.addEventListener('resize', function () {
        if (!player.style.left || player.style.left === '') return;
        var rect = player.getBoundingClientRect();
        var p = clampPos(rect.left, rect.top);
        applyPosition(p.left, p.top);
        savePos();
    });

    restorePos();

    function fmt(sec) {
        if (!isFinite(sec) || sec < 0) return '0:00';
        var m = Math.floor(sec / 60);
        var s = Math.floor(sec % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    function setPlayingUI(playing) {
        if (playIcon) playIcon.className = playing ? 'bi bi-pause-fill' : 'bi bi-play-fill';
    }

    function enableControls(on) {
        [playBtn, prevBtn, nextBtn, seek].forEach(function (el) {
            if (el) el.disabled = !on;
        });
    }

    function revokeAll() {
        tracks.forEach(function (t) {
            try { URL.revokeObjectURL(t.url); } catch (e) {}
        });
    }

    function isAudioFile(file) {
        if (!file) return false;
        if (file.type && file.type.indexOf('audio/') === 0) return true;
        return AUDIO_EXT.test(file.name || '');
    }

    function addFiles(fileList) {
        var files = Array.prototype.slice.call(fileList || []).filter(isAudioFile);
        if (!files.length) {
            if (typeof showAlert === 'function') {
                showAlert('ไม่พบไฟล์เสียง', 'รองรับ .mp3 .wav .ogg .m4a .flac .aac', 'warning');
            }
            return;
        }
        // เรียงชื่อ
        files.sort(function (a, b) {
            return (a.name || '').localeCompare(b.name || '', 'th', { sensitivity: 'base' });
        });

        var startLen = tracks.length;
        files.forEach(function (f) {
            tracks.push({
                name: f.name.replace(AUDIO_EXT, ''),
                fileName: f.name,
                url: URL.createObjectURL(f),
                file: f
            });
        });

        renderPlaylist();
        enableControls(true);

        // ถ้ายังไม่ได้อยู่เพลงไหน ให้เล่นตัวแรกที่เพิ่งเพิ่ม
        if (index < 0) {
            playAt(startLen);
        } else {
            subEl.textContent = tracks.length + ' เพลงในรายการ';
        }
    }

    function playAt(i) {
        if (i < 0 || i >= tracks.length) return;
        index = i;
        var t = tracks[index];
        audio.src = t.url;
        audio.volume = parseFloat(vol.value) || 0.8;
        titleEl.textContent = t.name;
        subEl.textContent = (index + 1) + ' / ' + tracks.length + ' — ' + (t.fileName || '');
        artEl.innerHTML = '<i class="bi bi-music-note-beamed"></i>';
        enableControls(true);
        highlightPlaylist();
        var p = audio.play();
        if (p && p.catch) {
            p.catch(function () { setPlayingUI(false); });
        }
        setPlayingUI(true);
    }

    function playNext(fromEnded) {
        if (!tracks.length) return;
        if (playMode === 'repeat-one' && fromEnded) {
            audio.currentTime = 0;
            audio.play().catch(function () {});
            setPlayingUI(true);
            return;
        }
        if (playMode === 'shuffle' && tracks.length > 1) {
            var n;
            do { n = Math.floor(Math.random() * tracks.length); } while (n === index);
            playAt(n);
            return;
        }
        // order / repeat-all
        var next = index + 1;
        if (next >= tracks.length) {
            if (playMode === 'repeat-all' || !fromEnded) {
                playAt(0);
            } else {
                // โหมดลำดับ — จบเพลย์ลิสต์แล้วหยุด
                setPlayingUI(false);
                seek.value = 0;
                curTime.textContent = '0:00';
            }
        } else {
            playAt(next);
        }
    }

    function playPrev() {
        if (!tracks.length) return;
        if (audio.currentTime > 3) {
            audio.currentTime = 0;
            return;
        }
        if (playMode === 'shuffle' && tracks.length > 1) {
            var n;
            do { n = Math.floor(Math.random() * tracks.length); } while (n === index);
            playAt(n);
            return;
        }
        playAt((index - 1 + tracks.length) % tracks.length);
    }

    function applyPlayModeUI() {
        if (!shuffleBtn) return;
        var meta = PLAY_MODE_META[playMode] || PLAY_MODE_META.order;
        var icon = shuffleBtn.querySelector('i');
        if (icon) icon.className = 'bi ' + meta.icon;
        shuffleBtn.title = meta.title;
        shuffleBtn.classList.toggle('is-active', !!meta.active);
        shuffleBtn.setAttribute('data-mode', playMode);
    }

    function renderPlaylist() {
        if (!playlistEl) return;
        playlistEl.innerHTML = '';
        if (playlistEmpty) {
            playlistEmpty.hidden = tracks.length > 0;
        }
        tracks.forEach(function (t, i) {
            var li = document.createElement('li');
            li.className = 'music-playlist-item' + (i === index ? ' active' : '');
            li.innerHTML =
                '<span class="music-pl-idx">' + (i + 1) + '</span>' +
                '<span class="music-pl-name"></span>' +
                '<button type="button" class="music-pl-remove" title="ลบ" data-remove="' + i + '">&times;</button>';
            li.querySelector('.music-pl-name').textContent = t.name;
            li.addEventListener('click', function (e) {
                if (e.target.closest('[data-remove]')) return;
                playAt(i);
            });
            var rm = li.querySelector('[data-remove]');
            if (rm) {
                rm.addEventListener('click', function (e) {
                    e.stopPropagation();
                    removeAt(i);
                });
            }
            playlistEl.appendChild(li);
        });
    }

    function highlightPlaylist() {
        if (!playlistEl) return;
        var items = playlistEl.querySelectorAll('.music-playlist-item');
        items.forEach(function (el, i) {
            el.classList.toggle('active', i === index);
        });
    }

    function removeAt(i) {
        if (i < 0 || i >= tracks.length) return;
        try { URL.revokeObjectURL(tracks[i].url); } catch (e) {}
        tracks.splice(i, 1);
        if (!tracks.length) {
            index = -1;
            audio.pause();
            audio.removeAttribute('src');
            titleEl.textContent = 'ยังไม่มีเพลง';
            subEl.textContent = 'เลือกไฟล์หรือโฟลเดอร์เพลงจากเครื่อง';
            enableControls(false);
            setPlayingUI(false);
            seek.value = 0;
            curTime.textContent = '0:00';
            durTime.textContent = '0:00';
        } else {
            if (index === i) {
                playAt(Math.min(i, tracks.length - 1));
            } else if (index > i) {
                index -= 1;
            }
        }
        renderPlaylist();
    }

    // —— UI events ——
    if (pickFilesBtn && fileInput) {
        pickFilesBtn.addEventListener('click', function () { fileInput.click(); });
        fileInput.addEventListener('change', function () {
            if (fileInput.files && fileInput.files.length) addFiles(fileInput.files);
            fileInput.value = '';
        });
    }
    if (pickFolderBtn && folderInput) {
        pickFolderBtn.addEventListener('click', function () { folderInput.click(); });
        folderInput.addEventListener('change', function () {
            if (folderInput.files && folderInput.files.length) addFiles(folderInput.files);
            folderInput.value = '';
        });
    }

    if (playlistBtn && playlistPanel) {
        playlistBtn.addEventListener('click', function () {
            playlistPanel.hidden = !playlistPanel.hidden;
            if (!playlistPanel.hidden) renderPlaylist();
        });
    }
    if (playlistClose && playlistPanel) {
        playlistClose.addEventListener('click', function () {
            playlistPanel.hidden = true;
        });
    }

    if (shuffleBtn) {
        applyPlayModeUI();
        shuffleBtn.addEventListener('click', function () {
            var i = PLAY_MODES.indexOf(playMode);
            playMode = PLAY_MODES[(i + 1) % PLAY_MODES.length];
            applyPlayModeUI();
        });
    }

    playBtn.addEventListener('click', function () {
        if (!tracks.length) return;
        if (audio.paused) {
            audio.play().catch(function () {});
            setPlayingUI(true);
        } else {
            audio.pause();
            setPlayingUI(false);
        }
    });

    prevBtn.addEventListener('click', playPrev);
    nextBtn.addEventListener('click', playNext);

    seek.addEventListener('input', function () { seeking = true; });
    seek.addEventListener('change', function () {
        if (audio.duration) {
            audio.currentTime = (parseFloat(seek.value) / 100) * audio.duration;
        }
        seeking = false;
    });

    audio.addEventListener('timeupdate', function () {
        if (seeking) return;
        curTime.textContent = fmt(audio.currentTime);
        if (audio.duration) {
            durTime.textContent = fmt(audio.duration);
            seek.value = String((audio.currentTime / audio.duration) * 100);
        }
    });
    audio.addEventListener('play', function () { setPlayingUI(true); });
    audio.addEventListener('pause', function () { setPlayingUI(false); });
    audio.addEventListener('ended', function () { playNext(true); });
    audio.addEventListener('error', function () {
        subEl.textContent = 'เล่นไฟล์นี้ไม่ได้ — ข้ามไปเพลงถัดไป';
        setTimeout(playNext, 600);
    });

    vol.addEventListener('input', function () {
        var v = parseFloat(vol.value) || 0;
        audio.volume = v;
        if (volIcon) {
            volIcon.className = v === 0 ? 'bi bi-volume-mute-fill'
                : v < 0.4 ? 'bi bi-volume-down-fill' : 'bi bi-volume-up-fill';
        }
    });

    // ล้าง object URLs ตอนปิดหน้า
    window.addEventListener('beforeunload', revokeAll);
})();




