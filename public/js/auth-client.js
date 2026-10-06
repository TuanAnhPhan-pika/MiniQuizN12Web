/**
 * auth-client.js — Universal authentication bridge for Mini Quiz Classroom.
 * Works seamlessly in both top-level windows and sandboxed/cross-origin iframes
 * by combining localStorage token management with Authorization Bearer headers
 * and cookie fallbacks.
 */
(function () {
  const TOKEN_KEY = 'mqc_session_token';

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setToken(tok) {
    try {
      if (tok) {
        localStorage.setItem(TOKEN_KEY, String(tok).trim());
      } else {
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch (e) {}
  }

  function clearToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  // Intercept window.fetch so every API call automatically carries the auth token
  const originalFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    const isApi = url.includes('/api/');

    if (isApi) {
      init = { ...init };
      const currentToken = getToken();
      
      // Khởi tạo headers phù hợp
      let headers;
      if (init.headers instanceof Headers) {
        headers = new Headers(init.headers);
        if (currentToken && !headers.has('Authorization')) {
          headers.set('Authorization', 'Bearer ' + currentToken);
        }
        if (currentToken && !headers.has('x-session-token')) {
          headers.set('x-session-token', currentToken);
        }
      } else if (Array.isArray(init.headers)) {
        headers = [...init.headers];
        if (currentToken) {
          headers.push(['Authorization', 'Bearer ' + currentToken]);
          headers.push(['x-session-token', currentToken]);
        }
      } else {
        headers = { ...(init.headers || {}) };
        if (currentToken && !headers['Authorization'] && !headers['authorization']) {
          headers['Authorization'] = 'Bearer ' + currentToken;
        }
        if (currentToken && !headers['x-session-token']) {
          headers['x-session-token'] = currentToken;
        }
      }

      init.headers = headers;
      init.credentials = init.credentials || 'same-origin';
    }

    const response = await originalFetch.apply(this, [input, init]);

    // Tự động bắt token từ response của login / register / me
    if (isApi && response.ok) {
      if (url.includes('/api/auth/login') || url.includes('/api/auth/register') || url.includes('/api/auth/me')) {
        try {
          const clone = response.clone();
          clone.json().then(data => {
            if (data && data.token) {
              setToken(data.token);
            }
          }).catch(() => {});
        } catch (e) {}
      }
    }

    if (isApi && url.includes('/api/auth/logout')) {
      clearToken();
    }

    return response;
  };

  window.MQC_Auth = {
    getToken,
    setToken,
    clearToken,
  };
})();
