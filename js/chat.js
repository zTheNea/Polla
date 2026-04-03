// ==========================================
// chat.js - Gestión del Chat en Vivo
// ==========================================

let _intervaloChat = null;
let _ultimoChatFecha = null;
let _wsChat = null;
let _wsReconnectDelay = 2000; // Backoff exponencial inicial

window.detenerPollingChat = function () {
    if (_intervaloChat) {
        clearInterval(_intervaloChat);
        clearTimeout(_intervaloChat);
        _intervaloChat = null;
    }
    if (_wsChat) {
        _wsChat.close();
        _wsChat = null;
    }
};

window.limpiarCacheChat = function () {
    _ultimoChatFecha = null;
}

window.cargarChat = async function () {
    const gid = localStorage.getItem('grupoActivoId');
    const container = document.getElementById('chat-mensajes-container');
    const miCorreo = localStorage.getItem('usuarioCorreo');
    const esDelta = !!_ultimoChatFecha;

    try {
        const url = esDelta ? `/api/chat/${gid}?since=${_ultimoChatFecha}` : `/api/chat/${gid}`;
        const res = await fetch(url);
        const d = await res.json();
        if (res.ok && d.mensajes.length > 0) {
            const panel = document.getElementById('panel-chat');
            const estaAbierto = panel && !panel.classList.contains('translate-x-full');

            // 🔔 Notificación si hay mensajes nuevos de otros y el chat está cerrado
            if (esDelta && !estaAbierto) {
                const nuevosDeOtros = d.mensajes.filter(m => m.correo_usuario !== miCorreo);
                if (nuevosDeOtros.length > 0) {
                    const notifBadge = document.getElementById('notif-chat');
                    if (notifBadge) notifBadge.classList.remove('hidden');

                    const ultimoMsj = nuevosDeOtros[nuevosDeOtros.length - 1];
                    mostrarToast(`💬 ${escHtml(ultimoMsj.nombre)}: ${escHtml(ultimoMsj.mensaje)}`);
                }
            }

            let html = '';
            d.mensajes.forEach(m => {
                const esMio = m.correo_usuario === miCorreo;
                html += `
                    <div class="flex flex-col ${esMio ? 'items-end' : 'items-start'} mb-3">
                        <div class="flex items-center gap-1 mb-1">
                            <span class="text-[10px] font-bold text-gray-400 capitalize">${esMio ? 'Tú' : escHtml(m.nombre)}</span>
                            <span class="text-xs">${m.avatar}</span>
                        </div>
                        <div class="${esMio ? 'bg-primary text-primary-contrast rounded-l-1xl rounded-tr-1xl' : 'bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-r-1xl rounded-tl-1xl border border-gray-100 dark:border-gray-700'} p-2.5 shadow-sm text-sm max-w-[85%] break-words">
                            ${escHtml(m.mensaje)}
                        </div>
                    </div>`;
            });

            if (!esDelta) {
                container.innerHTML = html;
            } else {
                // Si es delta, quitamos el placeholder si existe y agregamos al final
                if (container.querySelector('p')) container.innerHTML = '';
                container.insertAdjacentHTML('beforeend', html);
            }

            _ultimoChatFecha = d.mensajes[d.mensajes.length - 1].fecha;
            container.scrollTop = container.scrollHeight;
        } else if (!esDelta && d.mensajes.length === 0) {
            container.innerHTML = '<p class="text-center text-xs text-gray-400 py-10 italic">¡Sé el primero en escribir!</p>';
        }
    } catch (e) { }
};

window.enviarMensajeChat = async function (e) {
    if (e) e.preventDefault();
    const input = document.getElementById('chat-input');
    const msj = input.value.trim();
    if (!msj) return;

    const gid = localStorage.getItem('grupoActivoId');
    input.value = '';

    try {
        const res = await fetch('/api/chat/enviar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grupo_id: parseInt(gid), mensaje: msj })
        });
        if (!res.ok) {
            throw new Error("Error en servidor");
        }
    } catch (e) {
        // Notificación visual de error en lugar de log
        if (typeof mostrarToast === 'function') mostrarToast("⚠️ Error al enviar mensaje");
    }
};

window.iniciarPollingChat = function () {
    window.detenerPollingChat();
    window.cargarChat();

    const gid = localStorage.getItem('grupoActivoId');
    const token = localStorage.getItem('authToken');

    if (!gid || !token) return;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/api/ws/chat/${gid}`;
    
    _wsChat = new WebSocket(wsUrl);
    
    _wsChat.onopen = function () {
        // Enviar token como primer mensaje (más seguro que query param)
        _wsChat.send(`auth:${token}`);
    };

    _wsChat.onmessage = function (event) {
        try {
            if (event.data === "pong" || event.data === "authenticated") {
                if (event.data === "authenticated") _wsReconnectDelay = 2000; // Reset backoff on success
                return;
            }
            const data = JSON.parse(event.data);
            if (data.tipo === 'chat') {
                const msj = data.mensaje;
                const miCorreo = localStorage.getItem('usuarioCorreo');
                const container = document.getElementById('chat-mensajes-container');
                const panel = document.getElementById('panel-chat');
                const estaAbierto = panel && !panel.classList.contains('translate-x-full');

                if (msj.correo_usuario !== miCorreo && !estaAbierto) {
                    const notifBadge = document.getElementById('notif-chat');
                    if (notifBadge) notifBadge.classList.remove('hidden');
                    if (typeof mostrarToast === 'function') {
                        const safeNombre = typeof escHtml === 'function' ? escHtml(msj.nombre) : msj.nombre;
                        const safeMsj = typeof escHtml === 'function' ? escHtml(msj.mensaje) : msj.mensaje;
                        mostrarToast(`💬 ${safeNombre}: ${safeMsj}`);
                    }
                }

                const esMio = msj.correo_usuario === miCorreo;
                const escN = typeof escHtml === 'function' ? escHtml(msj.nombre) : msj.nombre;
                const escM = typeof escHtml === 'function' ? escHtml(msj.mensaje) : msj.mensaje;
                
                const html = `
                    <div class="flex flex-col ${esMio ? 'items-end' : 'items-start'} mb-3 animar-entrada">
                        <div class="flex items-center gap-1 mb-1">
                            <span class="text-[10px] font-bold text-gray-400 capitalize">${esMio ? 'Tú' : escN}</span>
                            <span class="text-xs">${msj.avatar}</span>
                        </div>
                        <div class="${esMio ? 'bg-primary text-primary-contrast rounded-l-1xl rounded-tr-1xl' : 'bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-r-1xl rounded-tl-1xl border border-gray-100 dark:border-gray-700'} p-2.5 shadow-sm text-sm max-w-[85%] break-words">
                            ${escM}
                        </div>
                    </div>`;

                if (container.querySelector('p')) container.innerHTML = '';
                container.insertAdjacentHTML('beforeend', html);
                container.scrollTop = container.scrollHeight;
                _ultimoChatFecha = msj.fecha;
            }
        } catch (e) { }
    };

    _wsChat.onclose = function () {
        // Reintento automático silencioso
        _intervaloChat = setTimeout(() => {
            window.iniciarPollingChat();
        }, _wsReconnectDelay);
        // Backoff exponencial: 2s, 4s, 8s, 16s, max 30s
        _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, 30000);
    };

    _intervaloChat = setInterval(() => {
        if (_wsChat && _wsChat.readyState === WebSocket.OPEN) {
            _wsChat.send('ping');
        }
    }, 30000);
};
