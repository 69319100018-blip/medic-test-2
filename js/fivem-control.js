/* Optional FiveM admin panel. Load only after the FiveM bridge API is activated. */
(function () {
    'use strict';

    const API = (path, options = {}) => {
        if (typeof window.api !== 'function') {
            throw new Error('API client is not available');
        }
        return window.api(path, options);
    };

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);

    const isFresh = (value) => {
        const time = Date.parse(value || '');
        return Number.isFinite(time) && Date.now() - time <= 90000 && Date.now() >= time;
    };

    function uuidV4() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        const bytes = window.crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    }

    function setNotice(root, message, isError = false) {
        const notice = root.querySelector('#fivemControlNotice');
        if (!notice) return;
        notice.textContent = message || '';
        notice.classList.toggle('is-error', Boolean(isError));
    }

    function renderServers(root, servers) {
        const list = root.querySelector('#fivemServerList');
        if (!list) return;
        if (!servers.length) {
            list.innerHTML = '<div class="fivem-empty">ยังไม่มี Server ที่ลงทะเบียนในระบบ</div>';
            return;
        }
        list.innerHTML = servers.map((server) => {
            const online = server.enabled && isFresh(server.lastHeartbeatAt);
            const adapterReady = online && server.adapterReady === true;
            const status = !server.enabled ? 'ปิดการเชื่อมต่อ'
                : (!online ? 'ไม่ได้รับ Heartbeat' : (adapterReady ? 'พร้อมทำงาน' : 'รอ Framework Adapter'));
            return `
                <article class="fivem-server-card">
                    <div class="fivem-server-top">
                        <strong>${escapeHtml(server.displayName || server.serverId)}</strong>
                        <span class="fivem-state ${adapterReady ? 'is-ready' : (online ? 'is-waiting' : 'is-offline')}">${escapeHtml(status)}</span>
                    </div>
                    <div class="fivem-server-meta">
                        <span>Server: ${escapeHtml(server.serverId)}</span>
                        <span>Framework: ${escapeHtml(server.framework || 'unknown')}</span>
                        <span>ผู้เล่นออนไลน์: ${Number(server.onlinePlayers) || 0}</span>
                        <span>Resource: ${escapeHtml(server.resourceVersion || '-')}</span>
                    </div>
                </article>`;
        }).join('');
    }

    function renderPlayers(root, players, servers) {
        const list = root.querySelector('#fivemPlayerList');
        if (!list) return;
        if (!players.length) {
            list.innerHTML = '<div class="fivem-empty">ยังไม่มีข้อมูลแพทย์ที่ผูกกับบัญชี Medic</div>';
            return;
        }
        const serverMap = new Map(servers.map((server) => [server.serverId, server]));
        list.innerHTML = players.map((player) => {
            const server = serverMap.get(player.serverId);
            const connected = server?.enabled && isFresh(server.lastHeartbeatAt);
            const actionable = connected && server?.adapterReady === true &&
                player.isOnline === true && player.isOnDuty === true;
            const status = !connected ? 'ไม่เชื่อมต่อ'
                : (!player.isOnline ? 'ออฟไลน์' : (player.isOnDuty ? 'กำลังเข้าเวร' : 'ออนไลน์ · นอกเวร'));
            const vehicle = [player.vehiclePlate, player.vehicleModel].filter(Boolean).join(' · ') || 'ไม่ได้รายงานรถ';
            return `
                <article class="fivem-player-card">
                    <div class="fivem-player-identity">
                        <strong>${escapeHtml(player.name || player.username)}</strong>
                        <span>${escapeHtml(player.username)} · ${escapeHtml(player.role || '-')}</span>
                    </div>
                    <div class="fivem-player-state">
                        <span class="fivem-state ${player.isOnDuty ? 'is-ready' : 'is-waiting'}">${escapeHtml(status)}</span>
                        <small>${escapeHtml(vehicle)}</small>
                    </div>
                    <div class="fivem-player-action">
                        <button type="button" class="btn btn-danger btn-small"
                            data-fivem-force-off-duty="${escapeHtml(player.username)}"
                            ${actionable ? '' : 'disabled'}>
                            บังคับออกเวร
                        </button>
                    </div>
                </article>`;
        }).join('');
    }

    async function refresh(root) {
        const button = root.querySelector('#btnRefreshFiveM');
        if (button) button.disabled = true;
        setNotice(root, 'กำลังโหลดสถานะ FiveM...');
        try {
            const data = await API('/fivem/admin/overview');
            const servers = Array.isArray(data.servers) ? data.servers : [];
            const players = Array.isArray(data.players) ? data.players : [];
            renderServers(root, servers);
            renderPlayers(root, players, servers);
            setNotice(root, 'อัปเดตข้อมูลแล้ว · ' + new Date().toLocaleTimeString('th-TH'));
        } catch (error) {
            setNotice(root, error.message || 'ไม่สามารถโหลดสถานะ FiveM ได้', true);
        } finally {
            if (button) button.disabled = false;
        }
    }

    async function requestForceOffDuty(root, username) {
        let reason = '';
        if (window.Swal) {
            const result = await window.Swal.fire({
                icon: 'warning',
                title: 'ยืนยันบังคับออกเวร',
                text: 'คำสั่งนี้จะถอนสถานะเข้าเวรและให้ FiveM Adapter จัดการรถหน่วยงานตามกติกา ไม่ได้ปลดยศถาวร',
                input: 'textarea',
                inputLabel: 'เหตุผลที่ตรวจสอบแล้ว',
                inputPlaceholder: 'ระบุเหตุผลอย่างน้อย 8 ตัวอักษร',
                inputValidator: (value) => String(value || '').trim().length < 8
                    ? 'กรุณาระบุเหตุผลอย่างน้อย 8 ตัวอักษร' : undefined,
                showCancelButton: true,
                confirmButtonText: 'ส่งคำสั่ง',
                cancelButtonText: 'ยกเลิก'
            });
            if (!result.isConfirmed) return;
            reason = String(result.value || '').trim();
        } else {
            reason = String(window.prompt('เหตุผลที่ตรวจสอบแล้ว (อย่างน้อย 8 ตัวอักษร)') || '').trim();
            if (reason.length < 8 || !window.confirm('ยืนยันบังคับออกเวรของ ' + username + '?')) return;
        }

        try {
            const response = await API('/fivem/admin/commands', {
                method: 'POST',
                headers: { 'Idempotency-Key': uuidV4() },
                body: { username, commandType: 'force_off_duty', reason }
            });
            setNotice(root, 'ส่งคำสั่งเข้าคิวแล้ว รอ FiveM Server ยืนยันผล (ID: ' + response.id + ')');
            await refresh(root);
        } catch (error) {
            setNotice(root, error.message || 'ส่งคำสั่งไม่สำเร็จ', true);
        }
    }

    async function savePlayerLink(root, form) {
        const values = Object.fromEntries(new FormData(form).entries());
        try {
            await API('/fivem/admin/player-links', {
                method: 'POST',
                body: {
                    serverId: String(values.serverId || '').trim(),
                    username: String(values.username || '').trim(),
                    identifierType: String(values.identifierType || '').trim(),
                    identifier: String(values.identifier || '').trim()
                }
            });
            form.reset();
            setNotice(root, 'บันทึกการผูกบัญชี FiveM สำเร็จ');
            await refresh(root);
        } catch (error) {
            setNotice(root, error.message || 'ผูกบัญชีไม่สำเร็จ', true);
        }
    }

    function init(root) {
        if (!root || root.dataset.fivemControlReady === '1') return;
        root.dataset.fivemControlReady = '1';
        root.querySelector('#btnRefreshFiveM')?.addEventListener('click', () => refresh(root));
        root.querySelector('#fivemPlayerLinkForm')?.addEventListener('submit', (event) => {
            event.preventDefault();
            savePlayerLink(root, event.currentTarget);
        });
        root.querySelector('#fivemPlayerList')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-fivem-force-off-duty]');
            if (!button || button.disabled) return;
            requestForceOffDuty(root, button.dataset.fivemForceOffDuty);
        });
        refresh(root);
    }

    window.MedicFiveMControl = { init, refresh };
})();
