/**
 * storage.js — Secure, scoped browser storage manager for Mini Quiz Classroom.
 * Enforces account isolation, room isolation, and session boundaries.
 * Prevents account cross-contamination on shared browsers.
 */
function getUserStorageKey(baseKey, username) {
  return `${baseKey}_${String(username || 'anonymous').toLowerCase()}`;
}
window.getUserStorageKey = getUserStorageKey;

(function () {
  function sanitize(str) {
    return String(str || '').toLowerCase().trim().replace(/[^a-z0-9_]/g, '_');
  }

  const MQC_Storage = {
    // ═══════════════════════════════════════════════════════════════════════════
    // 1. GLOBAL BROWSER STORAGE (Theme, UI preferences, shared non-sensitive data)
    // ═══════════════════════════════════════════════════════════════════════════
    getGlobal(key, defaultValue = null) {
      try {
        const raw = localStorage.getItem(`mqc_global_${key}`) || (key === 'dark' ? localStorage.getItem('mqc-dark') : null);
        if (raw === null) return defaultValue;
        try { return JSON.parse(raw); } catch (e) { return raw; }
      } catch (e) {
        return defaultValue;
      }
    },

    setGlobal(key, value) {
      try {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        localStorage.setItem(`mqc_global_${key}`, serialized);
        if (key === 'dark') {
          localStorage.setItem('mqc-dark', value === '1' || value === true ? '1' : '0');
        }
      } catch (e) {}
    },

    removeGlobal(key) {
      try {
        localStorage.removeItem(`mqc_global_${key}`);
        if (key === 'dark') localStorage.removeItem('mqc-dark');
      } catch (e) {}
    },

    // ═══════════════════════════════════════════════════════════════════════════
    // 2. ACCOUNT-SCOPED STORAGE (Quiz cache, personal drafts, user dashboard)
    // ═══════════════════════════════════════════════════════════════════════════
    getUserKey(key, username) {
      return getUserStorageKey(key, username);
    },

    getUser(key, username, defaultValue = null) {
      if (!username) return defaultValue;
      try {
        const fullKey = this.getUserKey(key, username);
        const raw = localStorage.getItem(fullKey);
        if (raw === null) return defaultValue;
        try { return JSON.parse(raw); } catch (e) { return raw; }
      } catch (e) {
        return defaultValue;
      }
    },

    setUser(key, username, value) {
      if (!username) return;
      try {
        const fullKey = this.getUserKey(key, username);
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        localStorage.setItem(fullKey, serialized);
      } catch (e) {}
    },

    removeUser(key, username) {
      if (!username) return;
      try {
        localStorage.removeItem(this.getUserKey(key, username));
      } catch (e) {}
    },

    clearUser(username) {
      if (!username) return;
      try {
        const u = String(username).toLowerCase();
        // Clear specific scoped keys
        localStorage.removeItem(`mqc_custom_exams_${u}`);
        localStorage.removeItem(`mqc_created_rooms_${u}`);
        localStorage.removeItem(`mqc_custom_rooms_${u}`);
        localStorage.removeItem(`mqc_dashboard_${u}`);

        const prefix1 = `mqc_user_${u}_`;
        const toDelete = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith(prefix1) || k.endsWith(`_${u}`))) {
            toDelete.push(k);
          }
        }
        toDelete.forEach(k => localStorage.removeItem(k));
      } catch (e) {}
    },

    // ═══════════════════════════════════════════════════════════════════════════
    // 3. ROOM-SCOPED STORAGE (Room ephemeral status, transient pin cache)
    // ═══════════════════════════════════════════════════════════════════════════
    getRoomKey(key, pin) {
      const p = sanitize(pin || 'general');
      return `mqc_room_${p}_${key}`;
    },

    getRoom(key, pin, defaultValue = null) {
      if (!pin) return defaultValue;
      try {
        const fullKey = this.getRoomKey(key, pin);
        const raw = localStorage.getItem(fullKey);
        if (raw === null) return defaultValue;
        try { return JSON.parse(raw); } catch (e) { return raw; }
      } catch (e) {
        return defaultValue;
      }
    },

    setRoom(key, pin, value) {
      if (!pin) return;
      try {
        const fullKey = this.getRoomKey(key, pin);
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        localStorage.setItem(fullKey, serialized);
      } catch (e) {}
    },

    removeRoom(key, pin) {
      if (!pin) return;
      try {
        localStorage.removeItem(this.getRoomKey(key, pin));
      } catch (e) {}
    },

    clearRoom(pin) {
      if (!pin) return;
      try {
        const prefix = `mqc_room_${sanitize(pin)}_`;
        const toDelete = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix)) {
            toDelete.push(k);
          }
        }
        toDelete.forEach(k => localStorage.removeItem(k));
      } catch (e) {}
    },

    // ═══════════════════════════════════════════════════════════════════════════
    // 4. SESSION-SCOPED STORAGE (Player token, secret auth per tab, temporary test state)
    // ═══════════════════════════════════════════════════════════════════════════
    getSession(key, defaultValue = null) {
      try {
        const raw = sessionStorage.getItem(`mqc_sess_${key}`);
        if (raw === null) return defaultValue;
        try { return JSON.parse(raw); } catch (e) { return raw; }
      } catch (e) {
        return defaultValue;
      }
    },

    setSession(key, value) {
      try {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        sessionStorage.setItem(`mqc_sess_${key}`, serialized);
      } catch (e) {}
    },

    removeSession(key) {
      try {
        sessionStorage.removeItem(`mqc_sess_${key}`);
      } catch (e) {}
    },

    // Xóa các legacy key không có scope để tránh rò rỉ dữ liệu giữa các tài khoản
    purgeLegacyUnscopedKeys() {
      try {
        const legacyKeys = [
          'mqc_custom_exams',
          'mqc_created_rooms',
          'mqc_custom_rooms'
        ];
        legacyKeys.forEach(k => localStorage.removeItem(k));
      } catch (e) {}
    }
  };

  // Tự động dọn dẹp các legacy key dùng chung
  MQC_Storage.purgeLegacyUnscopedKeys();

  window.MQC_Storage = MQC_Storage;
})();
