(function () {
  'use strict';

  // เล่นวิดีโอพื้นหลังบนหน้าสมัคร
  const video = document.getElementById('bgVideo');
  const bgImage = document.getElementById('loginBgImage');
  if (video) {
    video.style.display = '';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    const tryPlay = () => video.play().then(() => {
      if (bgImage) bgImage.classList.add('is-hidden');
    }).catch(() => {});
    tryPlay();
    video.addEventListener('playing', () => {
      if (bgImage) bgImage.classList.add('is-hidden');
    });
    document.addEventListener('click', tryPlay, { once: true });
  }


  // บังคับแสดงฟอร์มสมัครทันที (ไม่พึ่ง mouse-proximity ของหน้า login)
  document.documentElement.style.setProperty('--focus', '1');
  const page = document.getElementById('loginPage');
  if (page) page.style.setProperty('--focus', '1');
  const card = document.getElementById('loginCard');
  if (card) {
    card.classList.remove('is-faded');
    card.style.opacity = '1';
    card.style.filter = 'none';
    card.style.transform = 'none';
    card.style.pointerEvents = 'auto';
  }

  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const form = document.getElementById('registerForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = (document.getElementById('regUsername')?.value || '').trim().toLowerCase();
    const displayName = (document.getElementById('regDisplayName')?.value || '').trim();
    const password = document.getElementById('regPassword')?.value || '';
    const password2 = document.getElementById('regPassword2')?.value || '';
    const btn = document.getElementById('btnRegister');

    if (!username || !displayName || !password) {
      if (window.Swal) Swal.fire('ข้อมูลไม่ครบ', 'กรุณากรอกให้ครบทุกช่อง', 'warning');
      return;
    }
    if (password.length < 4) {
      if (window.Swal) Swal.fire('รหัสผ่านสั้นเกินไป', 'อย่างน้อย 4 ตัวอักษร', 'warning');
      return;
    }
    if (password !== password2) {
      if (window.Swal) Swal.fire('รหัสผ่านไม่ตรงกัน', 'กรุณาตรวจสอบอีกครั้ง', 'warning');
      return;
    }

    if (btn) btn.disabled = true;
    try {
      if (typeof apiRegister !== 'function') {
        throw new Error('ไม่พบ apiRegister — ตรวจว่าโหลด js/api-client.js แล้ว');
      }
      await apiRegister({ username, displayName, password });
      if (window.Swal) {
        await Swal.fire({
          icon: 'success',
          title: 'สมัครสำเร็จ',
          text: 'รอแอดมินปรับตำแหน่ง/role ได้ตามต้องการ — เข้าสู่ระบบได้เลย',
          confirmButtonText: 'ไปหน้าเข้าสู่ระบบ'
        });
      }
      window.location.href = 'index.html';
    } catch (err) {
      if (window.Swal) Swal.fire('สมัครไม่สำเร็จ', err.message || 'ลองใหม่', 'error');
      else alert(err.message || 'สมัครไม่สำเร็จ');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
})();
