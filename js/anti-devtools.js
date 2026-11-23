/**
 * ป้องกัน DevTools + รายงานเหตุการณ์ความปลอดภัย
 * ถ้าถูกแบนหรือละเมิดรุนแรง จะดีดออกจากระบบ
 */
(function () {
  'use strict';

  const THRESHOLD = 160;
  let reported = false;
  let checkTimer = null;

  function isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  function fp() {
    if (typeof getDeviceFingerprint === 'function') return getDeviceFingerprint();
    return sessionStorage.getItem('medicFp') || 'fp_unknown';
  }

  function hardKick(message) {
    try {
      sessionStorage.clear();
    } catch (_) {}
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0b1220;color:#e2e8f0;font-family:sans-serif;text-align:center;padding:24px;"><div><h1 style="margin:0 0 8px;font-size:1.4rem;">การเข้าถึงถูกระงับ</h1><p style="opacity:.8;margin:0;">' +
      (message || 'ตรวจพบการใช้งานผิดกฎ') + '</p></div></div>';
  }

  async function report(eventType, detail) {
    if (reported && eventType === 'devtools_detected') return;
    reported = true;
    try {
      if (typeof apiSecurityEvent === 'function' && sessionStorage.getItem('medicToken')) {
        const res = await apiSecurityEvent({
          eventType,
          fingerprint: fp(),
          detail: detail || ''
        });
        if (res && res.banned) {
          hardKick(detail || 'ถูกบล็อกเนื่องจากละเมิดกฎ');
          return;
        }
      }
    } catch (_) {}
    // soft block UI for devtools
    if (eventType === 'devtools_detected') {
      hardKick('ตรวจพบเครื่องมือนักพัฒนา (DevTools) — ปิดแล้วรีเฟรชเพื่อใช้งานต่อ');
    }
  }

  function detectBySize() {
    const widthDiff = window.outerWidth - window.innerWidth > THRESHOLD;
    const heightDiff = window.outerHeight - window.innerHeight > THRESHOLD;
    return widthDiff || heightDiff;
  }

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    return false;
  });

  document.addEventListener('keydown', (e) => {
    const key = e.key || '';
    const code = e.keyCode || e.which;
    if (code === 123 || key === 'F12') {
      e.preventDefault();
      report('devtools_detected', 'F12');
      return false;
    }
    if (e.ctrlKey && e.shiftKey && ['I', 'J', 'C', 'i', 'j', 'c'].includes(key)) {
      e.preventDefault();
      report('devtools_detected', 'Ctrl+Shift+' + key);
      return false;
    }
    if (e.ctrlKey && (key === 'u' || key === 'U')) {
      e.preventDefault();
      return false;
    }
    if (e.ctrlKey && (key === 's' || key === 'S')) {
      e.preventDefault();
      return false;
    }
    if (e.metaKey && e.altKey && ['I', 'i', 'J', 'j', 'C', 'c'].includes(key)) {
      e.preventDefault();
      report('devtools_detected', 'Meta+Alt+' + key);
      return false;
    }
  }, true);

  if (!isMobile()) {
    checkTimer = setInterval(() => {
      if (detectBySize()) report('devtools_detected', 'window_size');
    }, 1000);
  }

  setInterval(() => {
    const start = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    if (performance.now() - start > 120) {
      report('devtools_detected', 'debugger_trap');
    }
  }, 2500);

  document.addEventListener('selectstart', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA'].includes(tag) || e.target.isContentEditable) return;
    e.preventDefault();
  });

  // ตรวจแบนก่อนเข้าหน้า
  async function precheck() {
    try {
      const fingerprint = fp();
      sessionStorage.setItem('medicFp', fingerprint);
      if (typeof apiSecurityCheck === 'function') {
        const r = await apiSecurityCheck(fingerprint);
        if (r && r.banned) {
          hardKick(r.reason || 'อุปกรณ์หรือ IP นี้ถูกระงับ');
        }
      }
    } catch (err) {
      if (String(err.message || '').includes('ระงับ') || String(err.message || '').includes('banned')) {
        hardKick(err.message);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', precheck);
  } else {
    precheck();
  }

  window.addEventListener('beforeunload', () => {
    if (checkTimer) clearInterval(checkTimer);
  });

  // export for other scripts
  window.__medicHardKick = hardKick;
  window.__medicReportSecurity = report;
})();
