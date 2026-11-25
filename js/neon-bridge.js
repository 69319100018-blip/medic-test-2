/**
 * Neon Bridge (Secure) — JWT session + API overrides
 */
(function () {
  'use strict';

  if (typeof api !== 'function') {
    console.warn('[Neon] ไม่พบ api-client.js');
    return;
  }

  console.log('[Neon] Secure mode');

  // ---------- Login ----------
  document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('loginForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const username = (document.getElementById('usernameInput')?.value || '').trim().toLowerCase();
      const password = document.getElementById('passwordInput')?.value || '';
      const btn = document.getElementById('btnLogin');
      if (btn) btn.disabled = true;
      try {
        const result = await apiLogin(username, password);
        // sync key ที่ app.js ใช้ตรวจ session
        sessionStorage.setItem('loggedInUser', result.username);
        if (typeof userProfiles !== 'undefined') {
          userProfiles[result.username] = result.profile;
        }
        try {
          const fingerprint = typeof getDeviceFingerprint === 'function' ? getDeviceFingerprint() : (sessionStorage.getItem('medicFp') || '');
          sessionStorage.setItem('medicFp', fingerprint);
          if (typeof apiDeviceReport === 'function') {
            await apiDeviceReport({
              fingerprint,
              userAgent: navigator.userAgent,
              screen: String(screen.width) + 'x' + String(screen.height),
              platform: navigator.platform || '',
              language: navigator.language || ''
            });
          }
        } catch (secErr) {
          if (secErr && /ระงับ|banned|บล็อก/i.test(String(secErr.message || ''))) {
            throw secErr;
          }
        }
        window.location.href = 'dashboard.html';
      } catch (err) {
        if (window.Swal) Swal.fire('เข้าสู่ระบบไม่สำเร็จ', err.message || 'ลองใหม่', 'error');
        else alert(err.message || 'เข้าสู่ระบบไม่สำเร็จ');
      } finally {
        if (btn) btn.disabled = false;
      }
    }, true);
  });

  // ---------- Dashboard ----------
  if (window.location.pathname.includes('dashboard') || document.body.classList.contains('dashboard-body')) {
    const savedUser = sessionStorage.getItem('medicUser');
    const savedProfile = sessionStorage.getItem('medicProfile');
    const token = sessionStorage.getItem('medicToken');
    if (!savedUser || !token) {
      window.location.href = 'index.html';
      return;
    }

    window.loadAllData = async function () {
      window.__apiDataLoaded = false;
      try {
        currentUser = savedUser;

        // Load a consistent dashboard snapshot. Do not partially replace local
        // state if one API request fails.
        const [allUsers, shifts, fund, stock, vehicleRows, doctorRows] = await Promise.all([
          apiLoadUsers(),
          apiLoadShifts(),
          apiLoadFund(),
          apiLoadStock(),
          apiLoadVehicles(),
          apiLoadDoctors()
        ]);

        users = allUsers || {};
        Object.keys(userProfiles).forEach((username) => delete userProfiles[username]);
        Object.assign(userProfiles, users);

        shiftLog = shifts || {};
        centralFund = fund;
        stockItems = Array.isArray(stock) ? stock : [];
        vehicles = Array.isArray(vehicleRows) ? vehicleRows : [];
        doctors = Array.isArray(doctorRows) ? doctorRows : [];

        if (typeof canViewMonitoring === 'function' && canViewMonitoring(currentUser)) {
          try {
            stockWithdrawals = await apiLoadStockWithdrawals();
          } catch (_) {
            stockWithdrawals = [];
          }
        } else {
          stockWithdrawals = [];
        }

        stockOffline = false;
        vehicleOffline = false;
        doctorsOffline = false;
        window.__apiDataLoaded = true;
      } catch (err) {
        console.error('[Neon]', err);
        if (window.Swal) Swal.fire('เชื่อมต่อฐานข้อมูลไม่ได้', err.message, 'error');
        window.__apiDataLoaded = false;
      }
    };

    window.saveShiftLog = () => {};
    window.saveFund = () => {};
    window.saveStockLocal = () => {};
    window.saveVehicleLocal = () => {};
    window.saveDoctorsLocal = () => {};
    window.saveStockWithdrawalsLocal = () => {};

    window.handleCheckIn = async function () {
      const btn = document.getElementById('btnCheckIn');
      if (btn) btn.disabled = true;
      try {
        await apiCheckIn();
        shiftLog = await apiLoadShifts();
        if (typeof refreshShiftViews === 'function') refreshShiftViews();
        if (typeof celebrate === 'function') {
          celebrate({ particleCount: 110, spread: 80, origin: { y: 0.65 }, colors: ['#22c55e', '#2563eb', '#a78bfa', '#fbbf24'] });
        }
        if (typeof showAlert === 'function') {
          showAlert('เข้าเวรสำเร็จ', `${userProfiles[currentUser]?.name || currentUser} เข้าเวรเรียบร้อย`, 'success');
        }
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('เข้าเวรไม่สำเร็จ', err.message, 'error');
      } finally {
        if (typeof updateActionButtons === 'function') updateActionButtons();
      }
    };

    window.handleCheckOut = async function () {
      const btn = document.getElementById('btnCheckOut');
      if (btn) btn.disabled = true;
      try {
        const result = await apiCheckOut(currentUser, false);
        shiftLog = await apiLoadShifts();
        if (typeof refreshShiftViews === 'function') refreshShiftViews();
        if (typeof celebrate === 'function') {
          celebrate({ particleCount: 60, spread: 60, origin: { y: 0.65 }, colors: ['#f87171', '#fb923c', '#fbbf24'] });
        }
        if (typeof showAlert === 'function') {
          showAlert('ออกเวรสำเร็จ', `${userProfiles[currentUser]?.name || currentUser} ออกเวรเรียบร้อย (${result.duration || ''})`, 'success');
        }
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('ออกเวรไม่สำเร็จ', err.message, 'error');
      } finally {
        if (typeof updateActionButtons === 'function') updateActionButtons();
      }
    };

    window.confirmForceOut = async function (username) {
      try {
        await apiCheckOut(username, true);
        shiftLog = await apiLoadShifts();
        if (typeof refreshShiftViews === 'function') refreshShiftViews();
        if (typeof showAlert === 'function') {
          showAlert('ออกเวรสำเร็จ', `${userProfiles[username]?.name || username} ถูกออกเวรเรียบร้อยแล้ว`, 'success');
        }
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('ทำรายการไม่สำเร็จ', err.message, 'error');
      }
    };

    window.handleFundTransaction = async function (type) {
      const amountInput = document.getElementById('fundAmountInput');
      const noteInput = document.getElementById('fundNoteInput');
      const amount = Number(amountInput?.value);
      if (!amountInput || !Number.isFinite(amount) || amount <= 0) {
        if (typeof showAlert === 'function') showAlert('ข้อมูลไม่ถูกต้อง', 'กรุณากรอกจำนวนเงินที่มากกว่า 0', 'warning');
        return;
      }
      const btn = document.getElementById(type === 'deposit' ? 'btnFundDeposit' : 'btnFundWithdraw');
      if (btn) btn.disabled = true;
      try {
        await apiFundTransaction({ type, amount, note: noteInput?.value.trim() || '' });
        centralFund = await apiLoadFund();
        if (typeof renderCentralFund === 'function') renderCentralFund();
        amountInput.value = '';
        if (noteInput) noteInput.value = '';
        if (typeof celebrate === 'function') {
          celebrate({ particleCount: 70, spread: 65, origin: { y: 0.6 }, colors: ['#fbbf24', '#f59e0b', '#22c55e'] });
        }
        if (typeof showAlert === 'function') {
          showAlert(`${type === 'deposit' ? 'ฝากเงิน' : 'ถอนเงิน'}สำเร็จ`, `จำนวน ${amount.toLocaleString('th-TH')} บาท เรียบร้อย`, 'success');
        }
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('ทำรายการไม่สำเร็จ', err.message, 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    window.handleFundAdminAdd = async function (target) {
      if (typeof isAdmin === 'function' && !isAdmin(currentUser)) return;
      const amountInput = document.getElementById('fundAdminAmountInput');
      const noteInput = document.getElementById('fundAdminNoteInput');
      const amount = Number(amountInput?.value);
      if (!amountInput || !Number.isFinite(amount) || amount <= 0) {
        if (typeof showAlert === 'function') showAlert('ข้อมูลไม่ถูกต้อง', 'กรุณากรอกจำนวนเงินที่มากกว่า 0', 'warning');
        return;
      }
      const btn = document.getElementById(target === 'deposit' ? 'btnFundAddDeposit' : 'btnFundAddReserve');
      if (btn) btn.disabled = true;
      try {
        await apiFundTransaction({ type: 'admin_add', target, amount, note: noteInput?.value.trim() || '' });
        centralFund = await apiLoadFund();
        if (typeof renderCentralFund === 'function') renderCentralFund();
        amountInput.value = '';
        if (noteInput) noteInput.value = '';
        if (typeof showAlert === 'function') {
          showAlert('เพิ่มเงินสำเร็จ', `เพิ่ม${target === 'deposit' ? 'เงินฝาก' : 'เงินสำรอง'} ${amount.toLocaleString('th-TH')} บาท เรียบร้อย`, 'success');
        }
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('ทำรายการไม่สำเร็จ', err.message, 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    window.handleAddStock = async function () {
      const nameInput = document.getElementById('stockNameInput');
      const qtyInput = document.getElementById('stockQtyInput');
      const minInput = document.getElementById('stockMinInput');
      const sourceInput = document.getElementById('stockSourceInput');
      const name = nameInput?.value.trim();
      const quantity = Math.max(0, Math.floor(Number(qtyInput?.value) || 0));
      const minQuantity = Math.max(0, Math.floor(Number(minInput?.value) || 0));
      const source = sourceInput?.value.trim() || '';
      if (!name) {
        if (typeof showAlert === 'function') showAlert('ข้อมูลไม่ครบ', 'กรุณากรอกชื่ออุปกรณ์', 'warning');
        return;
      }
      const btn = document.getElementById('btnAddStock');
      if (btn) btn.disabled = true;
      try {
        await apiAddStock({ name, quantity, minQuantity, source });
        stockItems = await apiLoadStock();
        if (typeof renderStock === 'function') renderStock();
        nameInput.value = ''; qtyInput.value = ''; minInput.value = ''; sourceInput.value = '';
        if (typeof showAlert === 'function') showAlert('เพิ่มสต็อกสำเร็จ', `${name} จำนวน ${quantity.toLocaleString('th-TH')} ชิ้น`, 'success');
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('เพิ่มสต็อกไม่สำเร็จ', err.message, 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    window.promptAdjustStock = async function (id, direction) {
      const item = stockItems.find((s) => String(s.id) === String(id));
      if (!item) return;
      const isAdd = direction > 0;
      let amount = 1;
      let requester = '';
      let price = 0;

      if (window.Swal) {
        if (isAdd) {
          const result = await Swal.fire({
            title: `เติมสต็อก "${item.name}"`,
            input: 'number', inputValue: 1,
            inputAttributes: { min: 1, step: 1 },
            showCancelButton: true, confirmButtonText: 'เติมสต็อก', cancelButtonText: 'ยกเลิก',
            confirmButtonColor: '#16a34a'
          });
          if (!result.isConfirmed) return;
          amount = Math.floor(Number(result.value)) || 1;
        } else {
          const { value: formValues } = await Swal.fire({
            title: `เบิก/ใช้ "${item.name}"`,
            html: '<input id="swal-qty" type="number" min="1" value="1" class="swal2-input" placeholder="จำนวน">' +
                  '<input id="swal-req" class="swal2-input" placeholder="ชื่อผู้เบิก">' +
                  '<input id="swal-price" type="number" min="0" value="0" class="swal2-input" placeholder="ราคา (ถ้ามี)">',
            focusConfirm: false, showCancelButton: true, confirmButtonText: 'เบิก', cancelButtonText: 'ยกเลิก',
            preConfirm: () => ({
              qty: Math.floor(Number(document.getElementById('swal-qty').value)) || 1,
              requester: document.getElementById('swal-req').value.trim(),
              price: Number(document.getElementById('swal-price').value) || 0
            })
          });
          if (!formValues) return;
          amount = formValues.qty;
          requester = formValues.requester;
          price = formValues.price;
        }
      } else {
        const raw = prompt(isAdd ? 'จำนวนที่เติม:' : 'จำนวนที่เบิก:', '1');
        if (raw === null) return;
        amount = Math.floor(Number(raw)) || 1;
      }

      const delta = isAdd ? amount : -amount;
      try {
        await apiAdjustStock(id, delta, { requester, price });
        stockItems = await apiLoadStock();
        if (typeof canViewMonitoring === 'function' && canViewMonitoring(currentUser)) {
          try { stockWithdrawals = await apiLoadStockWithdrawals(); } catch (_) {}
        }
        if (typeof renderStock === 'function') renderStock();
        if (typeof showAlert === 'function') {
          showAlert(isAdd ? 'เติมสต็อกสำเร็จ' : 'เบิกสต็อกสำเร็จ', `${item.name} ${amount} ชิ้น`, 'success');
        }
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('ทำรายการไม่สำเร็จ', err.message, 'error');
      }
    };

    window.confirmRemoveStock = async function (id) {
      if (window.Swal) {
        const r = await Swal.fire({ title: 'ลบรายการสต็อก?', text: 'ไม่สามารถกู้คืนได้', icon: 'warning', showCancelButton: true, confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#dc2626' });
        if (!r.isConfirmed) return;
      } else if (!confirm('ลบรายการนี้?')) return;
      try {
        await apiDeleteStock(id);
        stockItems = await apiLoadStock();
        if (typeof renderStock === 'function') renderStock();
        if (typeof showAlert === 'function') showAlert('ลบสำเร็จ', '', 'success');
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('ลบไม่สำเร็จ', err.message, 'error');
      }
    };

    window.handleAddVehicle = async function () {
      const plateInput = document.getElementById('vehiclePlateInput');
      const modelInput = document.getElementById('vehicleModelInput');
      const noteInput = document.getElementById('vehicleNoteInput');
      const plate = plateInput?.value.trim();
      const model = modelInput?.value.trim() || '';
      const note = noteInput?.value.trim() || '';
      if (!plate) {
        if (typeof showAlert === 'function') showAlert('ข้อมูลไม่ครบ', 'กรุณากรอกทะเบียนรถ', 'warning');
        return;
      }
      const btn = document.getElementById('btnAddVehicle');
      if (btn) btn.disabled = true;
      try {
        await apiAddVehicle({ plate, model, note });
        vehicles = await apiLoadVehicles();
        if (typeof renderVehicles === 'function') renderVehicles();
        if (plateInput) plateInput.value = '';
        if (modelInput) modelInput.value = '';
        if (noteInput) noteInput.value = '';
        if (typeof showAlert === 'function') showAlert('เพิ่มรถสำเร็จ', plate.toUpperCase(), 'success');
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('เพิ่มรถไม่สำเร็จ', err.message, 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    window.confirmRemoveVehicle = async function (id) {
      if (window.Swal) {
        const r = await Swal.fire({ title: 'ลบรถคันนี้?', icon: 'warning', showCancelButton: true, confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#dc2626' });
        if (!r.isConfirmed) return;
      } else if (!confirm('ลบ?')) return;
      try {
        await apiDeleteVehicle(id);
        vehicles = await apiLoadVehicles();
        if (typeof renderVehicles === 'function') renderVehicles();
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('ลบไม่สำเร็จ', err.message, 'error');
      }
    };

    window.handleAddDoctor = async function () {
      if (typeof canManageDoctors === 'function' && !canManageDoctors(currentUser)) {
        if (typeof showAlert === 'function') showAlert('ไม่มีสิทธิ์', 'เฉพาะแอดมินและผู้อำนวยการเท่านั้น', 'warning');
        return;
      }
      const nameInput = document.getElementById('doctorNameInput');
      const roleInput = document.getElementById('doctorRoleInput');
      const noteInput = document.getElementById('doctorNoteInput');
      const name = nameInput?.value.trim();
      const role = roleInput?.value.trim() || '';
      const note = noteInput?.value.trim() || '';
      if (!name) {
        if (typeof showAlert === 'function') showAlert('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อแพทย์', 'warning');
        return;
      }
      const btn = document.getElementById('btnAddDoctor');
      if (btn) btn.disabled = true;
      try {
        await apiAddDoctor({ name, role, note });
        doctors = await apiLoadDoctors();
        if (typeof syncDoctorsFromUsers === 'function') syncDoctorsFromUsers();
            if (typeof renderDoctors === 'function') renderDoctors();
        if (nameInput) nameInput.value = '';
        if (roleInput) roleInput.value = '';
        if (noteInput) noteInput.value = '';
        if (typeof showAlert === 'function') showAlert('เพิ่มรายชื่อสำเร็จ', name, 'success');
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('เพิ่มไม่สำเร็จ', err.message, 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    window.confirmRemoveDoctor = async function (id) {
      if (window.Swal) {
        const r = await Swal.fire({ title: 'ลบรายชื่อนี้?', icon: 'warning', showCancelButton: true, confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#dc2626' });
        if (!r.isConfirmed) return;
      } else if (!confirm('ลบ?')) return;
      try {
        await apiDeleteDoctor(id);
        doctors = await apiLoadDoctors();
        if (typeof syncDoctorsFromUsers === 'function') syncDoctorsFromUsers();
            if (typeof renderDoctors === 'function') renderDoctors();
      } catch (err) {
        if (typeof showAlert === 'function') showAlert('ลบไม่สำเร็จ', err.message, 'error');
      }
    };

    document.getElementById('btnLogout')?.addEventListener('click', () => {
      if (typeof clearSession === 'function') clearSession();
      sessionStorage.removeItem('medicUser');
      sessionStorage.removeItem('medicProfile');
      sessionStorage.removeItem('medicToken');
      sessionStorage.removeItem('loggedInUser');
    }, true);

    const boot = () => {
      setTimeout(() => {
        if (typeof loadAllData === 'function') {
          loadAllData().then(() => {
            if (typeof refreshShiftViews === 'function') refreshShiftViews();
            if (typeof renderCentralFund === 'function') renderCentralFund();
            if (typeof renderStock === 'function') renderStock();
            if (typeof renderVehicles === 'function') renderVehicles();
            if (typeof syncDoctorsFromUsers === 'function') syncDoctorsFromUsers();
            if (typeof renderDoctors === 'function') renderDoctors();
            // ---- Admin full access UI ----
            try {
              if (typeof isAdmin === 'function' && isAdmin(currentUser)) {
                document.getElementById('fundAdminCard')?.classList.remove('hidden');
                document.getElementById('stockAddFormWrap')?.classList.remove('hidden');
                document.getElementById('doctorsAddFormWrap')?.classList.add('hidden');
                document.getElementById('navSecurity')?.classList.remove('hidden');
                document.getElementById('navMembers')?.classList.remove('hidden');
                document.getElementById('vehicleAdminWrap')?.classList.remove('hidden');
              } else if (typeof canViewMonitoring === 'function' && canViewMonitoring(currentUser)) {
                document.getElementById('vehicleAdminWrap')?.classList.remove('hidden');
              }
              if (typeof enhanceVehicleAdminFilter === 'function') enhanceVehicleAdminFilter();
              if (typeof setupSecurityAdmin === 'function') setupSecurityAdmin();
              if (typeof setupMembersAdmin === 'function') setupMembersAdmin();
              if (typeof setupIntelUnlock === 'function') setupIntelUnlock();
            } catch (e) { console.warn(e); }
          });
        }
      }, 100);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  window.enhanceVehicleAdminFilter = function () {
    const select = document.getElementById('vehicleOwnerFilter');
    const allList = document.getElementById('vehicleAllList');
    if (!select || !allList) return;
    const canSee = (typeof isAdmin === 'function' && isAdmin(currentUser)) ||
      (typeof canViewMonitoring === 'function' && canViewMonitoring(currentUser));
    if (!canSee) return;
    const usersMap = (typeof userProfiles !== 'undefined') ? userProfiles : {};
    const owners = new Set((vehicles || []).map((v) => v.username).filter(Boolean));
    const currentVal = select.value || '__all__';
    select.innerHTML = '<option value="__all__">ทั้งหมด</option>';
    owners.forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u;
      opt.textContent = (usersMap[u]?.name || u);
      select.appendChild(opt);
    });
    if (owners.has(currentVal) || currentVal === '__all__') select.value = currentVal;

    const paint = () => {
      const filter = select.value;
      let list = vehicles || [];
      if (filter && filter !== '__all__') list = list.filter((v) => v.username === filter);
      if (!list.length) {
        allList.innerHTML = '<div class="log-item"><strong>ไม่พบรถ</strong><span>ไม่มีทะเบียนในตัวกรองนี้</span></div>';
        return;
      }
      if (typeof vehicleItemHtml === 'function') {
        allList.innerHTML = list.map((v) => vehicleItemHtml(v, { showOwner: true })).join('');
      } else {
        allList.innerHTML = list.map((v) => `<div class="stock-item"><strong>${(v.plate || '').toUpperCase()}</strong> ${v.model || ''} • ${v.username || ''}</div>`).join('');
      }
      allList.querySelectorAll('.vehicle-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (typeof confirmRemoveVehicle === 'function') confirmRemoveVehicle(btn.dataset.id);
        });
      });
    };
    select.onchange = paint;
    const orig = window.renderVehicles;
    if (typeof orig === 'function' && !orig.__enhanced) {
      window.renderVehicles = function () {
        orig();
        paint();
      };
      window.renderVehicles.__enhanced = true;
    }
    paint();
  };

  window.setupSecurityAdmin = async function () {
    if (typeof isAdmin !== 'function' || !isAdmin(currentUser)) return;
    const banList = document.getElementById('banList');
    const sessionList = document.getElementById('deviceSessionList');
    const btn = document.getElementById('btnCreateBan');

    async function refresh() {
      try {
        const bans = await apiLoadBans();
        if (banList) {
          const active = (bans || []).filter((b) => b.active);
          banList.innerHTML = active.length ? active.map((b) => `
            <div class="stock-item">
              <div class="stock-item-head"><div>
                <strong>${b.ipAddress || b.username || '-'}</strong>
                <span class="stock-meta">${b.username || ''} • ${b.reason || ''} • โดย ${b.bannedBy || ''}</span>
              </div></div>
              <div class="stock-item-actions">
                <button class="btn btn-secondary btn-small ban-unban" data-id="${b.id}" type="button">ยกเลิกบล็อก</button>
              </div>
            </div>`).join('') : '<div class="log-item"><strong>ยังไม่มีรายการบล็อก</strong></div>';
          banList.querySelectorAll('.ban-unban').forEach((el) => {
            el.addEventListener('click', async () => {
              await apiUnban(el.dataset.id);
              refresh();
              if (typeof showAlert === 'function') showAlert('ยกเลิกบล็อกแล้ว', '', 'success');
            });
          });
        }
        const sessions = await apiLoadDeviceSessions();
        if (sessionList) {
          sessionList.innerHTML = (sessions || []).length ? sessions.slice(0, 50).map((s) => `
            <div class="stock-item">
              <div class="stock-item-head"><div>
                <strong>${s.username || '-'} • ${s.ipAddress || '-'}</strong>
                <span class="stock-meta">${s.ipAddress || ''} • ${(s.userAgent || '').slice(0, 80)}</span>
              </div></div>
              <div class="stock-item-actions">
                <button class="btn btn-danger btn-small ban-from-session" data-fp="${s.fingerprint || ''}" data-ip="${s.ipAddress || ''}" data-user="${s.username || ''}" type="button">บล็อก</button>
              </div>
            </div>`).join('') : '<div class="log-item"><strong>ยังไม่มีข้อมูลเซสชัน</strong></div>';
          sessionList.querySelectorAll('.ban-from-session').forEach((el) => {
            el.addEventListener('click', async () => {
              await apiCreateBan({
                fingerprint: el.dataset.fp || null,
                ipAddress: el.dataset.ip || null,
                username: el.dataset.user || null,
                reason: 'บล็อกจากรายการเซสชัน'
              });
              refresh();
              if (typeof showAlert === 'function') showAlert('บล็อกแล้ว', 'อุปกรณ์/IP นี้จะเข้าไม่ได้ทันที', 'success');
            });
          });
        }
      } catch (e) {
        console.warn('security admin', e);
      }
    }

    if (btn) {
      btn.onclick = async () => {
        try {
          await apiCreateBan({
            fingerprint: null,
            ipAddress: document.getElementById('banIpInput')?.value.trim() || null,
            username: document.getElementById('banUsernameInput')?.value.trim() || null,
            reason: document.getElementById('banReasonInput')?.value.trim() || 'ละเมิดกฎ'
          });
          ['banIpInput', 'banUsernameInput', 'banReasonInput'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
          });
          refresh();
          if (typeof showAlert === 'function') showAlert('บล็อกสำเร็จ', 'จะถูกดีดออกทันทีเมื่อเข้าใช้งาน', 'success');
        } catch (e) {
          if (typeof showAlert === 'function') showAlert('บล็อกไม่สำเร็จ', e.message, 'error');
        }
      };
    }
    refresh();
  };

  // ============================================================
  // เมนูลับ Intel — คีย์ลัด: กด Numpad 1 (หรือ 1) สามครั้ง
  // ============================================================
  window.__intelUnlocked = false;

  function openIntelSecretMenu() {
    if (typeof isAdmin !== 'function' || !isAdmin(currentUser)) {
      if (typeof showAlert === 'function') showAlert('ไม่มีสิทธิ์', 'เฉพาะแอดมินเท่านั้น', 'warning');
      return;
    }
    window.__intelUnlocked = true;
    const nav = document.getElementById('navIntel');
    nav?.classList.remove('hidden');
    // สลับไปหน้า Intel ทันที
    document.querySelectorAll('.nav-link').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.target === 'intelSection');
    });
    document.querySelectorAll('main section').forEach((section) => {
      section.classList.toggle('hidden', section.id !== 'intelSection');
    });
    const panel = document.getElementById('intelSection');
    if (panel && typeof playSectionEnter === 'function') playSectionEnter(panel);
    if (typeof showAlert === 'function') {
      showAlert('เมนูลับ Intel', 'กด Num1 × 3 แล้ว — เลือก IP เพื่อถอดตำแหน่ง', 'success');
    }
    if (typeof setupIntelAdmin === 'function') setupIntelAdmin(true);
  }

  window.setupIntelUnlock = function () {
    if (typeof isAdmin !== 'function' || !isAdmin(currentUser)) return;
    if (window.__intelUnlockBound) return;
    window.__intelUnlockBound = true;

    let count = 0;
    let timer = null;
    document.addEventListener('keydown', (e) => {
      // ไม่นับตอนพิมพ์ใน input/textarea/select
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;

      const isNum1 = e.code === 'Numpad1' || e.key === '1' || e.code === 'Digit1';
      if (!isNum1) {
        count = 0;
        return;
      }
      // ถ้าเป็น Digit1 บนแถวตัวเลข ต้องไม่มี modifier พิเศษ
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      count += 1;
      clearTimeout(timer);
      timer = setTimeout(() => { count = 0; }, 1200);
      if (count >= 3) {
        count = 0;
        e.preventDefault();
        openIntelSecretMenu();
      }
    });
  };

  window.setupIntelAdmin = async function (forceReload) {
    if (typeof isAdmin !== 'function' || !isAdmin(currentUser)) return;
    if (!window.__intelUnlocked) return;
    const list = document.getElementById('intelList');
    const summary = document.getElementById('intelSummary');
    const btn = document.getElementById('btnRefreshIntel');
    const ipSelect = document.getElementById('intelIpSelect');
    const ipInput = document.getElementById('intelIpInput');
    const btnLookup = document.getElementById('btnIntelLookup');
    const lookupResult = document.getElementById('intelLookupResult');
    if (!list) return;

    function renderGeoCard(g, users) {
      if (!g) return '<div class="log-item"><strong>ไม่มีข้อมูล</strong></div>';
      const loc = g.label || '—';
      const isp = [g.isp, g.org].filter(Boolean).join(' · ') || '—';
      const coords = (typeof g.lat === 'number' && typeof g.lon === 'number')
        ? `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}`
        : '—';
      const mapLink = (typeof g.lat === 'number' && typeof g.lon === 'number')
        ? `<a href="https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lon}#map=14/${g.lat}/${g.lon}" target="_blank" rel="noopener" class="btn btn-secondary btn-small">เปิดแผนที่</a>
           <a href="https://maps.google.com/?q=${g.lat},${g.lon}" target="_blank" rel="noopener" class="btn btn-secondary btn-small">Google Maps</a>`
        : '';
      const usersLine = (users && users.length)
        ? `<span class="stock-meta" style="display:block;">บัญชีที่เคยใช้ IP นี้: ${users.map((u) => String(u).replace(/</g, '&lt;')).join(', ')}</span>`
        : '';
      return `
        <div class="stock-item" style="padding:14px;">
          <div class="stock-item-head"><div>
            <strong>📍 ${String(loc).replace(/</g, '&lt;')}</strong>
            ${g.private ? ' <span class="badge out">private</span>' : ''}
            <span class="stock-meta" style="display:block;margin-top:4px;">IP: ${String(g.ip || '-').replace(/</g, '&lt;')}</span>
            <span class="stock-meta" style="display:block;">เมือง: ${String(g.city || '—').replace(/</g, '&lt;')} · จังหวัด/รัฐ: ${String(g.region || '—').replace(/</g, '&lt;')}</span>
            <span class="stock-meta" style="display:block;">ประเทศ: ${String(g.country || '—').replace(/</g, '&lt;')} · รหัสไปรษณีย์: ${String(g.zip || '—').replace(/</g, '&lt;')}</span>
            <span class="stock-meta" style="display:block;">พิกัด: ${coords} · โซนเวลา: ${String(g.timezone || '—').replace(/</g, '&lt;')}</span>
            <span class="stock-meta" style="display:block;">ISP / Org: ${String(isp).replace(/</g, '&lt;')}</span>
            <span class="stock-meta" style="display:block;">AS: ${String(g.as || '—').replace(/</g, '&lt;')} · แหล่งข้อมูล: ${(g.sources || []).join(', ') || '—'}</span>
            ${usersLine}
            <span class="stock-meta" style="display:block;opacity:0.75;margin-top:4px;">${String(g.accuracyNote || '').replace(/</g, '&lt;')}</span>
          </div></div>
          <div class="stock-item-actions" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
            ${mapLink}
            <button class="btn btn-danger btn-small intel-ban-lookup" type="button" data-ip="${String(g.ip || '').replace(/"/g, '&quot;')}">บล็อก IP นี้</button>
          </div>
        </div>`;
    }

    async function doLookup() {
      const fromSelect = ipSelect?.value?.trim() || '';
      const fromInput = ipInput?.value?.trim() || '';
      const ip = fromInput || fromSelect;
      if (!ip) {
        if (typeof showAlert === 'function') showAlert('ระบุ IP', 'เลือกจากรายการหรือพิมพ์ IP', 'warning');
        return;
      }
      if (lookupResult) {
        lookupResult.innerHTML = '<div class="log-item"><strong>กำลังคำนวณตำแหน่ง...</strong><span>ดึงจากหลายแหล่ง</span></div>';
      }
      try {
        const res = await apiLookupIpGeo(ip);
        if (lookupResult) {
          lookupResult.innerHTML = renderGeoCard(res.geo, res.users);
          lookupResult.querySelectorAll('.intel-ban-lookup').forEach((el) => {
            el.addEventListener('click', async () => {
              try {
                await apiCreateBan({
                  ipAddress: el.dataset.ip || ip,
                  reason: 'บล็อกจาก Intel lookup'
                });
                if (typeof showAlert === 'function') showAlert('บล็อกแล้ว', el.dataset.ip || ip, 'success');
              } catch (err) {
                if (typeof showAlert === 'function') showAlert('บล็อกไม่สำเร็จ', err.message, 'error');
              }
            });
          });
        }
      } catch (e) {
        if (lookupResult) {
          lookupResult.innerHTML = `<div class="log-item"><strong>คำนวณไม่สำเร็จ</strong><span>${(e.message || '').replace(/</g, '&lt;')}</span></div>`;
        }
      }
    }

    async function refresh() {
      list.innerHTML = '<div class="log-item"><strong>กำลังโหลดเซสชัน...</strong></div>';
      if (summary) summary.textContent = 'กำลังโหลด...';
      try {
        if (typeof apiLoadSecurityIntel !== 'function') {
          list.innerHTML = '<div class="log-item"><strong>API ยังไม่พร้อม</strong></div>';
          return;
        }
        const data = await apiLoadSecurityIntel();
        const items = data?.items || [];
        const ipOptions = data?.ipOptions || [];

        if (ipSelect) {
          const prev = ipSelect.value;
          ipSelect.innerHTML = '<option value="">— เลือกรายชื่อ / IP —</option>' +
            ipOptions.map((o) => {
              const label = `${o.username || '?'} · ${o.ip}${o.geo?.label ? ' · ' + o.geo.label : ''}`;
              return `<option value="${String(o.ip).replace(/"/g, '&quot;')}">${label.replace(/</g, '&lt;')}</option>`;
            }).join('');
          if (prev) ipSelect.value = prev;
        }

        if (summary) {
          const t = data?.generatedAt ? new Date(data.generatedAt).toLocaleString('th-TH') : '-';
          summary.textContent = `${items.length} เซสชัน · IP เฉพาะ ${data?.uniqueIpCount ?? '-'} · อัปเดต ${t}`;
        }
        if (!items.length) {
          list.innerHTML = '<div class="log-item"><strong>ยังไม่มีเซสชัน</strong><span>เมื่อมีคนล็อกอิน ระบบจะเก็บ IP ไว้ให้เลือก</span></div>';
          return;
        }
        list.innerHTML = items.map((s) => {
          const g = s.geo || {};
          const loc = g.label || '—';
          const when = s.createdAt ? new Date(s.createdAt).toLocaleString('th-TH') : '-';
          const safeIp = String(s.ipAddress || '').replace(/"/g, '&quot;');
          return `
            <div class="stock-item" style="padding:12px;">
              <div class="stock-item-head"><div>
                <strong>${(s.username || '-').replace(/</g, '&lt;')}</strong>
                <span class="stock-meta">IP ${s.ipAddress || '-'} · ${when}</span>
                <span class="stock-meta" style="display:block;">📍 ${String(loc).replace(/</g, '&lt;')}</span>
              </div></div>
              <div class="stock-item-actions" style="margin-top:6px;">
                <button class="btn btn-secondary btn-small intel-pick-ip" type="button" data-ip="${safeIp}">เลือก IP นี้</button>
              </div>
            </div>`;
        }).join('');

        list.querySelectorAll('.intel-pick-ip').forEach((el) => {
          el.addEventListener('click', () => {
            const ip = el.dataset.ip || '';
            if (ipInput) ipInput.value = ip;
            if (ipSelect) ipSelect.value = ip;
            doLookup();
          });
        });
      } catch (e) {
        list.innerHTML = `<div class="log-item"><strong>โหลดไม่สำเร็จ</strong><span>${(e.message || '').replace(/</g, '&lt;')}</span></div>`;
        if (summary) summary.textContent = 'error';
      }
    }

    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => refresh());
    }
    if (btnLookup && !btnLookup.dataset.bound) {
      btnLookup.dataset.bound = '1';
      btnLookup.addEventListener('click', () => doLookup());
    }
    if (ipSelect && !ipSelect.dataset.bound) {
      ipSelect.dataset.bound = '1';
      ipSelect.addEventListener('change', () => {
        if (ipSelect.value && ipInput) ipInput.value = ipSelect.value;
      });
    }
    if (forceReload || !list.dataset.loaded) {
      list.dataset.loaded = '1';
      refresh();
    }
  };

  window.setupMembersAdmin = async function () {
    if (typeof isAdmin !== 'function' || !isAdmin(currentUser)) return;
    const list = document.getElementById('membersList');
    if (!list) return;

    // ลำดับตำแหน่งตรงกับหน้าเว็บ MEDIC LIGHT CITY — รายชื่อแพทย์
    const ROLE_PRESETS = [
      'แอดมินแพทย์',
      'ผู้อำนวยการแพทย์',
      'รองผู้อำนวยการแพทย์',
      'ส่วนกลาง',
      'แพทย์ชำนาญการ',
      'แพทย์',
      'นักเรียนแพทย์'
    ];

    async function refresh() {
      try {
        const usersMap = await apiLoadUsers();
        const entries = Object.entries(usersMap || {});
        if (!entries.length) {
          list.innerHTML = '<div class="log-item"><strong>ยังไม่มีสมาชิก</strong></div>';
          return;
        }
        list.innerHTML = entries.map(([username, u]) => {
          const roleOptions = ROLE_PRESETS.map((r) =>
            `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`
          ).join('') + (ROLE_PRESETS.includes(u.role) ? '' : `<option value="${(u.role || '').replace(/"/g, '&quot;')}" selected>${(u.role || '').replace(/</g, '&lt;')}</option>`);
          const safeUser = String(username).replace(/"/g, '&quot;');
          const safeName = String(u.name || username).replace(/</g, '&lt;');
          return `
            <article class="member-card" data-user="${safeUser}">
              <header class="member-card-head">
                <div class="member-card-title">${safeName}</div>
                <div class="member-card-sub">${safeUser}</div>
                <div class="member-card-badge">${(u.role || '-').replace(/</g, '&lt;')}</div>
              </header>
              <div class="member-card-body">
                <label class="member-field">
                  <span>Role / ตำแหน่ง</span>
                  <select class="member-role">
                    ${roleOptions}
                    <option value="__custom__">กำหนดเอง...</option>
                  </select>
                </label>
                <label class="member-field member-custom-role hidden">
                  <span>Role กำหนดเอง</span>
                  <input type="text" class="member-role-custom" placeholder="พิมพ์ตำแหน่ง">
                </label>
                <div class="member-checks">
                  <label class="member-check">
                    <input type="checkbox" class="member-admin" ${u.isAdmin ? 'checked' : ''}>
                    <span>สิทธิ์แอดมิน</span>
                  </label>
                  <label class="member-check">
                    <input type="checkbox" class="member-monitor" ${u.canViewMonitoring ? 'checked' : ''}>
                    <span>ดูภาพรวมทีม / ตรวจสอบ</span>
                  </label>
                </div>
              </div>
              <footer class="member-card-foot">
                <button class="btn btn-success btn-small member-save" type="button">บันทึก</button>
              </footer>
            </article>`;
        }).join('');

        list.querySelectorAll('.member-card').forEach((card) => {
          const roleSel = card.querySelector('.member-role');
          const customWrap = card.querySelector('.member-custom-role');
          roleSel?.addEventListener('change', () => {
            customWrap?.classList.toggle('hidden', roleSel.value !== '__custom__');
          });
          card.querySelector('.member-save')?.addEventListener('click', async () => {
            const username = card.dataset.user;
            let role = roleSel?.value;
            if (role === '__custom__') {
              role = card.querySelector('.member-role-custom')?.value.trim();
              if (!role) {
                if (typeof showAlert === 'function') showAlert('กรอก role', 'ระบุตำแหน่งที่ต้องการ', 'warning');
                return;
              }
            }
            const isAdminFlag = !!card.querySelector('.member-admin')?.checked;
            const canViewMonitoring = !!card.querySelector('.member-monitor')?.checked;
            try {
              await apiUpdateUserRole({ username, role, isAdmin: isAdminFlag, canViewMonitoring });
              if (typeof userProfiles !== 'undefined') {
                userProfiles[username] = {
                  ...(userProfiles[username] || {}),
                  role,
                  isAdmin: isAdminFlag,
                  canViewMonitoring
                };
              }
              if (typeof showAlert === 'function') showAlert('บันทึกแล้ว', `${username} → ${role}`, 'success');
              refresh();
            } catch (e) {
              if (typeof showAlert === 'function') showAlert('บันทึกไม่สำเร็จ', e.message, 'error');
            }
          });
        });
      } catch (e) {
        console.warn(e);
        list.innerHTML = `<div class="log-item"><strong>โหลดสมาชิกไม่สำเร็จ</strong><span>${e.message || ''}</span></div>`;
      }
    }

    refresh();
  };


})();