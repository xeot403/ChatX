(() => {
    // API base — pick an explicit override, a window global, or derive from the page origin.
    // If the page is being served by an editor Live Server (e.g. port 5500), prefer the same hostname but port 8080
    // so API calls go to the backend instead of the static server (avoids 405).
    const API_BASE = (typeof CHATX_API_BASE !== 'undefined')
        ? CHATX_API_BASE
        : (window.__CHATX_API_BASE__ || (function () {
            try {
                const pagePort = location.port;
                // if page port is empty or already backend port, use origin
                if (!pagePort || pagePort === '8080') return location.origin;
                // otherwise assume backend listens on same hostname at port 8080
                return `${location.protocol}//${location.hostname}:8080`;
            } catch (e) {
                return location.origin;
            }
        })());
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${new URL(API_BASE).host}/ws`;

    const loginModal = document.getElementById('loginModal');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const showRegisterLink = document.getElementById('showRegister');
    const showLoginLink = document.getElementById('showLogin');

    const loginEmail = document.getElementById('loginEmail');
    const loginPassword = document.getElementById('loginPassword');
    const loginBtn = document.getElementById('loginBtn');

    const regEmail = document.getElementById('regEmail');
    const regPassword = document.getElementById('regPassword');
    const regDisplayName = document.getElementById('regDisplayName');
    const registerBtn = document.getElementById('registerBtn');

    const userInfo = document.querySelector('.user-info');
    const messagesEl = document.getElementById('messages');
    const composer = document.getElementById('composer');
    const messageInput = document.getElementById('messageInput');
    const memberSearch = document.getElementById('memberSearch');
    const onlineList = document.getElementById('onlineList');

    let ws = null;
    let me = { email: null, name: null };

    function addMessage({ from, name, text, ts, meFlag }) {
        const el = document.createElement('div');
        el.className = 'msg' + (meFlag ? ' me' : '');
        const meta = document.createElement('div'); meta.className = 'meta';
        meta.textContent = `${name || from} • ${new Date(ts).toLocaleTimeString()}`;
        const body = document.createElement('div'); body.textContent = text;
        el.appendChild(meta); el.appendChild(body);
        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function connect() {
        ws = new WebSocket(wsUrl);
        ws.addEventListener('open', () => {
            console.log('ws open');
            // send a join message
            ws.send(JSON.stringify({ type: 'join', email: me.email, name: me.name, ts: Date.now() }));
            // refresh online list when we join
            fetchAndRenderOnline();
        });
        ws.addEventListener('message', ev => {
            try {
                const data = JSON.parse(ev.data);
                if (data.type === 'message') {
                    addMessage({ from: data.email, name: data.name, text: data.text, ts: data.ts, meFlag: data.email === me.email });
                } else if (data.type === 'search' && data.from !== me.email) {
                    // Update search results when other users search
                    if (memberSearch) {
                        memberSearch.value = data.query;
                        fetchAndRenderOnline(data.query);
                    }
                }
            } catch (e) { console.error(e) }
        });
        ws.addEventListener('close', () => { console.log('ws closed'); });
        ws.addEventListener('error', e => { console.error('ws error', e) });
    }

    // Toggle between login and register forms
    showRegisterLink.addEventListener('click', (e) => {
        e.preventDefault();
        loginForm.classList.remove('active');
        registerForm.classList.add('active');
    });

    showLoginLink.addEventListener('click', (e) => {
        e.preventDefault();
        registerForm.classList.remove('active');
        loginForm.classList.add('active');
    });

    // Handle registration (robust JSON handling + clear errors)
    registerBtn.addEventListener('click', async () => {
        const email = regEmail.value.trim();
        const password = regPassword.value;
        const displayName = regDisplayName.value.trim();

        if (!email || !password) {
            return alert('Please provide both email and password');
        }

        try {
            const res = await fetch(`${API_BASE}/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, display_name: displayName })
            });

            const ct = res.headers.get('content-type') || '';
            let data = null;
            if (ct.includes('application/json')) {
                try {
                    data = await res.json();
                } catch (err) {
                    const text = await res.text().catch(() => '');
                    throw new Error('Invalid JSON response from server: ' + text);
                }
            } else {
                // fallback to text if server returned non-JSON
                const text = await res.text().catch(() => '');
                if (!res.ok) throw new Error(text || `Registration failed (${res.status})`);
                data = { success: true };
            }

            if (!res.ok) {
                const errMsg = (data && (data.error || data.message)) || `Registration failed (${res.status})`;
                throw new Error(errMsg);
            }

            alert('Registration successful! Please login.');
            registerForm.classList.remove('active');
            loginForm.classList.add('active');
        } catch (error) {
            console.error('Registration failed:', error);
            alert('Registration failed: ' + (error.message || error));
        }
    });

    // Handle login (robust JSON handling + clear errors)
    loginBtn.addEventListener('click', async () => {
        const email = loginEmail.value.trim();
        const password = loginPassword.value;

        if (!email || !password) {
            return alert('Please provide both email and password');
        }

        try {
            const res = await fetch(`${API_BASE}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });

            const ct = res.headers.get('content-type') || '';
            let data = null;
            if (ct.includes('application/json')) {
                try {
                    data = await res.json();
                } catch (err) {
                    const text = await res.text().catch(() => '');
                    throw new Error('Invalid JSON response from server: ' + text);
                }
            } else {
                const text = await res.text().catch(() => '');
                if (!res.ok) throw new Error(text || `Login failed (${res.status})`);
                data = { success: true };
            }

            if (!res.ok) {
                const errMsg = (data && (data.error || data.message)) || `Login failed (${res.status})`;
                throw new Error(errMsg);
            }

            me.email = data.email;
            me.name = data.display_name || data.email.split('@')[0];
            sessionStorage.setItem('chatX_user', JSON.stringify(me));
            loginModal.style.display = 'none';
            userInfo.textContent = me.name + ' (' + me.email + ')';
            connect();
        } catch (error) {
            console.error('Login failed:', error);
            alert('Login failed: ' + (error.message || error));
        }
    });

    // try restore
    const saved = sessionStorage.getItem('chatX_user');
    if (saved) {
        try { me = JSON.parse(saved); loginModal.style.display = 'none'; userInfo.textContent = me.name + ' (' + me.email + ')'; connect(); } catch (e) { }
    }

    // fetch online members from server
    async function fetchOnline() {
        try {
            const res = await fetch(`${API_BASE}/online`);
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data : [];
        } catch (e) { return []; }
    }

    function renderOnline(list, filter) {
        onlineList.innerHTML = '';
        const filtered = list.filter(u => !filter || (u.email && u.email.toLowerCase().includes(filter.toLowerCase())));
        if (filtered.length === 0) {
            const n = document.createElement('div'); n.className = 'no-contacts'; n.textContent = 'No matching online members'; onlineList.appendChild(n); return;
        }
        filtered.forEach(u => {
            const el = document.createElement('div'); el.className = 'member-entry';
            el.innerHTML = `<div class="email">${u.email}</div><div class="name">${u.name || ''}</div>`;
            el.addEventListener('click', () => {
                // clicking a member will prefills message input with "@email " to start addressing
                messageInput.focus();
                messageInput.value = `@${u.email} `;
            });
            onlineList.appendChild(el);
        });
    }

    let onlineDebounce = null;
    async function fetchAndRenderOnline(filter) {
        const list = await fetchOnline();
        renderOnline(list, filter);
    }

    if (memberSearch) {
        memberSearch.addEventListener('input', (e) => {
            const v = e.target.value.trim();
            if (onlineDebounce) clearTimeout(onlineDebounce);
            onlineDebounce = setTimeout(() => {
                // Send search query through websocket
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'search',
                        query: v,
                        from: me.email
                    }));
                }
                fetchAndRenderOnline(v);
            }, 180);
        });
        // refresh list on focus
        memberSearch.addEventListener('focus', () => fetchAndRenderOnline(memberSearch.value.trim()));
    }

    composer.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!me.email) { alert('Please login first'); return; }
        const text = messageInput.value.trim();
        if (!text) return;
        const payload = { type: 'message', email: me.email, name: me.name, text, ts: Date.now() };
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
            // Removed addMessage here as the message will come back through websocket
        } else {
            alert('Not connected to server');
        }
        messageInput.value = '';
    });


    // refresh online list periodically (every 8s) so UI shows current presence
    setInterval(() => {
        if (!memberSearch || document.activeElement === memberSearch) return; // avoid overwriting while typing
        fetchAndRenderOnline(memberSearch ? memberSearch.value.trim() : '');
    }, 8000);

})();
