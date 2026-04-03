// ==========================================
// ui.js - Manejo de la Interfaz, Navegación y Perfil
// ==========================================

// --- INTERCEPTOR GLOBAL DE SEGURIDAD FETCH ---
const originalFetch = window.fetch;
window.fetch = async function () {
    let [resource, config] = arguments;
    if (!config) config = {};
    if (!config.headers) config.headers = {};

    // Inyectar credenciales solo en llamadas a nuestra propia API para evitar errores de CORS con ESPN
    const urlStr = typeof resource === 'string' ? resource : (resource?.url || '');
    const esApiInterna = urlStr.startsWith('/api/') || urlStr.startsWith(window.location.origin + '/api/');

    if (esApiInterna) {
        const token = localStorage.getItem('authToken');
        const correo = localStorage.getItem('usuarioCorreo');
        if (token && correo) {
            config.headers['x-token'] = token;
            config.headers['x-correo'] = correo;
        }
    }

    try {
        const response = await originalFetch(resource, config);
        // Expulsión forzada si el token expiró (solo en API interna - no afecta CDNs/terceros)
        if (esApiInterna && response.status === 401 && typeof cerrarSesion === 'function') {
            if (typeof mostrarToast === 'function') mostrarToast('⚠️ Tu sesión ha expirado. Vuelve a iniciar sesión.');
            setTimeout(() => cerrarSesion(), 1500);
        }
        return response;
    } catch (error) {
        if (!navigator.onLine) {
            if (typeof mostrarToast === 'function') mostrarToast('❌ Sin conexión. Revisa tu red.');
        }
        throw error;
    }
};

// --- NAVEGACIÓN PRINCIPAL (Hash Router - 100% compatible con botón Atrás) ---

function cambiarPantalla(idPantallaDestino) {
    window.location.hash = idPantallaDestino;
}

window.addEventListener('hashchange', () => {
    let hashDestino = window.location.hash.replace('#', '');
    const autenticado = !!localStorage.getItem('usuarioCorreo');

    if (!hashDestino) {
        hashDestino = autenticado ? 'vista-dashboard' : 'vista-login';
        window.location.hash = hashDestino;
        return;
    }

    // Guardia de seguridad: Bouncer global para vistas protegidas
    if (!autenticado && hashDestino !== 'vista-login') {
        window.location.hash = 'vista-login';
        return;
    }

    renderizarPantalla(hashDestino);
});

function renderizarPantalla(idPantallaDestino) {
    const pantallas = document.querySelectorAll('.pantalla');
    let delay = 0;

    pantallas.forEach(pantalla => {
        if (pantalla.classList.contains('activa') && pantalla.id !== idPantallaDestino) {
            pantalla.classList.remove('activa');
            delay = 300;
            setTimeout(() => {
                pantalla.style.display = 'none';
            }, 300);
        }
    });

    setTimeout(() => {
        const destino = document.getElementById(idPantallaDestino);
        if (destino) {
            destino.style.display = 'flex';
            setTimeout(() => destino.classList.add('activa'), 20);
            if (idPantallaDestino !== 'vista-login') {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }

            // Hook post-navegación: cargar grupos al entrar al dashboard
            if (idPantallaDestino === 'vista-dashboard' && typeof cargarMisGrupos === 'function') {
                cargarMisGrupos();
                if (typeof checkOnboarding === 'function') checkOnboarding();
            }
            // Hook: cargar estadísticas personales
            if (idPantallaDestino === 'vista-stats' && typeof cargarStatsPersonal === 'function') {
                cargarStatsPersonal();
            }
            // Hook de restauración al recargar la página directamente en la vista
            if (idPantallaDestino === 'vista-grupo' && typeof inicializarVistaGrupo === 'function') {
                inicializarVistaGrupo();
            }

            // Hook al recargar la vista del perfil
            if (idPantallaDestino === 'vista-perfil' && typeof cargarDatosPerfil === 'function') {
                cargarDatosPerfil();
            }

            if (idPantallaDestino === 'vista-partido' && typeof verDetallesPartido === 'function') {
                const pid = localStorage.getItem('partidoActivoId');
                if (pid) {
                    verDetallesPartido(pid);
                } else {
                    cambiarPantalla('vista-dashboard');
                }
            }

            // Hook de limpieza: Detener el polling en vivo y chat si salimos de las vistas que lo necesitan
            if (idPantallaDestino !== 'vista-grupo' && idPantallaDestino !== 'vista-partido') {
                if (typeof detenerPollingLive === 'function') detenerPollingLive();
                if (typeof detenerPollingChat === 'function') detenerPollingChat();
            } else if (idPantallaDestino === 'vista-partido') {
                // Si vamos al partido, mantenemos live pero paramos chat (ahorra batería)
                if (typeof detenerPollingChat === 'function') detenerPollingChat();
            }
            
            // Fuga de datos mitigada: siempre forzar destrucción del poller de detalle al salir
            if (idPantallaDestino !== 'vista-partido' && typeof window.detenerPollingDetalle === 'function') {
                window.detenerPollingDetalle();
            }
            // Actualizar SEO/Meta Titles
            const baseTitle = "Polla Futbolera";
            let newTitle = baseTitle;
            let newDesc = "Compite con tus amigos en la plataforma más segura y rápida de predicciones deportivas.";
            
            if (idPantallaDestino === 'vista-grupo') {
                const gNombre = localStorage.getItem('grupoActivoNombre') || 'Grupo';
                newTitle = `${gNombre} | ${baseTitle}`;
                newDesc = `Únete a mi grupo "${gNombre}" y compite por el primer lugar en pronósticos deportivos.`;
            } else if (idPantallaDestino === 'vista-partido') {
                newTitle = `Partido en Vivo | ${baseTitle}`;
            } else if (idPantallaDestino === 'vista-stats') {
                newTitle = `Mis Estadísticas | ${baseTitle}`;
            }

            document.title = newTitle;
            const metaTitle = document.querySelector('meta[property="og:title"]');
            const metaDesc = document.querySelector('meta[property="og:description"]');
            if(metaTitle) metaTitle.content = newTitle;
            if(metaDesc) metaDesc.content = newDesc;
        }
    }, delay);
}

// --- MODALES ---
function abrirModal(id) {
    const m = document.getElementById(id);
    m.classList.remove('hidden');
    setTimeout(() => {
        m.classList.remove('opacity-0');
        m.querySelector('.modal-content').classList.remove('scale-95');
    }, 10);
}

function cerrarModal(id) {
    const m = document.getElementById(id);
    m.classList.add('opacity-0');
    m.querySelector('.modal-content').classList.add('scale-95');
    setTimeout(() => {
        m.classList.add('hidden');
    }, 300);
}

// --- DARK MODE THEME ---
const themeToggleBtn = document.getElementById('theme-toggle');
const themeToggleDarkIcon = document.getElementById('theme-toggle-dark-icon');
const themeToggleLightIcon = document.getElementById('theme-toggle-light-icon');

let isDark = false;
if (localStorage.getItem('color-theme') === 'dark' || (!('color-theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
    if (themeToggleLightIcon) themeToggleLightIcon.classList.remove('hidden');
    isDark = true;
} else {
    if (themeToggleDarkIcon) themeToggleDarkIcon.classList.remove('hidden');
}

if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', function (e) {
        if (isDark) {
            document.documentElement.classList.remove('dark');
            localStorage.setItem('color-theme', 'light');
            isDark = false;
        } else {
            document.documentElement.classList.add('dark');
            localStorage.setItem('color-theme', 'dark');
            isDark = true;
        }
        
        if (themeToggleDarkIcon) themeToggleDarkIcon.classList.toggle('hidden');
        if (themeToggleLightIcon) themeToggleLightIcon.classList.toggle('hidden');
    });
}

// --- COLOR THEME PRESETS (v2.0) ---


function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

function adjustColor(hex, amt) {
    let col = hex.replace('#', '');
    let r = parseInt(col.substring(0, 2), 16);
    let g = parseInt(col.substring(2, 4), 16);
    let b = parseInt(col.substring(4, 6), 16);
    r = Math.max(0, Math.min(255, r + amt));
    g = Math.max(0, Math.min(255, g + amt));
    b = Math.max(0, Math.min(255, b + amt));
    const nr = r.toString(16).padStart(2, '0');
    const ng = g.toString(16).padStart(2, '0');
    const nb = b.toString(16).padStart(2, '0');
    return `#${nr}${ng}${nb}`;
}

function getContrastColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#ffffff';
    const brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
    return brightness > 145 ? '#000000' : '#ffffff';
}

window.aplicarColorPersonalizado = function (hex) {
    if (!hex || !hex.startsWith('#')) return;

    const root = document.documentElement;
    root.style.setProperty('--color-primary', hex);
    root.style.setProperty('--color-primary-50', adjustColor(hex, 180));
    root.style.setProperty('--color-primary-100', adjustColor(hex, 150));
    root.style.setProperty('--color-primary-200', adjustColor(hex, 100));
    root.style.setProperty('--color-primary-700', adjustColor(hex, -30));
    root.style.setProperty('--color-primary-800', adjustColor(hex, -60));
    root.style.setProperty('--color-primary-900', adjustColor(hex, -90));
    root.style.setProperty('--color-primary-contrast', getContrastColor(hex));

    // El secondary solía ser el primary-700
    root.style.setProperty('--color-secondary', adjustColor(hex, -30));

    localStorage.setItem('tema-color-hex', hex);
    localStorage.removeItem('tema-preferido');

    const preview = document.getElementById('color-preview-circle');
    if (preview) {
        preview.style.backgroundColor = hex;
        preview.style.color = getContrastColor(hex);
    }
};

// Deprecated: ahora usamos prisma, pero se mantiene para retrocompatibilidad
window.aplicarTema = function (nombre) {
    const TEMAS_PRESETS = {
        blue: '#2563eb', verde: '#059669', rojo: '#dc2626', morado: '#8b5cf6', oro: '#d97706'
    };
    const hex = TEMAS_PRESETS[nombre] || '#2563eb';
    aplicarColorPersonalizado(hex);
};

window.restaurarColorPorDefecto = function() {
    const defaultColor = '#2563eb';
    aplicarColorPersonalizado(defaultColor);
    const picker = document.getElementById('color-picker');
    if (picker) picker.value = defaultColor;
    if (typeof mostrarToast === 'function') mostrarToast("Tema restaurado al color por defecto 🎨");
};



// ==========================================
// LÓGICA DE PERFIL Y CONFIGURACIÓN
// ==========================================

let avatarSeleccionado = '👤';
const avataresDisponibles = ['👤', '🦁', '🦅', '🦈', '⚽', '🏆', '🥇', '🧤', '🏟️', '👑', '👽', '🤖', '🐶', '🦊', '🐻'];

function cargarDatosPerfil() {
    // Cargar nombre y correo
    const correo = localStorage.getItem('usuarioCorreo') || '-';
    const nombreActual = localStorage.getItem('usuarioNombre') || '';

    const nombreDisplay = document.getElementById('perfil-nombre-display');
    if (nombreDisplay) nombreDisplay.innerText = nombreActual;
    const correoDisplay = document.getElementById('perfil-correo-display-badge');
    if (correoDisplay) correoDisplay.innerText = correo;

    const perfilInput = document.getElementById('perfil-nombre-input');
    if(perfilInput) perfilInput.value = nombreActual;

    avatarSeleccionado = localStorage.getItem('usuarioAvatar') || '👤';
    const previewDisplay = document.getElementById('perfil-avatar-preview-display');
    if (previewDisplay) previewDisplay.innerText = avatarSeleccionado;

    const alertasGuardadas = localStorage.getItem('usuarioAlertas');
    const toggleAlertas = document.getElementById('check-alertas');
    if (toggleAlertas) {
        toggleAlertas.checked = alertasGuardadas === null ? true : alertasGuardadas === 'true';
    }

    renderizarAvatares();

    // Inicializar indicadores de tema
    const temaHex = localStorage.getItem('tema-color-hex') || '#2563eb';
    const picker = document.getElementById('color-picker');
    const previewColor = document.getElementById('color-preview-circle');
    const hintColor = document.getElementById('hint-color');

    if (picker) picker.value = temaHex;
    if (previewColor) previewColor.style.backgroundColor = temaHex;
    if (hintColor) hintColor.style.backgroundColor = temaHex;
}

function abrirPerfil() {
    cargarDatosPerfil();
    cambiarPantalla('vista-perfil');
}

function renderizarAvatares() {
    const contenedor = document.getElementById('lista-avatars');
    if (!contenedor) return;
    let html = '';

    avataresDisponibles.forEach(a => {
        const isSelected = a === avatarSeleccionado;
        const clasesActivo = isSelected
            ? 'ring-2 ring-blue-500 bg-blue-100 dark:bg-blue-900/60 scale-110 shadow-sm'
            : 'bg-gray-50 dark:bg-gray-900/50 hover:bg-gray-100 dark:hover:bg-gray-800';

        html += `
            <button onclick="seleccionarAvatar('${a}', this)" type="button"
                    class="avatar-option aspect-square rounded-2xl text-2xl flex items-center justify-center transition-all duration-300 ${clasesActivo}">
                ${a}
            </button>
        `;
    });

    contenedor.innerHTML = html;
}

function seleccionarAvatar(emoji, btn) {
    const contenedor = document.getElementById('lista-avatars');
    const prev = contenedor ? contenedor.querySelector('button.ring-2') : null;
    if (prev) {
        prev.classList.remove('ring-2', 'ring-blue-500', 'bg-blue-100', 'dark:bg-blue-900/60', 'scale-110', 'shadow-sm');
        prev.classList.add('bg-gray-50', 'dark:bg-gray-900/50', 'hover:bg-gray-100', 'dark:hover:bg-gray-800');
    }
    btn.classList.remove('bg-gray-50', 'dark:bg-gray-900/50', 'hover:bg-gray-100', 'dark:hover:bg-gray-800');
    btn.classList.add('ring-2', 'ring-blue-500', 'bg-blue-100', 'dark:bg-blue-900/60', 'scale-110', 'shadow-sm');
    avatarSeleccionado = emoji;
}

async function sincronizarPerfil() {
    const correo = localStorage.getItem('usuarioCorreo');
    if (!correo) return;
    try {
        const r = await fetch(`/api/perfil/${encodeURIComponent(correo)}`);
        if (!r.ok) return;
        const data = await r.json();
        localStorage.setItem('usuarioNombre', data.nombre);
        localStorage.setItem('usuarioAvatar', data.avatar);
        localStorage.setItem('usuarioAlertas', data.alertas);
        
        const nombreEl = document.getElementById('nombre-dashboard');
        if (nombreEl) nombreEl.innerText = data.nombre;
        const avatarEl = document.getElementById('avatar-dashboard');
        if (avatarEl) avatarEl.innerText = data.avatar;
    } catch (e) { }
}

function toggleVisibilidadPassPerfil(inputId, iconId) {
    const input = document.getElementById(inputId);
    const icon = document.getElementById(iconId);

    if (input.type === 'password') {
        input.type = 'text';
        icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path>`;
    } else {
        input.type = 'password';
        icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>`;
    }
}

async function verificarToggleNotificaciones() {
    const toggle = document.getElementById('check-alertas');
    if(toggle && window.verificarPermisoNotificaciones) {
        window.verificarPermisoNotificaciones(toggle.checked);
    }
    
    // Auto-guardado
    const correo = localStorage.getItem('usuarioCorreo');
    const alertas = toggle.checked;
    
    try {
        await fetch('/api/perfil/actualizar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ correo, alertas })
        });
        localStorage.setItem('usuarioAlertas', alertas);
    } catch(e) {}
}

async function guardarCambiosModal(tipo) {
    const correo = localStorage.getItem('usuarioCorreo');
    let bodyData = { correo };
    
    if (tipo === 'perfil') {
        const nuevoNombre = document.getElementById('perfil-nombre-input').value.trim();
        if (nuevoNombre.length < 3 || nuevoNombre.length > 30) {
            return mostrarToast("⚠️ Tu nombre debe tener entre 3 y 30 caracteres.");
        }
        bodyData.nombre = nuevoNombre;
        bodyData.avatar = avatarSeleccionado;
    } else if (tipo === 'pass') {
        const passActual = document.getElementById('perfil-pass-actual').value;
        const passNueva = document.getElementById('perfil-pass-nueva').value;
        
        if (passActual === "" || passNueva === "") return mostrarToast("⚠️ Completa ambas contraseñas.");
        const hasNum = /\d/.test(passNueva), hasMay = /[A-Z]/.test(passNueva), hasMin = /[a-z]/.test(passNueva), hasLen = passNueva.length >= 8;
        if (!(hasNum && hasMay && hasMin && hasLen)) {
            return mostrarToast("⚠️ La nueva clave requiere: 8+ carac., 1 Mayús, 1 Minús y 1 Núm.");
        }
        bodyData.password_actual = passActual;
        bodyData.password_nueva = passNueva;
    }

    try {
        const response = await fetch('/api/perfil/actualizar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });

        const data = await response.json();
        if (response.ok) {
            if (tipo === 'perfil') {
                localStorage.setItem('usuarioNombre', bodyData.nombre);
                localStorage.setItem('usuarioAvatar', bodyData.avatar);
                
                const dashNombre = document.getElementById('nombre-dashboard');
                const dashAvatar = document.getElementById('avatar-dashboard');
                if (dashNombre) dashNombre.innerText = bodyData.nombre;
                if (dashAvatar) dashAvatar.innerText = bodyData.avatar;
                
                const dispNombre = document.getElementById('perfil-nombre-display');
                const dispAva = document.getElementById('perfil-avatar-preview-display');
                if(dispNombre) dispNombre.innerText = bodyData.nombre;
                if(dispAva) dispAva.innerText = bodyData.avatar;
                
                cerrarModal('modal-editar-perfil');
            } else if (tipo === 'pass') {
                document.getElementById('perfil-pass-actual').value = '';
                document.getElementById('perfil-pass-nueva').value = '';
                cerrarModal('modal-cambiar-pass');
            }
            mostrarToast("✅ ¡Actualizado con éxito!");
        } else {
            const errorMsg = typeof traducirErrorAuth === 'function' ? traducirErrorAuth(data.detail) : data.detail;
            mostrarToast("⚠️ " + errorMsg);
        }
    } catch (e) {
        mostrarToast("❌ No se pudo conectar con el servidor.");
    }
}

async function eliminarCuenta() {
    const correo = localStorage.getItem('usuarioCorreo');
    const btn = document.querySelector('button[onclick="eliminarCuenta()"]');
    const ok = await confirmarAccion("⚠️ ¿ESTÁS SEGURO?\n\nEsta acción borrará permanentemente todos tus aciertos, historial y acceso al sistema. No se puede deshacer.");
    if (!ok) return;

    if (btn) {
        btn.disabled = true;
        btn.innerText = "ELIMINANDO...";
    }

    try {
        const response = await fetch('/api/perfil/eliminar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ correo: correo })
        });

        if (response.ok) {
            mostrarToast("¡Tu cuenta ha sido eliminada con éxito! Adiós. 👋");
            setTimeout(() => {
                if (typeof cerrarSesion === 'function') cerrarSesion();
            }, 1500);
        } else {
            mostrarToast("⚠️ No se pudo eliminar la cuenta. Inténtalo más tarde.");
        }
    } catch (error) {
        mostrarToast("❌ Error al contactar con el servidor.");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = "ELIMINAR MI CUENTA DEFINITIVAMENTE";
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (!window.location.hash) {
        const destino = localStorage.getItem('usuarioCorreo') ? 'vista-dashboard' : 'vista-login';
        window.location.hash = destino;
    } else {
        window.dispatchEvent(new Event('hashchange'));
    }
});

// Modal de confirmación reutilizable (reemplaza confirm() nativo para consistencia visual)
function confirmarAccion(mensaje) {
    return new Promise(resolve => {
        document.getElementById('modal-confirmar-accion')?.remove();
        const modal = document.createElement('div');
        modal.id = 'modal-confirmar-accion';
        modal.className = 'fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4';
        modal.innerHTML = `
            <div class="bg-white dark:bg-gray-800 rounded-[2rem] shadow-2xl w-full max-w-sm p-6">
                <p id="confirm-texto" class="text-gray-700 dark:text-gray-200 font-medium text-sm mb-6 leading-relaxed whitespace-pre-line"></p>
                <div class="flex gap-3">
                    <button id="confirm-cancelar" class="flex-1 py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 font-bold text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition">Cancelar</button>
                    <button id="confirm-ok" class="flex-1 py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-black text-sm transition active:scale-95">Confirmar</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.querySelector('#confirm-texto').innerText = mensaje;
        modal.querySelector('#confirm-ok').onclick = () => { modal.remove(); resolve(true); };
        modal.querySelector('#confirm-cancelar').onclick = () => { modal.remove(); resolve(false); };
        modal.addEventListener('click', e => { if (e.target === modal) { modal.remove(); resolve(false); } });
    });
}

function mostrarToast(mensaje) {
    if (!mensaje) return;
    const msgStr = String(mensaje);

    let contenedor = document.getElementById('toast-container');
    if (!contenedor) {
        contenedor = document.createElement('div');
        contenedor.id = 'toast-container';
        contenedor.className = 'fixed top-5 right-5 z-[9999] flex flex-col gap-3 pointer-events-none';
        document.body.appendChild(contenedor);
    }

    if (contenedor.children.length >= 3) {
        contenedor.children[0].remove();
    }

    let tipo = 'info';
    if (msgStr.includes('⚠️')) tipo = 'warning';
    if (msgStr.includes('❌') || msgStr.toLowerCase().includes('error')) tipo = 'error';
    if (msgStr.includes('✅') || msgStr.includes('¡') || msgStr.includes('éxito')) tipo = 'success';

    let bgClass = 'bg-white dark:bg-gray-800 text-gray-800 dark:text-white border-l-4 border-primary';
    let icono = '🔔';

    if (tipo === 'success') {
        bgClass = 'bg-white dark:bg-gray-800 text-gray-800 dark:text-white border-l-4 border-green-500';
        icono = '✅';
    } else if (tipo === 'error') {
        bgClass = 'bg-white dark:bg-gray-800 text-gray-800 dark:text-white border-l-4 border-red-500';
        icono = '❌';
    } else if (tipo === 'warning') {
        bgClass = 'bg-white dark:bg-gray-800 text-gray-800 dark:text-white border-l-4 border-orange-500';
        icono = '⚠️';
    }

    const textoLimpio = msgStr.replace(/⚠️|❌|✅/g, '').trim();

    const toast = document.createElement('div');
    toast.className = `max-w-sm w-fit flex items-center gap-3 px-5 py-4 rounded-xl shadow-2xl border border-gray-100 dark:border-gray-700 transform transition-all duration-300 translate-x-[120%] opacity-0 pointer-events-auto ${bgClass}`;

    toast.innerHTML = `
        <div class="text-xl">${icono}</div>
        <div class="font-semibold text-sm leading-tight"></div>
    `;
    // Usar textContent para prevenir XSS en contenido dinámico
    toast.querySelector('.leading-tight').textContent = textoLimpio;

    contenedor.appendChild(toast);

    // Forzar reflow para asegurar que la transición ocurra
    toast.offsetHeight;

    requestAnimationFrame(() => {
        toast.classList.remove('translate-x-[120%]', 'opacity-0');
        toast.classList.add('translate-x-0', 'opacity-100');
    });

    setTimeout(() => {
        if (!toast.parentNode) return;
        toast.classList.remove('translate-x-0', 'opacity-100');
        toast.classList.add('translate-x-[120%]', 'opacity-0');

        toast.addEventListener('transitionend', () => {
            if (toast.parentNode) toast.remove();
        }, { once: true });

        setTimeout(() => {
            if (toast.parentNode) toast.remove();
        }, 500);
    }, 4000); // 4 segundos para mejor lectura
}

window.verificarPermisoNotificaciones = async function (activado) {
    if (!activado) return;

    if (!("Notification" in window)) {
        mostrarToast("⚠️ Tu navegador no soporta notificaciones de escritorio.");
        return;
    }

    if (Notification.permission === "granted") {
        mostrarToast("✅ Las notificaciones ya están activadas.");
        new Notification("Polla Futbolera", {
            body: "¡Las alertas están activas! Te avisaremos antes de cada partido. ⚽",
            icon: "/js/logo-social.png"
        });
    } else if (Notification.permission !== "denied") {
        const permiso = await Notification.requestPermission();
        if (permiso === "granted") {
            mostrarToast("✅ ¡Permiso concedido!");
            new Notification("Polla Futbolera", {
                body: "¡Bienvenido a las alertas en vivo! 🔔",
                icon: "/js/logo-social.png"
            });
        } else {
            mostrarToast("⚠️ No podremos enviarte alertas sin tu permiso.");
        }
    } else {
        mostrarToast("❌ Notificaciones bloqueadas en el navegador. Por favor, actívalas en la configuración del sitio.");
    }
};

// window.alert NO se sobreescribe — se llama a mostrarToast() directamente donde sea necesario.

// ==========================================
// DETECTOR ONLINE/OFFLINE
// ==========================================
// Banner de conexión
function _actualizarBannerConexion() {
    const banner = document.getElementById('offline-banner');
    if (!banner) return;
    if (navigator.onLine) {
        banner.classList.add('hidden');
    } else {
        banner.classList.remove('hidden');
        banner.classList.add('flex');
    }
}
window.addEventListener('online', _actualizarBannerConexion);
window.addEventListener('offline', _actualizarBannerConexion);
document.addEventListener('DOMContentLoaded', _actualizarBannerConexion);