// ==========================================
// grupos.js - Gestión Multi-Liga, Partidos y Secciones
// ==========================================

let partidosGlobales = [];
let _intervaloLive = null;
let _intervaloChat = null;

// Cache de pronósticos para evitar re-fetching al abrir el detalle de un partido
let misPronosticosCache = null;
let misPronosticosCacheGid = null;
let _ultimoChatFecha = null;

window.limpiarCachePronosticos = function() {
    misPronosticosCache = null;
    misPronosticosCacheGid = null;
    _ultimoChatFecha = null; // ✅ v2.0 fix: Evitar resumir chat de otro grupo
};

// --- UTILIDADES DE SEGURIDAD Y TIEMPO (v2.0) ---
let _serverTimeOffset = 0; 
async function sincronizarTiempo() {
    try {
        const start = Date.now();
        const res = await fetch('/api/utils/server-time');
        const d = await res.json();
        const latencia = (Date.now() - start) / 2;
        const serverDate = new Date(d.iso);
        _serverTimeOffset = serverDate.getTime() - (Date.now() - latencia);
    } catch (e) { console.error("Error tiempo:", e); }
}

function getNow() { return new Date(Date.now() + _serverTimeOffset); }

async function fetchConAuth(url, options = {}) {
    const token = localStorage.getItem('authToken');
    if (!options.headers) options.headers = {};
    if (token) options.headers['x-token'] = token;
    const res = await fetch(url, options);
    if (res.status === 401) {
        if (typeof cerrarSesion === 'function') cerrarSesion();
        throw new Error("Sesión expirada");
    }
    return res;
}

// --- GESTIÓN DE POLLING ---
window.detenerPollingChat = function() {
    if (_intervaloChat) {
        clearInterval(_intervaloChat);
        _intervaloChat = null;
    }
};

window.detenerPollingLive = function() {
    if (_intervaloLive) {
        clearInterval(_intervaloLive);
        _intervaloLive = null;
    }
};

const AVATARES_EXTENDIDOS = [
    '👤', '⚽', '🏆', '🥇', '👟', '🥅', '🧤', '🏟️', 
    '🤴', '🦸', '🏃', '🤩', '🦁', '🐯', '🦅', '🔥', 
    '⚡', '🎩', '🎯', '🎬', '💎', '🎨', '🚀', '👽'
];

// SVG inline como fallback para escudos no disponibles (evita dependencia de servicio externo)
const LOGO_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='50' height='50' viewBox='0 0 50 50'%3E%3Ccircle cx='25' cy='25' r='24' fill='%23e5e7eb' stroke='%23d1d5db'/%3E%3Ctext x='25' y='33' text-anchor='middle' font-size='22' fill='%239ca3af'%3E%E2%9A%BD%3C/text%3E%3C/svg%3E";

// Sanitización HTML para prevenir inyección de código (XSS) en contenido generado dinámicamente
function escHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Sanitización robusta para cadenas inyectadas dentro de atributos en línea JS (ej: onclick="funcion('...')")
function escJs(str) {
    return String(str ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

// Stepper de goles: incrementa o decrementa el valor de un input de goles
function cambiarGol(inputId, delta, idPartido) {
    // ✅ Bloqueo preventivo en UI: si el partido ya está cerrado (backend valida de todos modos)
    if (idPartido) {
        const p = partidosGlobales.find(x => x.id_partido === idPartido);
        if (p) {
            const f = new Date(p.fecha);
            const diff = (f - getNow()) / (1000 * 60);
            if (p.estado !== 'pre' || diff <= 10) {
                mostrarToast("⚠️ El tiempo para modificar este pronóstico ha expirado.");
                return;
            }
        }
    }

    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = Math.max(0, (parseInt(input.value) || 0) + delta);
}

// Actualiza la barra de progreso de pronósticos pendientes (ignorando los partidos pasados sin pronóstico)
function actualizarBarraProgreso() {
    if (!partidosGlobales) return;

    let completados = 0;
    let totalPronosticables = 0;
    const ahora = new Date();

    // Contamos basándonos en los datos reales del DOM + el estado del partido
    partidosGlobales.forEach(p => {
        const el = document.getElementById(`pred-resumen-${p.id_partido}`);
        if (!el) return;

        const tienePronostico = el.dataset.hasPrediction === 'true';
        const fechaPartido = new Date(p.fecha);
        const minRestantes = (fechaPartido - getNow()) / (1000 * 60);
        const estaDesbloqueado = p.estado === 'pre' && minRestantes > 10;

        // Si tiene pronóstico, SIEMPRE suma al total y a los completados
        if (tienePronostico) {
            completados++;
            totalPronosticables++;
        }
        // Si NO tiene pronóstico, pero AÚN se puede jugar, suma al total (es una tarea pendiente)
        else if (estaDesbloqueado) {
            totalPronosticables++;
        }
        // Si no tiene pronóstico y ya se bloqueó, se ignora por completo (ya fue, no afecta la barra)
    });

    const pct = totalPronosticables > 0 ? Math.round((completados / totalPronosticables) * 100) : 0;
    const fill = document.getElementById('progreso-fill');
    const label = document.getElementById('progreso-label');

    if (fill) {
        fill.style.width = `${pct}%`;
        fill.className = `h-2 rounded-full transition-all duration-700 ease-out ${pct === 100 ? 'bg-green-500' : 'bg-primary-500'}`;
    }
    if (label) label.textContent = `${completados}/${totalPronosticables}`;
}

// Soporte de gestos swipe horizontal entre tabs de partidos (móvil)
function agregarSwipeTabs() {
    const cont = document.getElementById('contenedor-partidos');
    if (!cont || cont._swipeAttached) return;
    cont._swipeAttached = true;
    let sx = 0, sy = 0;
    cont.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    cont.addEventListener('touchend', e => {
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 55) {
            const tabs = ['prox', 'vivo', 'res'];
            const cur = localStorage.getItem('tabFiltroActual') || 'prox';
            const idx = tabs.indexOf(cur);
            if (dx < 0 && idx < tabs.length - 1) cambiarTabFiltros(tabs[idx + 1]);
            if (dx > 0 && idx > 0) cambiarTabFiltros(tabs[idx - 1]);
        }
    }, { passive: true });
}


async function crearNuevoGrupo() {
    let nombreGrupo = document.getElementById('nombre-grupo-input').value.trim();
    nombreGrupo = nombreGrupo.replace(/\s+/g, ' '); // Colapsar múltiples espacios
    const ligaSeleccionada = document.getElementById('liga-grupo-input').value;
    const correoUsuario = localStorage.getItem('usuarioCorreo');

    if (!nombreGrupo) return mostrarToast("⚠️ Por favor, escribe un nombre para tu grupo.");
    if (nombreGrupo.length < 3 || nombreGrupo.length > 30) return mostrarToast("⚠️ El nombre del grupo debe tener entre 3 y 30 caracteres.");

    const regexValido = /^[a-zA-Z0-9 áéíóúÁÉÍÓÚñÑ_\-]+$/;
    if (!regexValido.test(nombreGrupo)) return mostrarToast("⚠️ El nombre del grupo contiene caracteres no permitidos.");

    if (!correoUsuario) return;

    try {
        const respuesta = await fetchConAuth('/api/grupos/crear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre: nombreGrupo,
                limite: 20,
                correo_creador: correoUsuario,
                liga: ligaSeleccionada
            })
        });
        const datos = await respuesta.json();

        if (respuesta.ok) {
            mostrarToast(`¡Grupo creado! Código: ${datos.codigo}`);
            cerrarModal('modal-crear');
            document.getElementById('nombre-grupo-input').value = '';
            cargarMisGrupos();
        } else {
            mostrarToast("⚠️ Error: " + traducirErrorAuth(datos.detail));
        }
    } catch (e) { console.error(e); }
}

async function unirseAGrupo() {
    const codigo = document.getElementById('codigo-unirse-input').value.trim().toUpperCase();
    const correoUsuario = localStorage.getItem('usuarioCorreo');
    if (!codigo) return mostrarToast("⚠️ Ingresa el código.");

    try {
        const respuesta = await fetchConAuth('/api/grupos/unirse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codigo })
        });

        if (respuesta.ok) {
            mostrarToast("¡Te has unido al grupo!");
            cerrarModal('modal-crear');
            document.getElementById('codigo-unirse-input').value = '';
            cargarMisGrupos();
        } else {
            const err = await respuesta.json();
            mostrarToast("⚠️ Error: " + traducirErrorAuth(err.detail));
        }
    } catch (e) { console.error(e); }
}

async function cargarMisGrupos() {
    const correoUsuario = localStorage.getItem('usuarioCorreo');
    if (!correoUsuario) return;

    // Usamos el Skeleton Loader apuntando al contenedor real
    mostrarSkeletonGrupos('contenedor-grupos');

    try {
        const respuesta = await fetchConAuth(`/api/grupos/mis-grupos`);
        const datos = await respuesta.json();

        if (respuesta.ok) {
            const contenedor = document.getElementById('contenedor-grupos');
            let htmlGrupos = '';
            if (datos.grupos.length === 0) {
                htmlGrupos = `
                <div class="flex flex-col items-center justify-center text-center p-8 bg-white dark:bg-gray-800 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-700 col-span-full animar-entrada min-h-[60vh]">
                    
                    <div class="w-32 h-32 mb-8 relative flex items-center justify-center bg-gradient-to-tr from-primary-100 to-indigo-50 dark:from-gray-700 dark:to-gray-800 rounded-full shadow-inner border-[8px] border-white dark:border-gray-800">
                        <span class="text-6xl drop-shadow-lg transform hover:scale-110 transition-transform duration-300">⚽</span>
                        
                        <div class="absolute -bottom-2 -right-2 bg-gradient-to-r from-green-400 to-green-500 text-white p-2.5 rounded-full border-4 border-white dark:border-gray-800 shadow-md">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M12 4v16m8-8H4"></path></svg>
                        </div>
                    </div>
                    
                    <h3 class="text-3xl font-black text-gray-800 dark:text-white mb-3">¡Aún no estás en la cancha!</h3>
                    <p class="text-gray-500 dark:text-gray-400 mb-8 max-w-md mx-auto font-medium text-lg">
                        Crea tu primer grupo para invitar a tus amigos o únete a uno existente con un código de invitación. ¡Demuestra quién sabe más de fútbol!
                    </p>
                    
                    <div class="flex flex-col sm:flex-row gap-4 w-full justify-center max-w-lg">
                        <button onclick="abrirModal('modal-crear')" class="flex-1 bg-gradient-to-r from-primary to-primary-700 hover:from-blue-700 hover:to-primary-800 text-white font-bold py-4 px-6 rounded-2xl shadow-xl shadow-primary-500/30 transition transform hover:-translate-y-1 active:scale-95 flex items-center justify-center gap-2">
                            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                            Crear mi primer grupo
                        </button>
                        
                        <button onclick="abrirModal('modal-crear')" class="flex-1 bg-white dark:bg-gray-700 text-gray-800 dark:text-white border-2 border-gray-200 dark:border-gray-600 hover:border-primary-500 dark:hover:border-primary-700 font-bold py-4 px-6 rounded-2xl transition transform hover:-translate-y-1 active:scale-95 flex items-center justify-center gap-2">
                            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
                            Unirme a un grupo
                        </button>
                    </div>
                </div>
                `;
            } else {
                if (datos.grupos.length < 5) {
                    htmlGrupos += `
                        <button onclick="abrirModal('modal-crear')" class="group bg-primary-50/50 dark:bg-primary-100/10 border-2 border-dashed border-primary-200 dark:border-blue-700 rounded-[2rem] p-6 flex flex-col items-center justify-center text-primary dark:text-primary-700 hover:bg-primary-100 transition-all min-h-[180px]">
                            <span class="font-bold text-lg">+ Nuevo Grupo</span>
                        </button>
                    `;
                }

                datos.grupos.forEach(g => {
                    const esEuropa = g.liga === 'champions';
                    const esBetplay = g.liga === 'betplay';

                    let colorTema = 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
                    let iconoTema = '🌎 Libertadores';

                    if (esEuropa) {
                        colorTema = 'bg-indigo-100 text-primary-800 dark:bg-indigo-900 dark:text-indigo-300';
                        iconoTema = '🏆 Champions';
                    } else if (esBetplay) {
                        colorTema = 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-400';
                        iconoTema = '🇨🇴 Liga BetPlay';
                    }

                    const esCreador = correoUsuario === g.correo_creador;
                    const iconTitle = esCreador ? "Eliminar Grupo" : "Salir del Grupo";
                    const iconSvg = esCreador
                        ? `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>`
                        : `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>`;

                    htmlGrupos += `
                    <div class="bg-white dark:bg-gray-800 rounded-[2rem] p-6 shadow-lg border border-gray-100 dark:border-gray-700 flex flex-col justify-between min-h-[180px] animar-entrada relative">
                        
                        <button onclick="accionRapidaGrupo(${g.id}, '${escJs(g.correo_creador)}')" title="${iconTitle}" class="absolute top-4 right-4 text-gray-400 hover:text-red-500 bg-gray-50 dark:bg-gray-700/50 hover:bg-red-50 dark:hover:bg-red-900/30 p-2.5 rounded-full transition z-10 shadow-sm">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">${iconSvg}</svg>
                        </button>

                        <div>
                            <div class="mb-2 pr-10 flex items-center gap-2">
                                <span class="${colorTema} text-[10px] font-black uppercase px-2 py-1 rounded-md inline-block">${iconoTema}</span>
                            </div>
                            <h4 class="text-xl font-black text-gray-800 dark:text-white leading-tight pr-8 truncate">${escHtml(g.nombre)}</h4>
                            <div class="flex items-center gap-2 mt-1">
                                <p class="text-xs text-gray-400">Cód: <span class="font-bold text-primary-500 uppercase">${escHtml(g.codigo)}</span></p>
                                <button onclick="compartirCodigoDesdeDashboard('${escJs(g.codigo)}', event)" class="text-gray-400 hover:text-primary-500 transition ml-2" title="Compartir este código">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"></path></svg>
                                </button>
                            </div>
                        </div>
                        
                        <button onclick="entrarSalaGrupo(${g.id}, '${escJs(g.nombre)}', '${escJs(g.codigo)}', '${escJs(g.liga)}', '${escJs(g.correo_creador)}')" class="mt-4 w-full bg-primary hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition">
                            Entrar a la Sala
                        </button>
                    </div>
                    `;
                });
            }
            contenedor.innerHTML = htmlGrupos;
        }
    } catch (e) { console.error(e); }
}

function compartirCodigoDesdeDashboard(codigo, event) {
    if (event) event.stopPropagation(); // Evita que se abra la sala si se hace clic accidentalmente
    const urlApp = window.location.href.split('#')[0];
    const texto = `¡Únete a mi Polla Futbolera! ⚽\nIngresa con este código: ${codigo}\n\nJuega aquí: ${urlApp}`;
    if (navigator.share) {
        navigator.share({ title: 'Polla Futbolera', text: texto });
    } else {
        navigator.clipboard.writeText(texto).then(() => {
            mostrarToast("✅ Código y enlace copiados al portapapeles");
        }).catch(() => {
            mostrarToast("❌ Error al copiar el código");
        });
    }
}

async function accionRapidaGrupo(grupo_id, correo_creador) {
    const correo_usuario = localStorage.getItem('usuarioCorreo');

    if (correo_usuario === correo_creador) {
        const ok = await confirmarAccion("⚠️ ¿Estás seguro de eliminar este grupo?\n\nSe borrarán TODOS los pronósticos de los miembros y la sala dejará de existir. Esta acción no se puede deshacer.");
        if (!ok) return;

        try {
            const res = await fetchConAuth('/api/grupos/eliminar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ grupo_id: parseInt(grupo_id), correo_usuario })
            });
            if (res.ok) {
                mostrarToast("El grupo ha sido eliminado exitosamente. 🗑️");
                cargarMisGrupos();
            } else {
                const err = await res.json();
                mostrarToast("⚠️ Error: " + err.detail);
            }
        } catch (e) { console.error(e); }
    } else {
        const ok = await confirmarAccion("⚠️ ¿Estás seguro de que quieres salir del grupo?\n\nPerderás todos los pronósticos y puntos que tenías en esta sala.");
        if (!ok) return;

        try {
            const res = await fetchConAuth('/api/grupos/salir', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ grupo_id: parseInt(grupo_id), correo_usuario })
            });
            if (res.ok) {
                mostrarToast("Has salido del grupo correctamente. 👋");
                cargarMisGrupos();
            } else {
                const err = await res.json();
                mostrarToast("⚠️ Error: " + err.detail);
            }
        } catch (e) { console.error(e); }
    }
}

function entrarSalaGrupo(id, nombre, codigo, liga, correo_creador) {
    // 1. Guardar estado persistentemente
    localStorage.setItem('grupoActivoId', id);
    localStorage.setItem('grupoActivoLiga', liga || 'champions');
    localStorage.setItem('grupoActivoCodigo', codigo);
    localStorage.setItem('grupoActivoNombre', nombre);
    localStorage.setItem('grupoActivoCreador', correo_creador);

    window.limpiarCachePronosticos(); // Invalida el cache al cambiar de grupo
    detenerPollingChat();

    // 2. Navegar. El hook 'vista-grupo' en ui.js se encargará de la inicialización real
    cambiarPantalla('vista-grupo');
}

// NUEVA FUNCIÓN: Punto único de entrada para renderizar la sala de grupo (evita doble carga)
function inicializarVistaGrupo() {
    const id = localStorage.getItem('grupoActivoId');
    const nombre = localStorage.getItem('grupoActivoNombre');
    const codigo = localStorage.getItem('grupoActivoCodigo');
    const creador = localStorage.getItem('grupoActivoCreador');
    const correoUsuario = localStorage.getItem('usuarioCorreo');

    if (!id || !nombre) {
        return cambiarPantalla('vista-dashboard');
    }

    // Actualizar etiquetas UI
    document.getElementById('sala-nombre-grupo').innerText = nombre;
    document.getElementById('sala-codigo-grupo').innerText = `ID: ${codigo}`;

    // Cargar datos
    cargarPartidos();
    iniciarPollingChat();
    poblarListaAvatares();
    if (typeof inicializarStats === 'function') inicializarStats();
}

function toggleChat() {
    const p = document.getElementById('panel-chat');
    p.classList.toggle('translate-x-full');
    if (!p.classList.contains('translate-x-full')) {
        document.getElementById('notif-chat').classList.add('hidden');
        cargarChat();
        setTimeout(() => {
            const c = document.getElementById('chat-mensajes-container');
            c.scrollTop = c.scrollHeight;
        }, 300);
    }
}

async function cargarChat() {
    const gid = localStorage.getItem('grupoActivoId');
    const container = document.getElementById('chat-mensajes-container');
    const miCorreo = localStorage.getItem('usuarioCorreo');
    const esDelta = !!_ultimoChatFecha;

    try {
        const url = esDelta ? `/api/chat/${gid}?since=${_ultimoChatFecha}` : `/api/chat/${gid}`;
        const res = await fetchConAuth(url);
        const d = await res.json();
        if (res.ok && d.mensajes.length > 0) {
            const panel = document.getElementById('panel-chat');
            const estaAbierto = panel && !panel.classList.contains('translate-x-full');
            const miCorreo = localStorage.getItem('usuarioCorreo');

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
    } catch (e) { console.error(e); }
}

window.enviarMensajeChat = async function(e) {
    if (e) e.preventDefault();
    const input = document.getElementById('chat-input');
    const msj = input.value.trim();
    if (!msj) return;

    const gid = localStorage.getItem('grupoActivoId');
    input.value = '';

    try {
        const res = await fetchConAuth('/api/chat/enviar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grupo_id: parseInt(gid), mensaje: msj })
        });
        if (res.ok) {
            cargarChat();
        }
    } catch (e) { 
        console.error(e);
        mostrarToast("⚠️ Error al enviar mensaje");
    }
};

window.iniciarPollingChat = function() {
    window.detenerPollingChat();
    cargarChat();
    
    // Polling dinámico: más rápido si el chat está abierto, más lento si está cerrado
    _intervaloChat = setInterval(() => {
        const hash = window.location.hash;
        // Permitir polling en dashboard y grupo para notificaciones globales
        if (hash === '#vista-grupo' || hash === '#vista-dashboard' || hash === '#vista-partido') {
            const panel = document.getElementById('panel-chat');
            const estaAbierto = panel && !panel.classList.contains('translate-x-full');
            
            // Si está abierto, refrescamos cada ciclo (3s)
            // Si está cerrado, refrescamos solo 1 de cada 4 ciclos (~12s) para ahorrar batería
            const cicloLento = Math.floor(Date.now() / 3000) % 4 === 0;

            if (estaAbierto || cicloLento) {
                cargarChat();
            }
        } else {
            window.detenerPollingChat();
        }
    }, 3000);
};

// Función movida al inicio para visibilidad global

function poblarListaAvatares() {
    const lista = document.getElementById('lista-avatars');
    if (!lista) return;
    
    const actual = localStorage.getItem('usuarioAvatar') || '👤';
    let h = '';
    AVATARES_EXTENDIDOS.forEach(av => {
        const sel = av === actual ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20' : 'border-transparent bg-gray-100 dark:bg-gray-700';
        h += `<button onclick="seleccionarAvatar('${av}')" class="avatar-option w-10 h-10 flex items-center justify-center rounded-full text-xl border-2 transition ${sel}">${av}</button>`;
    });
    lista.innerHTML = h;
}

function logicPredict() {
    const inputs = document.querySelectorAll('.pronostico-input');
    if (inputs.length === 0) {
        return mostrarToast("💡 Abre los detalles de un partido para usar el autocompletado.");
    }
    
    let count = 0;
    inputs.forEach(inp => {
        if (!inp.value || inp.value === '') {
            // El ID generado en verDetallesPartido usa '-l-' para local
            const esLocal = inp.id.includes('-l-');
            inp.value = esLocal ? 1 : 0;
            count++;
        }
    });
    if (count > 0) mostrarToast(`Se completaron ${count} campos con lógica (1-0) 📊`);
    else mostrarToast("ℹ️ Todos los campos ya tienen un valor.");
}

function luckyPredict() {
    const inputs = document.querySelectorAll('.pronostico-input');
    if (inputs.length === 0) {
        return mostrarToast("💡 Abre los detalles de un partido para usar el autocompletado.");
    }

    let count = 0;
    inputs.forEach(inp => {
        if (!inp.value || inp.value === '') {
            inp.value = Math.floor(Math.random() * 4); // 0 a 3 goles es más realista
            count++;
        }
    });
    if (count > 0) mostrarToast(`¡Dados lanzados! ${count} campos completados 🎲`);
    else mostrarToast("ℹ️ Todos los campos ya tienen un valor.");
}

async function compartirGrupo() {
    const codigo = localStorage.getItem('grupoActivoCodigo');
    if (!codigo) {
        if (typeof mostrarToast === 'function') mostrarToast('⚠️ No se encontró el código del grupo.');
        return;
    }

    // Extraemos el link raíz de tu aplicación para la invitación
    const linkApp = window.location.origin + window.location.pathname;
    const textoMensaje = `¡Únete a mi Polla Futbolera! Entra a ${linkApp} y usa el código ${codigo}`;

    // Validar si el navegador del celular soporta la API nativa de compartir
    if (navigator.share) {
        try {
            await navigator.share({
                title: 'Únete a mi Polla Futbolera ⚽',
                text: textoMensaje
            });
        } catch (error) {
            console.log('El usuario canceló la acción o hubo un error al compartir:', error);
        }
    } else {
        // Fallback: Si se abre desde una PC o navegador sin soporte, lo copiamos al portapapeles
        try {
            await navigator.clipboard.writeText(textoMensaje);
            if (typeof mostrarToast === 'function') {
                mostrarToast('¡Enlace de invitación copiado al portapapeles! 📋');
            } else {
                alert('¡Enlace copiado al portapapeles!');
            }
        } catch (err) {
            console.error('Error al copiar al portapapeles: ', err);
            if (typeof mostrarToast === 'function') mostrarToast('⚠️ No se pudo copiar el enlace.');
        }
    }
}

async function eliminarGrupoActual() {
    const ok = await confirmarAccion("⚠️ ¿Estás seguro de eliminar este grupo?\n\nSe borrarán TODOS los pronósticos de los miembros y la sala dejará de existir. Esta acción no se puede deshacer.");
    if (!ok) return;

    const grupo_id = localStorage.getItem('grupoActivoId');
    const correo_usuario = localStorage.getItem('usuarioCorreo');

    try {
        const res = await fetchConAuth('/api/grupos/eliminar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grupo_id: parseInt(grupo_id), correo_usuario })
        });
        if (res.ok) {
            mostrarToast("El grupo ha sido eliminado exitosamente. 🗑️");
            cambiarPantalla('vista-dashboard');
            cargarMisGrupos();
        } else {
            const err = await res.json();
            mostrarToast("⚠️ Error: " + err.detail);
        }
    } catch (e) { console.error(e); }
}

async function salirGrupoActual() {
    const ok = await confirmarAccion("⚠️ ¿Estás seguro de que quieres salir del grupo?\n\nPerderás todos los pronósticos y puntos que tenías en esta sala.");
    if (!ok) return;

    const grupo_id = localStorage.getItem('grupoActivoId');
    const correo_usuario = localStorage.getItem('usuarioCorreo');

    try {
        const res = await fetchConAuth('/api/grupos/salir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grupo_id: parseInt(grupo_id), correo_usuario })
        });
        if (res.ok) {
            mostrarToast("Has salido del grupo correctamente. 👋");
            cambiarPantalla('vista-dashboard');
            cargarMisGrupos();
        } else {
            const err = await res.json();
            mostrarToast("⚠️ Error: " + err.detail);
        }
    } catch (e) { console.error(e); }
}

async function cargarPartidos() {
    const cont = document.getElementById('contenedor-partidos');

    let skeletonHTML = '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">';
    for (let i = 0; i < 6; i++) {
        skeletonHTML += `
            <div class="bg-white dark:bg-gray-800 rounded-3xl p-5 shadow-sm border border-gray-100 dark:border-gray-700 animate-pulse flex flex-col justify-between h-full min-h-[160px]">
                <div>
                    <div class="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-4 mx-auto"></div>
                    <div class="flex justify-between items-center w-full">
                        <div class="flex-1 flex flex-col items-center">
                            <div class="w-10 h-10 md:w-12 md:h-12 bg-gray-200 dark:bg-gray-700 rounded-full mb-2"></div>
                            <div class="h-3 bg-gray-200 dark:bg-gray-700 rounded w-16"></div>
                        </div>
                        <div class="shrink-0 px-2"><div class="w-8 h-6 bg-gray-200 dark:bg-gray-700 rounded-full"></div></div>
                        <div class="flex-1 flex flex-col items-center">
                            <div class="w-10 h-10 md:w-12 md:h-12 bg-gray-200 dark:bg-gray-700 rounded-full mb-2"></div>
                            <div class="h-3 bg-gray-200 dark:bg-gray-700 rounded w-16"></div>
                        </div>
                    </div>
                </div>
                <div class="mt-4 h-8 bg-gray-100 dark:bg-gray-700/50 rounded-xl w-full"></div>
            </div>
        `;
    }
    skeletonHTML += '</div>';
    cont.innerHTML = skeletonHTML;

    const liga = localStorage.getItem('grupoActivoLiga') || 'champions';

    try {
        const respuesta = await fetch(`/api/partidos/${liga}`);
        const datos = await respuesta.json();

        if (respuesta.ok && datos.estado === 'exito') {
            partidosGlobales = datos.partidos;

            // 1. Separar y clasificar partidos
            const pVivo = partidosGlobales.filter(p => p.estado === 'in');
            const pProx = partidosGlobales.filter(p => p.estado === 'pre').sort((a,b) => new Date(a.fecha) - new Date(b.fecha));
            const pRes = partidosGlobales.filter(p => p.estado === 'post').sort((a,b) => new Date(b.fecha) - new Date(a.fecha));

            let htmlVivo = '', htmlProx = '', htmlRes = '';
            let cVivo = pVivo.length, cProx = pProx.length, cRes = pRes.length;

            const proximoId = pProx.length > 0 ? pProx[0].id_partido : null;

            function generarHTML(p, index) {
                const logos = [p.local_logo, p.visitante_logo].map(l => l || LOGO_FALLBACK);
                const f = new Date(p.fecha);
                const delay = (index * 0.05).toFixed(2);
                return `
                <div onclick="verDetallesPartido('${p.id_partido}')" class="tarjeta-partido cursor-pointer animar-entrada bg-white dark:bg-gray-800 rounded-3xl p-5 shadow-sm border border-gray-100 dark:border-gray-700 text-center hover:border-primary-200 transition-colors h-full flex flex-col justify-between relative" style="animation-delay: ${delay}s">
                    <div>
                        ${p.id_partido === proximoId ? `<div class="absolute top-2 right-2 bg-orange-500 text-white text-[7px] font-black px-1.5 py-0.5 rounded-full uppercase tracking-wide shadow-sm">🔜 Próximo</div>` : ''}
                        <div class="text-[10px] text-gray-400 font-bold mb-1 uppercase tracking-wider">${f.toLocaleString('es-ES', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                        ${p.estado === 'pre' ? `<div class="text-[11px] font-black text-orange-600 dark:text-orange-400 bg-orange-100 dark:bg-orange-900/30 py-1 px-3 rounded-full inline-block mb-3 temporizador-partido shadow-sm" data-fecha="${p.fecha}">Calculando...</div>` : '<div class="mb-3"></div>'}
                        <div class="flex justify-between items-center w-full">
                            <div class="flex-1 w-0 text-center">
                                <img src="${logos[0]}" class="w-10 h-10 md:w-12 md:h-12 mx-auto mb-1">
                                <span class="text-[10px] font-black truncate block px-1">${escHtml(p.local)}</span>
                            </div>
                            <div class="shrink-0 px-2 flex flex-col items-center justify-center">
                                ${p.estado === 'pre'
                        ? `<span class="bg-gray-100 dark:bg-gray-700 text-gray-500 text-xs font-bold px-3 py-1 rounded-full mb-1">VS</span>`
                        : `<div id="score-dash-${p.id_partido}" class="text-2xl sm:text-3xl font-black whitespace-nowrap ${p.estado === 'in' ? 'text-red-600' : 'text-gray-800 dark:text-white'}">${p.goles_l} - ${p.goles_v}</div>`
                    }
                            </div>
                            <div class="flex-1 w-0 text-center">
                                <img src="${logos[1]}" class="w-10 h-10 md:w-12 md:h-12 mx-auto mb-1">
                                <span class="text-[10px] font-black truncate block px-1">${escHtml(p.visitante)}</span>
                            </div>
                        </div>
                    </div>
                    <div id="pred-resumen-${p.id_partido}" class="mt-4 text-[11px] font-bold text-gray-400 bg-gray-50 dark:bg-gray-700/50 py-2 rounded-xl">
                        ${p.estado === 'pre' ? 'Haz clic para ver detalles o pronosticar' : 'Ver detalles y estadísticas'}
                    </div>
                </div>`;
            }

            pVivo.forEach((p, i) => htmlVivo += generarHTML(p, i));
            pProx.forEach((p, i) => htmlProx += generarHTML(p, i));
            pRes.forEach((p, i) => htmlRes += generarHTML(p, i));

            let btnRanking = `
                <div class="flex justify-end mb-6">
                    <button onclick="verTablaPosiciones()" class="bg-yellow-500 hover:bg-yellow-600 text-white font-black py-4 px-6 rounded-2xl shadow-lg transition transform active:scale-95 w-full md:w-auto">
                        🏆 VER RANKING DEL GRUPO
                    </button>
                </div>
            `;

            let htmlTabs = `
            <div class="flex overflow-x-auto gap-2 mb-6 border-b border-gray-200 dark:border-gray-700 pb-2" style="scrollbar-width: none;">
                <button onclick="cambiarTabFiltros('prox')" id="tab-filtro-prox" class="tab-filtro-btn px-4 py-3 text-sm font-black border-b-2 border-primary text-primary dark:text-primary-700 whitespace-nowrap transition-colors">
                    Pendientes <span class="ml-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 py-1 px-2.5 rounded-md text-[10px]">${cProx}</span>
                </button>
                <button onclick="cambiarTabFiltros('vivo')" id="tab-filtro-vivo" class="tab-filtro-btn px-4 py-3 text-sm font-bold border-b-2 border-transparent text-gray-500 dark:text-gray-400 whitespace-nowrap transition-colors">
                    En Juego <span class="ml-1 bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 py-1 px-2.5 rounded-md text-[10px]">${cVivo}</span>
                </button>
                <button onclick="cambiarTabFiltros('res')" id="tab-filtro-res" class="tab-filtro-btn px-4 py-3 text-sm font-bold border-b-2 border-transparent text-gray-500 dark:text-gray-400 whitespace-nowrap transition-colors">
                    Finalizados <span class="ml-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 py-1 px-2.5 rounded-md text-[10px]">${cRes}</span>
                </button>
            </div>
            `;

            let gridVivo = cVivo === 0
                ? `<p class="text-xs text-gray-400 italic mt-4 text-center bg-gray-50 dark:bg-gray-800/50 py-8 rounded-2xl col-span-full border border-dashed border-gray-200 dark:border-gray-700">No hay partidos en juego en este momento.</p>`
                : htmlVivo;

            let gridProx = cProx === 0
                ? `<p class="text-xs text-gray-400 italic mt-4 text-center bg-gray-50 dark:bg-gray-800/50 py-8 rounded-2xl col-span-full border border-dashed border-gray-200 dark:border-gray-700">No hay partidos pendientes.</p>`
                : htmlProx;

            let gridRes = cRes === 0
                ? `<p class="text-xs text-gray-400 italic mt-4 text-center bg-gray-50 dark:bg-gray-800/50 py-8 rounded-2xl col-span-full border border-dashed border-gray-200 dark:border-gray-700">Aún no hay resultados para mostrar.</p>`
                : htmlRes;

            let contenidoPestanas = `
            <div id="tab-content-filtro-prox" class="tab-filtro-content grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
                ${gridProx}
            </div>
            
            <div id="tab-content-filtro-vivo" class="tab-filtro-content hidden grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
                ${gridVivo}
            </div>
            
            <div id="tab-content-filtro-res" class="tab-filtro-content hidden grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
                ${gridRes}
            </div>
            `;

            // Barra de progreso de pronósticos
            let htmlProgreso = `
            <div id="barra-progreso" class="mb-4 bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-700 animar-entrada">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-xs font-bold text-gray-500 dark:text-gray-400">📊 Mis Pronósticos</span>
                    <span id="progreso-label" class="text-xs font-black text-primary dark:text-primary-700">0/${cProx}</span>
                </div>
                <div class="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                    <div id="progreso-fill" class="bg-primary-500 h-2 rounded-full transition-all duration-700 ease-out" style="width: 0%"></div>
                </div>
            </div>`;

            cont.innerHTML = htmlProgreso + btnRanking + htmlTabs + contenidoPestanas;

            // Reiniciar interval de temporizadores
            clearInterval(_intervaloTemp);
            _intervaloTemp = setInterval(() => {
                const quedan = document.querySelectorAll('.temporizador-partido');
                if (quedan.length === 0) { clearInterval(_intervaloTemp); return; }
                actualizarTemporizadores();
            }, 1000);
            actualizarTemporizadores();

            // Restaurar tab activa (memoria de navegación)
            const tabGuardada = localStorage.getItem('tabFiltroActual');
            cambiarTabFiltros(tabGuardada && ['prox', 'vivo', 'res'].includes(tabGuardada) ? tabGuardada : (cVivo > 0 ? 'vivo' : 'prox'));

            cargarMisPronosticosResumen();
            agregarSwipeTabs();

            // Configurar Polling en vivo para los partidos 'in'
            if (typeof _intervaloLive !== 'undefined') clearInterval(_intervaloLive);
            if (cVivo > 0) {
                _intervaloLive = setInterval(async () => {
                    try {
                        const res = await fetch(`/api/partidos/${liga}`);
                        const d = await res.json();
                        if (res.ok && d.estado === 'exito') {
                            // Si algún partido cambió de estado (ej: pasó de 'in' a 'post'), limpiamos cache
                            const hudoCambioEstado = d.partidos.some((p, i) => p.estado !== (partidosGlobales[i]?.estado));
                            if (hudoCambioEstado) window.limpiarCachePronosticos();
                            
                            partidosGlobales = d.partidos; // Actualizar cache interno

                            // 1. Actualizar vistas de lista (Grupo o Dashboard general si aplicara)
                            if (['', '#vista-grupo', '#vista-dashboard'].includes(window.location.hash)) {
                                d.partidos.filter(p => p.estado === 'in').forEach(p => {
                                    const scoreDash = document.getElementById(`score-dash-${p.id_partido}`);
                                    if (scoreDash) {
                                        scoreDash.innerText = `${p.goles_l} - ${p.goles_v}`;
                                    }
                                });
                            }

                            // 2. Actualizar la vista de detalles del partido si está abierta
                            if (window.location.hash === '#vista-partido') {
                                const activeId = localStorage.getItem('partidoActivoId');
                                if (activeId) {
                                    const activeMatch = d.partidos.find(p => p.id_partido === activeId);
                                    if (activeMatch && activeMatch.estado === 'in') {
                                        const scoreMain = document.getElementById('score-main-live');
                                        const clockMain = document.getElementById('clock-main-live');
                                        const eventMain = document.getElementById('event-main-live');

                                        if (scoreMain) scoreMain.innerText = `${activeMatch.goles_l} - ${activeMatch.goles_v}`;
                                        if (clockMain && activeMatch.reloj) {
                                            clockMain.innerHTML = `<span class="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span> EN VIVO ${activeMatch.reloj}`;
                                        }
                                        if (eventMain && activeMatch.ultimo_evento) {
                                            eventMain.classList.remove('hidden');
                                            eventMain.innerHTML = `⚽ <strong>Última Jugada:</strong> ${escHtml(activeMatch.ultimo_evento)}`;
                                        }
                                    }
                                    
                                    // Refrescar cronología y extras (Novedad v28 - Siempre refresca si está en vivo)
                                    // Pasamos activeId y estado 'in' forzado para activar el reloj en el header
                                    if (typeof cargarExtrasPartido === 'function') {
                                        cargarExtrasPartido(activeId, 'in', true);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.error("Error en polling:", e);
                    }
                }, 15000); // 15 segundos (Real-time optimizado v28)
            }

        }
    } catch (e) { console.error(e); }
}

async function cargarMisPronosticosResumen() {
    const gid = localStorage.getItem('grupoActivoId');
    const correo = localStorage.getItem('usuarioCorreo');
    try {
        const r = await fetchConAuth(`/api/pronosticos/${gid}/${correo}`);
        const d = await r.json();
        misPronosticosCache = d.pronosticos;
        misPronosticosCacheGid = gid;
        d.pronosticos.forEach(p => {
            const divP = document.getElementById(`pred-resumen-${p.id_partido}`);
            if (divP) {
                divP.classList.replace('text-gray-400', 'text-primary');
                divP.classList.replace('dark:text-gray-400', 'dark:text-primary-700');
                divP.classList.replace('bg-gray-50', 'bg-primary-50');
                divP.classList.replace('dark:bg-gray-700/50', 'dark:bg-primary-900/20');
                divP.innerHTML = `Tu pronóstico: <span class="font-black text-sm ml-1">${p.goles_local} - ${p.goles_visitante}</span>`;
                divP.dataset.hasPrediction = 'true';
            }
        });
        actualizarBarraProgreso();
    } catch (e) { console.error(e); }
}

function calcularTiempoAmigable(fechaPartido) {
    const ahora = new Date();
    const fecha = new Date(fechaPartido);
    const diferenciaMs = fecha - ahora;

    if (diferenciaMs <= 0) return "En juego / Finalizado";

    const minTotales = Math.floor(diferenciaMs / 1000 / 60);
    const horasTotales = Math.floor(minTotales / 60);
    const diasTotales = Math.floor(horasTotales / 24);
    const mesesTotales = Math.floor(diasTotales / 30);

    if (mesesTotales > 0) {
        const diasSobrantes = diasTotales % 30;
        return diasSobrantes > 0 ? `${mesesTotales} mes(es) ${diasSobrantes}d` : `${mesesTotales} mes(es)`;
    } else if (diasTotales > 0) {
        const horasSobrantes = horasTotales % 24;
        return horasSobrantes > 0 ? `${diasTotales}d ${horasSobrantes}h` : `${diasTotales}d`;
    } else {
        const minSobrantes = minTotales % 60;
        return `${horasTotales}h ${minSobrantes}m`;
    }
}

window.cambiarTabPartido = function (tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('border-primary', 'text-primary', 'dark:text-primary-700');
        btn.classList.add('border-transparent', 'text-gray-500', 'dark:text-gray-400');
    });

    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.add('hidden');
    });

    const btnActivo = document.getElementById(`tab-${tabName}`);
    const contenidoActivo = document.getElementById(`tab-content-${tabName}`);

    if (btnActivo && contenidoActivo) {
        btnActivo.classList.remove('border-transparent', 'text-gray-500', 'dark:text-gray-400');
        btnActivo.classList.add('border-primary', 'text-primary', 'dark:text-primary-700');
        contenidoActivo.classList.remove('hidden');
    }
}

function mostrarSkeletonGrupos(contenedorId) {
    const contenedor = document.getElementById(contenedorId);
    if (!contenedor) return;

    let skeletons = '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">';

    // Generamos 3 esqueletos de grupos
    for (let i = 0; i < 3; i++) {
        skeletons += `
        <div class="bg-white dark:bg-gray-800 rounded-[2rem] p-6 shadow-lg border border-gray-100 dark:border-gray-700 flex flex-col justify-between min-h-[180px] animate-pulse">
            <div>
                <div class="h-5 bg-gray-200 dark:bg-gray-700 rounded-md w-1/4 mb-3"></div>
                <div class="h-6 bg-gray-300 dark:bg-gray-600 rounded-md w-3/4 mb-2"></div>
                <div class="h-4 bg-gray-200 dark:bg-gray-700 rounded-md w-1/2"></div>
            </div>
            <div class="mt-4 h-12 bg-gray-200 dark:bg-gray-700 rounded-xl w-full"></div>
        </div>
        `;
    }
    skeletons += '</div>';

    contenedor.innerHTML = skeletons;
}

let _fetchIdDetalle = 0;
async function verDetallesPartido(idPartido) {
    const currentId = ++_fetchIdDetalle;
    // Guardar en memoria para persistencia al recargar página
    localStorage.setItem('partidoActivoId', idPartido);

    // ✅ HUD de carga intermedio
    const dinMain = document.getElementById('info-partido-dinamica');
    if (dinMain) {
        dinMain.innerHTML = `
            <div class="flex flex-col items-center justify-center py-20 animate-pulse">
                <div class="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mb-4">
                    <svg class="animate-spin h-8 w-8 text-primary" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                </div>
                <p class="text-gray-400 font-bold text-sm">Cargando detalles del encuentro...</p>
            </div>
        `;
    }

    // ✅ HIDRATACIÓN: Si no hay partidos en memoria (ej: recarga de página), los buscamos
    if (partidosGlobales.length === 0) {
        const liga = localStorage.getItem('grupoActivoLiga') || 'champions';
        try {
            const res = await fetch(`/api/partidos/${liga}`);
            const d = await res.json();
            if (res.ok && d.estado === 'exito') {
                partidosGlobales = d.partidos;
            }
        } catch (e) { console.error("Error hidratando partido:", e); }
    }
    
    // ✅ RACE CONDITION PROTECTION: Si el usuario ya cambió de opinión y abrió otro partido, cancelamos este renderizado
    if (currentId !== _fetchIdDetalle) return;
    
    const partido = partidosGlobales.find(p => p.id_partido === idPartido);
    if (!partido) {
        // Fallback: si aún no lo encuentra (ID inválido o liga errónea), volvemos al dashboard
        cambiarPantalla('vista-dashboard');
        return;
    }

    const fechaPartido = new Date(partido.fecha);
    const ahora = new Date();

    const diferenciaMinutos = (fechaPartido - ahora) / (1000 * 60);
    const bloqueado = partido.estado !== 'pre' || diferenciaMinutos <= 10;

    const correo = localStorage.getItem('usuarioCorreo');
    const gid = localStorage.getItem('grupoActivoId');
    let miPronostico = { l: "", v: "" };

    if (misPronosticosCacheGid === gid && misPronosticosCache) {
        const pr = misPronosticosCache.find(x => x.id_partido === idPartido);
        if (pr) { miPronostico.l = pr.goles_local; miPronostico.v = pr.goles_visitante; }
    } else {
        try {
            const r = await fetchConAuth(`/api/pronosticos/${gid}/${correo}`);
            const d = await r.json();
            misPronosticosCache = d.pronosticos;
            misPronosticosCacheGid = gid;
            const pr = d.pronosticos.find(x => x.id_partido === idPartido);
            if (pr) { miPronostico.l = pr.goles_local; miPronostico.v = pr.goles_visitante; }
        } catch (e) { }
    }

    const logos = [partido.local_logo, partido.visitante_logo].map(l => l || LOGO_FALLBACK);
    const mapLigas = { 'libertadores': 'Copa Libertadores', 'betplay': 'Liga BetPlay', 'champions': 'UEFA Champions League' };
    const ligaActual = mapLigas[localStorage.getItem('grupoActivoLiga')] || 'Competición';

    // Badge más compacto
    let badgeEstado = '';
    if (partido.estado === 'in') {
        badgeEstado = `<span id="clock-main-live" class="flex items-center justify-center gap-1 text-[10px] font-black text-white bg-red-600 px-3 py-1 rounded-full uppercase tracking-wider shadow-sm">
            <span class="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span> EN VIVO ${partido.reloj || ''}
        </span>`;
    } else if (partido.estado === 'post') {
        badgeEstado = `<span class="text-[10px] font-black text-gray-500 bg-gray-100 dark:bg-gray-700 dark:text-gray-300 px-3 py-1 rounded-full uppercase tracking-wider">FINALIZADO</span>`;
    } else {
        badgeEstado = `<span class="text-[10px] font-bold text-primary-500 bg-primary-50 dark:bg-primary-100/30 px-3 py-1 rounded-full uppercase tracking-wider">
            ${fechaPartido.toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </span>`;
    }

    let html = `
        <div class="bg-white dark:bg-gray-800 rounded-[1.5rem] p-4 shadow-sm border border-gray-100 dark:border-gray-700 mb-3 animar-entrada relative overflow-hidden">
            ${partido.estado === 'in' ? `<div class="absolute inset-0 bg-gradient-to-b from-red-50/50 to-transparent dark:from-red-900/10 pointer-events-none"></div>` : ''}
            
            <div class="flex justify-between items-center relative z-10 w-full">
                <div class="flex-1 w-0 text-center">
                    <img src="${logos[0]}" class="w-10 h-10 md:w-12 md:h-12 mx-auto mb-1 drop-shadow-md">
                    <h3 class="font-black text-[11px] md:text-xs leading-tight break-words px-1">${escHtml(partido.local)}</h3>
                </div>
                
                <div class="shrink-0 px-2 text-center flex flex-col items-center justify-center">
                    <div class="mb-1.5">${badgeEstado}</div>
                    ${partido.estado === 'pre'
            ? `<span class="text-2xl md:text-3xl font-black text-gray-300 dark:text-gray-600 leading-none">VS</span>`
            : `<div id="score-main-live" class="text-3xl md:text-4xl font-black leading-none whitespace-nowrap ${partido.estado === 'in' ? 'text-red-600 drop-shadow-sm' : 'text-gray-800 dark:text-white'}">${partido.goles_l} - ${partido.goles_v}</div>`
        }
                </div>

                <div class="flex-1 w-0 text-center">
                    <img src="${logos[1]}" class="w-10 h-10 md:w-12 md:h-12 mx-auto mb-1 drop-shadow-md">
                    <h3 class="font-black text-[11px] md:text-xs leading-tight break-words px-1">${escHtml(partido.visitante)}</h3>
                </div>
            </div>
            
            <div id="event-main-live" class="${partido.estado === 'in' && partido.ultimo_evento ? '' : 'hidden'} mt-4 bg-orange-50 dark:bg-orange-900/20 text-orange-800 dark:text-orange-200 text-xs text-center py-2 px-3 rounded-xl border border-orange-100 dark:border-orange-800/50 shadow-inner font-medium">
                ${partido.ultimo_evento ? `⚽ <strong>Última Jugada:</strong> ${escHtml(partido.ultimo_evento)}` : ''}
            </div>

        </div>

        <div class="bg-white dark:bg-gray-800 rounded-[1.5rem] p-3 shadow-sm border border-gray-100 dark:border-gray-700 mb-4 animar-entrada" style="animation-delay: 0.1s">
            ${bloqueado ? `
                <div class="flex items-center justify-between bg-gray-50 dark:bg-gray-700/50 px-4 py-2.5 rounded-xl border border-gray-100 dark:border-gray-700">
                    <div class="flex items-center gap-2 text-red-500 dark:text-red-400 text-xs font-bold">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
                        <span class="hidden xs:inline">${partido.estado !== 'pre' ? 'En juego/Finalizado' : 'Pronóstico cerrado'}</span>
                    </div>
                    ${miPronostico.l !== "" ? `
                        <div class="font-bold text-gray-800 dark:text-gray-200 text-xs">
                            Tu apuesta: <span class="text-primary dark:text-primary-700 ml-1 text-base font-black">${miPronostico.l} - ${miPronostico.v}</span>
                        </div>
                    ` : `<div class="font-bold text-gray-400 text-xs">Sin pronóstico</div>`}
                </div>
            ` : `
                <div class="flex flex-col sm:flex-row items-center justify-between gap-4 sm:gap-2">
                    <div class="flex justify-center items-center gap-2 sm:gap-3 w-full sm:flex-1">
                        <div class="flex flex-col items-center flex-1 sm:flex-none">
                            <span class="block text-[9px] font-bold text-gray-400 mb-1 uppercase tracking-wider">Local</span>
                            <div class="flex items-center rounded-xl border border-gray-200 dark:border-gray-600 overflow-hidden w-full sm:w-auto justify-center bg-gray-50 dark:bg-gray-700/50">
                                <button type="button" onclick="cambiarGol('input-det-l-${partido.id_partido}', -1, '${partido.id_partido}')" class="w-10 sm:w-9 h-12 text-lg text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-600 active:scale-95 transition font-black select-none">−</button>
                                <input type="number" id="input-det-l-${partido.id_partido}" value="${miPronostico.l}" min="0" readonly
                                    onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('input-det-v-${partido.id_partido}').select();}"
                                    class="pronostico-input w-12 sm:w-12 h-12 text-center text-xl font-black bg-transparent outline-none dark:text-white [appearance:textfield]">
                                <button type="button" onclick="cambiarGol('input-det-l-${partido.id_partido}', 1, '${partido.id_partido}')" class="w-10 sm:w-9 h-12 text-lg text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-600 active:scale-95 transition font-black select-none">+</button>
                            </div>
                        </div>
                        <span class="text-2xl font-black text-gray-300 dark:text-gray-600 mt-4 px-1 shrink-0">−</span>
                        <div class="flex flex-col items-center flex-1 sm:flex-none">
                            <span class="block text-[9px] font-bold text-gray-400 mb-1 uppercase tracking-wider">Visita</span>
                            <div class="flex items-center rounded-xl border border-gray-200 dark:border-gray-600 overflow-hidden w-full sm:w-auto justify-center bg-gray-50 dark:bg-gray-700/50">
                                <button type="button" onclick="cambiarGol('input-det-v-${partido.id_partido}', -1, '${partido.id_partido}')" class="w-10 sm:w-9 h-12 text-lg text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-600 active:scale-95 transition font-black select-none">−</button>
                                <input type="number" id="input-det-v-${partido.id_partido}" value="${miPronostico.v}" min="0" readonly
                                    onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('btn-guardar-${partido.id_partido}').click();}"
                                    class="pronostico-input w-12 sm:w-12 h-12 text-center text-xl font-black bg-transparent outline-none dark:text-white [appearance:textfield]">
                                <button type="button" onclick="cambiarGol('input-det-v-${partido.id_partido}', 1, '${partido.id_partido}')" class="w-10 sm:w-9 h-12 text-lg text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-600 active:scale-95 transition font-black select-none">+</button>
                            </div>
                        </div>
                    </div>
                    <button id="btn-guardar-${partido.id_partido}" onclick="guardarUnPronostico('${partido.id_partido}', this)" class="w-full sm:w-auto h-12 px-6 bg-primary hover:bg-blue-700 text-white font-black text-sm rounded-xl shadow-md transition transform active:scale-95 flex items-center justify-center gap-2 shrink-0">
                        <span>💾</span> <span>GUARDAR PRONÓSTICO</span>
                    </button>
                </div>
            `}
        </div>

        <div id="contenedor-info-estadisticas" class="bg-gray-50 dark:bg-gray-800/50 rounded-3xl pt-2 pb-6 px-4 sm:px-6 border border-gray-200 dark:border-gray-700 animar-entrada" style="animation-delay: 0.2s">
            
            <div class="w-full flex overflow-x-auto border-b border-gray-200 dark:border-gray-700 mb-4 sticky top-0 z-10" style="scrollbar-width: none;">
                <button onclick="cambiarTabPartido('cronologia')" id="tab-cronologia" class="tab-btn px-4 py-3 text-sm font-black border-b-2 border-primary text-primary dark:text-primary-700 whitespace-nowrap transition-colors">Cronología</button>
                <button onclick="cambiarTabPartido('alineaciones')" id="tab-alineaciones" class="tab-btn px-4 py-3 text-sm font-bold border-b-2 border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 whitespace-nowrap transition-colors">Alineaciones</button>
                <button onclick="cambiarTabPartido('estadisticas')" id="tab-estadisticas" class="tab-btn px-4 py-3 text-sm font-bold border-b-2 border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 whitespace-nowrap transition-colors">Estadísticas</button>
                <button onclick="cambiarTabPartido('pronosticos')" id="tab-pronosticos" class="tab-btn px-4 py-3 text-sm font-bold border-b-2 border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 whitespace-nowrap transition-colors">Pronósticos</button>
            </div>

            <div id="extra-loading" class="text-center text-xs text-gray-400 animate-pulse py-6">Cargando detalles del partido...</div>

            <div id="tab-content-cronologia" class="tab-content block">
                <ul id="datos-extra-partido" class="text-sm font-medium text-gray-600 dark:text-gray-400 space-y-2 mb-4 hidden">
                    <li class="flex justify-between border-b border-gray-200 dark:border-gray-700 pb-2"><span>Competición</span> <span class="font-bold text-gray-900 dark:text-white">${ligaActual}</span></li>
                    <li class="flex justify-between border-b border-gray-200 dark:border-gray-700 pb-2"><span>Fase</span> <span class="font-bold text-gray-900 dark:text-white">${partido.nombre_fase || 'Fase de Grupos'}</span></li>
                    ${partido.estado === 'pre' ? `
                    <li class="flex justify-between pb-1 border-b border-gray-200 dark:border-gray-700">
                        <span>Tiempo Restante</span> 
                        <span class="font-bold ${diferenciaMinutos < 60 && diferenciaMinutos > 0 ? 'text-orange-500' : 'text-gray-900 dark:text-white'}">
                            ${diferenciaMinutos > 0 ? calcularTiempoAmigable(fechaPartido) : '---'}
                        </span>
                    </li>` : ''}
                </ul>
                <div id="eventos-partido-container"></div>
            </div>

            <div id="tab-content-alineaciones" class="tab-content hidden">
                <div id="alineaciones-container" class="py-2"></div>
            </div>

            <div id="tab-content-estadisticas" class="tab-content hidden">
                <div id="estadisticas-vivo-container"></div>
            </div>

            <div id="tab-content-pronosticos" class="tab-content hidden">
                <div id="pronosticos-chart-container" class="py-2 px-1">
                    <div class="text-center text-xs text-gray-400 animate-pulse py-6">Cargando pronósticos...</div>
                </div>
            </div>

        </div>
    `;

    document.getElementById('info-partido-dinamica').innerHTML = html;
    
    // ✅ OCULTAR ATAJOS SI ESTÁ BLOQUEADO (Novedad v25)
    const atajos = document.getElementById('atajos-pronosticos');
    if (atajos) {
        if (bloqueado) atajos.classList.add('hidden');
        else atajos.classList.remove('hidden');
    }

    cambiarPantalla('vista-partido');

    // ✅ REFORZAR POLLING (Novedad v28)
    // Si entramos a un partido vivo, forzamos que el interval de actualización esté corriendo
    if (partido.estado === 'in' && typeof cargarPartidos === 'function') {
        const tempInterval = setInterval(() => {
            if (window.location.hash !== '#vista-partido') {
                clearInterval(tempInterval);
                return;
            }
            cargarExtrasPartido(idPartido, 'in', true);
        }, 15000);
    }

    // ENVIAMOS LA VARIABLE BLOQUEADO A LOS EXTRAS
    cargarExtrasPartido(partido.id_partido, partido.estado, bloqueado);
}

async function cargarExtrasPartido(idPartido, estadoPartido, bloqueado) {
    const liga = localStorage.getItem('grupoActivoLiga');
    let torneoEspn = 'conmebol.libertadores';
    if (liga === 'champions') torneoEspn = 'uefa.champions';
    else if (liga === 'betplay') torneoEspn = 'col.1';

    try {
        const respuesta = await fetch(`/api/partidos/detalle/${idPartido}`);
        const datos = await respuesta.json();

        const loader = document.getElementById('extra-loading');
        if (loader) loader.remove();

        const listaDOM = document.getElementById('datos-extra-partido');
        if (listaDOM) listaDOM.classList.remove('hidden');

        const estadio = datos.gameInfo?.venue?.fullName || 'Estadio por definir';
        const ciudad = datos.gameInfo?.venue?.address?.city || '';
        const arbitro = datos.gameInfo?.officials?.[0]?.fullName || 'Árbitro por definir';

        if (estadoPartido === 'in') {
            const relojDetail = datos.header?.competitions?.[0]?.status?.type?.shortDetail;
            const badgeDOM = document.getElementById('clock-main-live');
            if (badgeDOM && relojDetail) {
                badgeDOM.innerHTML = `<span class="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span> EN VIVO ${relojDetail}`;
            }
        }

        // ==========================================
        // PESTAÑA 1: CRONOLOGÍA (Solo Línea de Tiempo)
        // ==========================================
        let htmlEventos = '';

        const eventos = datos.keyEvents || [];
        if (eventos.length > 0) {
            htmlEventos += `<div class="bg-white dark:bg-gray-700/30 px-3 py-1 sm:px-4 rounded-[1.5rem] border border-gray-100 dark:border-gray-600/50 shadow-sm w-full">`;
            eventos.forEach(ev => {
                const tipo = ev.type?.text || '';
                const min = ev.clock?.displayValue || '';
                const equipoInfo = ev.team?.shortDisplayName || ev.team?.displayName || '';

                let icon = '⏱️';
                let colorClass = 'text-gray-800 dark:text-gray-200 font-bold';
                let detalle = '';

                let jugador = ev.participants?.[0]?.athlete?.shortName || ev.participants?.[0]?.athlete?.displayName;

                if (!jugador) {
                    if (ev.shortText) jugador = ev.shortText.split(' - ').pop().trim();
                    else if (ev.text) jugador = ev.text.split(/[-(]/)[0].trim();
                    else jugador = 'Evento';
                }

                if (tipo === "Goal") {
                    icon = '⚽'; colorClass = 'font-black text-gray-900 dark:text-white';
                } else if (tipo === "Yellow Card") {
                    icon = '🟨'; colorClass = 'font-bold text-gray-700 dark:text-gray-200';
                } else if (tipo === "Red Card") {
                    icon = '🟥'; colorClass = 'font-black text-red-600 dark:text-red-400';
                } else if (tipo.includes("Penalty")) {
                    icon = '🎯'; colorClass = 'font-black text-gray-900 dark:text-white';
                } else if (tipo.includes("Substitution")) {
                    icon = '🔄';
                    let textoOriginal = ev.text || '';
                    let entra = "Jugador", sale = "Jugador";

                    if (textoOriginal.includes(" replaces ")) {
                        let partes = textoOriginal.split(" replaces ");
                        entra = partes[0].split(". ").pop();
                        sale = partes[1].replace(".", "").trim();
                    } else if (textoOriginal.includes(" entra por ")) {
                        let partes = textoOriginal.split(" entra por ");
                        entra = partes[0].split(". ").pop();
                        sale = partes[1].replace(".", "").trim();
                    } else if (ev.participants && ev.participants.length > 1) {
                        entra = ev.participants[0]?.athlete?.shortName || "Jugador";
                        sale = ev.participants[1]?.athlete?.shortName || "Jugador";
                    } else {
                        entra = jugador; sale = "";
                    }

                    if (sale) {
                        detalle = `<span class="text-green-600 dark:text-green-400 font-bold truncate w-1/2">🔼 ${entra}</span> <span class="text-red-500 dark:text-red-400 text-[11px] truncate w-1/2 ml-1">🔽 ${sale}</span>`;
                        jugador = '';
                    } else {
                        detalle = `<span class="text-gray-600 dark:text-gray-400 truncate">Cambio: ${entra}</span>`;
                        jugador = '';
                    }
                }

                let textoPrincipal = jugador ? `<span class="${colorClass} truncate w-full">${jugador}</span>` : `<div class="flex items-center w-full">${detalle}</div>`;

                htmlEventos += `
                <div class="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-600/50 last:border-0">
                    <div class="flex items-center gap-2.5 w-3/4 overflow-hidden">
                        <span class="font-black text-gray-800 dark:text-gray-200 w-6 text-right shrink-0 text-xs">${min}'</span>
                        <span class="text-sm shrink-0 drop-shadow-sm">${icon}</span>
                        <div class="text-xs truncate w-full flex items-center">${textoPrincipal}</div>
                    </div>
                    <span class="text-[9px] font-bold text-gray-400 uppercase tracking-wider truncate w-1/4 text-right shrink-0 pl-2">${equipoInfo}</span>
                </div>`;
            });
            htmlEventos += `</div>`;
        } else if (estadoPartido !== 'pre') {
            htmlEventos += `<p class="text-sm text-gray-400 text-center italic py-4">No hay eventos destacados aún.</p>`;
        }


        // ==========================================
        // PESTAÑA 2: ALINEACIONES (Lineups / Rosters)
        // ==========================================
        let htmlAlineaciones = '';
        if (datos.rosters && datos.rosters.length === 2) {
            const teamLocal = datos.rosters[0];
            const teamVisita = datos.rosters[1];

            htmlAlineaciones += `<div class="flex flex-col sm:flex-row gap-4 w-full">`;

            const renderRoster = (team) => {
                let rHtml = `<div class="flex-1 bg-white dark:bg-gray-700/30 rounded-2xl p-4 border border-gray-100 dark:border-gray-600/50 shadow-sm">
                    <h5 class="text-xs font-black text-gray-800 dark:text-white uppercase tracking-wider mb-4 pb-2 border-b border-gray-100 dark:border-gray-600 text-center">${team.team?.displayName || 'Equipo'}</h5>
                    <div class="space-y-2">`;

                const jugadores = team.roster || [];
                jugadores.forEach(jug => {
                    if (!jug.starter) return;

                    const num = jug.athlete?.jersey || '-';
                    const nom = jug.athlete?.shortName || jug.athlete?.displayName || 'Jugador';
                    const pos = jug.position?.abbreviation || '';

                    rHtml += `
                    <div class="flex items-center justify-between text-xs">
                        <div class="flex items-center gap-2 truncate">
                            <span class="font-black text-gray-400 w-4 text-right">${num}</span>
                            <span class="font-bold text-gray-700 dark:text-gray-300 truncate">${nom}</span>
                        </div>
                        <span class="text-[9px] font-bold text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">${pos}</span>
                    </div>`;
                });
                rHtml += `</div></div>`;
                return rHtml;
            };

            htmlAlineaciones += renderRoster(teamLocal);
            htmlAlineaciones += renderRoster(teamVisita);
            htmlAlineaciones += `</div>`;
        } else {
            htmlAlineaciones = `<div class="text-center py-8"><span class="text-4xl block mb-2">📋</span><p class="text-sm text-gray-400 font-bold">Alineaciones no disponibles</p></div>`;
        }


        // ==========================================
        // PESTAÑA 3: ESTADÍSTICAS (Pronóstico o Vivo)
        // ==========================================
        let htmlEstadisticas = '';
        const boxscore = datos.boxscore;

        if (estadoPartido === 'pre') {
            if (bloqueado) {
                // Si ya pasaron los 10 minutos límite
                htmlEstadisticas = `<div class="text-center py-8"><span class="text-4xl block mb-2">⏳</span><p class="text-sm text-gray-400 font-bold">El pronóstico está cerrado. Las estadísticas en vivo comenzarán pronto.</p></div>`;
            } else if (datos.predictor && datos.predictor.homeTeam) {
                // Si no está bloqueado y la API SÍ manda probabilidades
                const probLocal = parseFloat(datos.predictor.homeTeam.gameProjection) || 0;
                const probVisita = parseFloat(datos.predictor.awayTeam?.gameProjection) || 0;
                const probEmpate = parseFloat(datos.predictor.tie?.gameProjection) || 0;
                const nomLocal = datos.predictor.homeTeam.team?.displayName || 'Local';
                const nomVisita = datos.predictor.awayTeam?.team?.displayName || 'Visita';

                htmlEstadisticas = `
                <div class="bg-[#1A1A1A] rounded-xl p-5 shadow-sm w-full font-sans">
                    <h4 class="text-center text-[11px] font-bold text-white uppercase tracking-wider mb-6">PROBABILIDAD DE VICTORIA (90 MIN)</h4>
                    
                    <div class="flex justify-between items-end mb-2 text-[13px] font-bold">
                        <div class="text-left">
                            <span class="block text-white mb-0.5">${nomLocal}</span>
                            <span class="text-[#4CD9C0] text-sm">${probLocal.toFixed(0)}%</span>
                        </div>
                        <div class="text-center">
                            <span class="block text-white mb-0.5">Empate</span>
                            <span class="text-gray-400 text-sm">${probEmpate.toFixed(0)}%</span>
                        </div>
                        <div class="text-right">
                            <span class="block text-white mb-0.5">${nomVisita}</span>
                            <span class="text-[#FFC154] text-sm">${probVisita.toFixed(0)}%</span>
                        </div>
                    </div>

                    <div class="flex w-full h-2.5 overflow-hidden bg-gray-800 gap-0.5 rounded-full">
                        <div class="bg-[#4CD9C0]" style="width: ${probLocal}%"></div>
                        <div class="bg-[#D9D9D9]" style="width: ${probEmpate}%"></div>
                        <div class="bg-[#FFC154]" style="width: ${probVisita}%"></div>
                    </div>
                </div>`;
            } else {
                // Si no está bloqueado, pero la API de ESPN no mandó la info
                htmlEstadisticas = `
                <div class="text-center py-8 bg-gray-50 dark:bg-gray-800/50 rounded-2xl border border-gray-100 dark:border-gray-700">
                    <span class="text-4xl block mb-3 opacity-50">📉</span>
                    <p class="text-sm text-gray-500 dark:text-gray-400 font-bold px-4">
                        Las probabilidades para este partido aún no han sido generadas por nuestro proveedor deportivo.
                    </p>
                    <p class="text-xs text-gray-400 mt-2 italic">Intenta revisar más cerca de la hora del encuentro.</p>
                </div>`;
            }
        } else if (boxscore && boxscore.teams && boxscore.teams.length === 2) {
            const tLocal = boxscore.teams[0];
            const tVisita = boxscore.teams[1];
            const getStat = (team, name) => team.statistics?.find(s => s.name === name)?.displayValue || '0';

            const metricas = [
                { name: 'possessionPct', label: 'Posesión (%)' },
                { name: 'shotsSummary', label: 'Tiros (Al arco)' },
                { name: 'foulsCommitted', label: 'Faltas' },
                { name: 'wonCorners', label: 'Tiros de Esquina' },
                { name: 'yellowCards', label: 'Tarjetas Amarillas' },
                { name: 'redCards', label: 'Tarjetas Rojas' },
                { name: 'offsides', label: 'Fueras de Juego' }
            ];

            htmlEstadisticas = `<div class="bg-white dark:bg-gray-700/30 p-4 sm:p-5 rounded-[1.5rem] border border-gray-100 dark:border-gray-600/50 shadow-sm w-full space-y-5">`;
            let hasStats = false;

            metricas.forEach(m => {
                const valL = getStat(tLocal, m.name);
                const valV = getStat(tVisita, m.name);

                if (valL !== '0' || valV !== '0') {
                    hasStats = true;
                    let numL = parseFloat(valL.toString().split(' ')[0]) || 0;
                    let numV = parseFloat(valV.toString().split(' ')[0]) || 0;
                    let total = numL + numV;
                    let pctL = total > 0 ? (numL / total) * 100 : 0;
                    let pctV = total > 0 ? (numV / total) * 100 : 0;

                    const colorLocal = 'bg-primary dark:bg-primary-500';
                    const colorVisita = 'bg-gray-400 dark:bg-gray-500';

                    htmlEstadisticas += `
                    <div class="w-full">
                        <div class="flex justify-between items-center mb-1.5 px-1">
                            <span class="w-1/3 text-left font-black text-sm text-gray-800 dark:text-white">${valL}</span>
                            <span class="w-1/3 text-center text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest leading-tight">${m.label}</span>
                            <span class="w-1/3 text-right font-black text-sm text-gray-800 dark:text-white">${valV}</span>
                        </div>
                        <div class="flex w-full gap-1 h-2">
                            <div class="flex-1 flex justify-end bg-gray-100 dark:bg-gray-800 rounded-l-full overflow-hidden">
                                <div class="${colorLocal} h-full rounded-l-full transition-all duration-700 ease-out" style="width: ${pctL}%"></div>
                            </div>
                            <div class="flex-1 flex justify-start bg-gray-100 dark:bg-gray-800 rounded-r-full overflow-hidden">
                                <div class="${colorVisita} h-full rounded-r-full transition-all duration-700 ease-out" style="width: ${pctV}%"></div>
                            </div>
                        </div>
                    </div>`;
                }
            });
            htmlEstadisticas += `</div>`;
            if (!hasStats) htmlEstadisticas = `<p class="text-sm text-gray-400 text-center italic py-4">Aún no hay estadísticas recolectadas.</p>`;
        } else {
            htmlEstadisticas = `<p class="text-sm text-gray-400 text-center italic py-4">Aún no hay estadísticas recolectadas.</p>`;
        }

        if (listaDOM && listaDOM.children.length < 3) {
            listaDOM.insertAdjacentHTML('beforeend', `
                <li class="flex justify-between pb-1 border-b border-gray-200 dark:border-gray-700">
                    <span class="text-gray-500">🏟️ Estadio</span> 
                    <span class="font-bold text-gray-900 dark:text-white text-right">${estadio} ${ciudad ? '(' + ciudad + ')' : ''}</span>
                </li>
            `);
        }

        const contEventos = document.getElementById('eventos-partido-container');
        const contAlineaciones = document.getElementById('alineaciones-container');
        const contStats = document.getElementById('estadisticas-vivo-container');
        const contPronosticos = document.getElementById('pronosticos-chart-container');

        if (contEventos) contEventos.innerHTML = htmlEventos;
        if (contAlineaciones) contAlineaciones.innerHTML = htmlAlineaciones;
        if (contStats) contStats.innerHTML = htmlEstadisticas;

        if (contPronosticos) {
            try {
                const gid = localStorage.getItem('grupoActivoId');
                const resP = await fetchConAuth(`/api/pronosticos/distribucion/${gid}/${idPartido}`);
                if (resP.ok) {
                    const dataP = await resP.json();
                    if (dataP.estado === 'exito' && dataP.distribucion.length > 0) {
                        let hP = `<div class="bg-white dark:bg-gray-700/30 p-4 sm:p-5 rounded-[1.5rem] border border-gray-100 dark:border-gray-600/50 shadow-sm w-full">
                            <h4 class="text-xs font-black text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-6 text-center">Tendencia del Grupo</h4>
                            <div class="flex items-end justify-center gap-3 sm:gap-6 h-40 pt-2 border-b-2 border-dashed border-gray-200 dark:border-gray-600 pb-0">`;

                        dataP.distribucion.forEach(item => {
                            hP += `
                                <div class="flex flex-col items-center flex-1 max-w-[3rem] h-full justify-end group">
                                    <div class="w-full bg-primary-100 dark:bg-blue-900/40 rounded-t-xl relative flex items-end justify-center transition-all duration-1000 ease-out" style="height: ${item.porcentaje}%">
                                        <div class="w-full bg-gradient-to-t from-primary to-primary-700 group-hover:from-primary-500 group-hover:to-primary-200 rounded-t-xl shadow-inner transition-colors" style="height: 100%"></div>
                                    </div>
                                    <span class="text-[11px] font-black text-gray-700 dark:text-gray-200 mt-2 mb-1">${item.marcador}</span>
                                </div>
                            `;
                        });
                        hP += `</div><p class="text-[9px] text-gray-400 text-center mt-4 uppercase tracking-widest font-bold">* Altura relativa al marcador más votado</p></div>`;
                        contPronosticos.innerHTML = hP;
                    } else {
                        contPronosticos.innerHTML = `<p class="text-sm text-gray-400 text-center italic py-8 border border-dashed border-gray-200 dark:border-gray-700 rounded-2xl">Aún no hay pronósticos registrados para este partido en tu grupo.</p>`;
                    }
                } else {
                    contPronosticos.innerHTML = `<p class="text-xs text-red-400 text-center italic py-4">No se pudo cargar la estadística.</p>`;
                }
            } catch (ep) {
                console.error("Error pronósticos distribución:", ep);
                contPronosticos.innerHTML = `<p class="text-xs text-red-400 text-center italic py-4">Error cargando el gráfico.</p>`;
            }
        }

    } catch (e) {
        console.error("Error cargando extras de ESPN:", e);
        const loader = document.getElementById('extra-loading');
        if (loader) loader.innerHTML = "No se pudieron cargar detalles adicionales.";
    }
}

async function guardarUnPronostico(idPartido, btn) {
    const valL = document.getElementById(`input-det-l-${idPartido}`).value;
    const valV = document.getElementById(`input-det-v-${idPartido}`).value;

    if (valL === "" || valV === "") return mostrarToast("⚠️ Debes ingresar los goles de ambos equipos");
    if (parseInt(valL) < 0 || parseInt(valV) < 0) return mostrarToast("⚠️ Los goles no pueden ser negativos");

    const gid = localStorage.getItem('grupoActivoId');
    const correo = localStorage.getItem('usuarioCorreo');

    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<svg class="animate-spin h-5 w-5 mx-auto text-white" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;
    btn.disabled = true;

    try {
        const res = await fetchConAuth('/api/pronosticos/guardar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grupo_id: parseInt(gid),
                correo_usuario: correo,
                pronosticos: [{ id_partido: idPartido, goles_local: parseInt(valL), goles_visitante: parseInt(valV) }]
            })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Error del servidor al guardar el pronóstico');
        }

        // ✅ Actualizar la tarjeta resumen en vista-grupo (sin recargar partidos)
        const divResumen = document.getElementById(`pred-resumen-${idPartido}`);
        if (divResumen) {
            divResumen.classList.replace('text-gray-400', 'text-primary');
            divResumen.classList.replace('dark:text-gray-400', 'dark:text-primary-700');
            divResumen.classList.replace('bg-gray-50', 'bg-primary-50');
            divResumen.classList.replace('dark:bg-gray-700/50', 'dark:bg-primary-900/20');
            divResumen.innerHTML = `Tu pronóstico: <span class="font-black text-sm ml-1">${valL} - ${valV}</span>`;
            divResumen.dataset.hasPrediction = 'true';
        }

        // ✅ Actualizar caché de pronósticos
        if (misPronosticosCache) {
            const idx = misPronosticosCache.findIndex(x => x.id_partido === idPartido);
            const entrada = { id_partido: idPartido, goles_local: parseInt(valL), goles_visitante: parseInt(valV) };
            if (idx >= 0) misPronosticosCache[idx] = entrada;
            else misPronosticosCache.push(entrada);
        }

        // ✅ Animación de éxito en el botón
        btn.innerHTML = `<span>✅</span><span class="hidden sm:inline ml-1">GUARDADO</span>`;
        btn.classList.replace('bg-primary', 'bg-green-600');
        btn.classList.replace('hover:bg-blue-700', 'hover:bg-green-700');

        mostrarToast("✅ ¡Pronóstico guardado!");

        // ✅ Volver a vista-grupo SIN recargar todos los partidos
        setTimeout(() => {
            cambiarPantalla('vista-grupo');
            actualizarBarraProgreso();
        }, 700);

    } catch (e) {
        mostrarToast("❌ " + e.message);
        btn.innerHTML = originalHTML;
        btn.disabled = false;
    }
}

async function verTablaPosiciones() {
    const elPrev = document.getElementById('m-pos');
    if (elPrev) elPrev.remove();

    const gid = localStorage.getItem('grupoActivoId');
    try {
        const respuesta = await fetchConAuth(`/api/posiciones/${gid}`);
        if (!respuesta.ok) { mostrarToast('⚠️ No se pudo cargar el ranking del grupo.'); return; }
        const datos = await respuesta.json();

        let h = `
    <div id="m-pos" class="fixed inset-0 bg-black/80 z-50 flex justify-center items-center p-2 backdrop-blur-md animar-entrada">
        <div class="bg-white dark:bg-gray-900 rounded-[2.5rem] w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
            <div class="bg-yellow-500 p-6 flex justify-between items-center text-white shrink-0">
                <div>
                    <h3 class="font-black text-xl italic">RANKING DE LA POLLA</h3>
                    <p class="text-[10px] opacity-80">Sistema de puntuación por pronósticos</p>
                </div>
                <button onclick="document.getElementById('m-pos').remove()" class="text-2xl font-bold hover:text-yellow-200 transition">&times;</button>
            </div>
            <!-- Leyenda de puntuación -->
            <div class="bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 px-4 py-3">
                <p class="text-[11px] font-black text-yellow-700 dark:text-yellow-400 uppercase tracking-wide mb-2">🎯 Cómo se puntean los pronósticos</p>
                <div class="grid grid-cols-1 gap-y-2 text-[11px]">
                    <div class="flex items-start gap-2">
                        <span class="shrink-0 w-8 text-center font-black text-yellow-600 bg-yellow-100 dark:bg-yellow-900/40 rounded-md py-0.5">+10</span>
                        <span class="text-gray-600 dark:text-gray-300"><b class="text-yellow-600">MU — Marcador Único:</b> Aciertas el marcador exacto y eres el <em>único</em> en el grupo en hacerlo.</span>
                    </div>
                    <div class="flex items-start gap-2">
                        <span class="shrink-0 w-8 text-center font-black text-primary bg-primary-100 dark:bg-blue-900/40 rounded-md py-0.5">+5</span>
                        <span class="text-gray-600 dark:text-gray-300"><b class="text-primary">ME — Marcador Exacto:</b> Aciertas el marcador exacto, pero más de una persona en el grupo también lo acertó.</span>
                    </div>
                    <div class="flex items-start gap-2">
                        <span class="shrink-0 w-8 text-center font-black text-green-600 bg-green-100 dark:bg-green-900/40 rounded-md py-0.5">+3</span>
                        <span class="text-gray-600 dark:text-gray-300"><b class="text-green-600">GA — Ganador Acertado:</b> No aciertas el marcador exacto, pero sí el equipo ganador o el empate.</span>
                    </div>
                    <div class="flex items-start gap-2">
                        <span class="shrink-0 w-8 text-center font-black text-purple-600 bg-purple-100 dark:bg-purple-900/40 rounded-md py-0.5">+1</span>
                        <span class="text-gray-600 dark:text-gray-300"><b class="text-purple-600">GG — Goles a medias:</b> No aciertas al ganador, pero sí los goles exactos de uno de los dos equipos.</span>
                    </div>
                    <div class="flex items-start gap-2">
                        <span class="shrink-0 w-8 text-center font-black text-red-500 bg-red-100 dark:bg-red-900/40 rounded-md py-0.5">0</span>
                        <span class="text-gray-600 dark:text-gray-300"><b class="text-red-500">PA — Partido sin Acierto:</b> No acertaste en nada, o no agregaste pronóstico al partido.</span>
                    </div>
                </div>
            </div>
            <div class="overflow-y-auto">
                <table class="w-full text-center text-xs">
                    <thead class="bg-gray-50 dark:bg-gray-800 text-gray-500 font-bold border-b border-gray-100 dark:border-gray-700 sticky top-0">
                        <tr>
                            <th class="p-3 text-left rounded-tl-xl">#</th>
                            <th class="p-3 text-left">JUGADOR</th>
                            <th class="p-3 text-yellow-600" title="Puntos totales">PTS</th>
                            <th class="p-3 text-yellow-500" title="Marcador Único: marcador exacto, único en el grupo (+10 pts)">MU</th>
                            <th class="p-3 text-primary-500" title="Marcador Exacto: marcador exacto compartido con otros (+5 pts)">ME</th>
                            <th class="p-3 text-green-500" title="Ganador Acertado o Empate correcto (+3 pts)">GA</th>
                            <th class="p-3 text-purple-500" title="Goles a medias: no aciertas ganador pero sí goles de un equipo (+1 pt)">GG</th>
                            <th class="p-3 text-red-500 rounded-tr-xl" title="Partido sin Acierto: no acertó nada o no agregó pronóstico (0 pts)">PA</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100 dark:divide-gray-800">`;

        datos.posiciones.forEach((jugador, i) => {
            const corona = i === 0 ? '👑' : i + 1;
            const miCorreo = localStorage.getItem('usuarioCorreo');
            const esMismo = jugador.correo === miCorreo;

            h += `<tr class="${esMismo ? 'bg-primary-50/50 dark:bg-primary-100/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'} transition">
            <td class="p-3 font-bold text-gray-400 text-sm">${corona}</td>
            <td class="p-3 text-left">
                <div class="flex items-center gap-2">
                    <span class="text-base leading-none">${jugador.avatar || '👤'}</span>
                    <div class="flex flex-col">
                        <span class="font-black text-gray-700 dark:text-gray-200 capitalize leading-none">${escHtml(jugador.nombre)}</span>
                    </div>
                </div>
            </td>
            <td class="p-3 font-black text-sm text-yellow-600 bg-yellow-50/50 dark:bg-yellow-900/10">${jugador.puntos}</td>
            <td class="p-3 font-bold text-yellow-500">${jugador.mu}</td>
            <td class="p-3 font-bold text-primary-500">${jugador.me}</td>
            <td class="p-3 font-bold text-green-500">${jugador.ga}</td>
            <td class="p-3 font-bold text-purple-500">${jugador.gg}</td>
            <td class="p-3 font-bold text-red-400">${jugador.pe}</td>
        </tr>`;
        });

        h += `</tbody></table></div></div></div>`;
        document.body.insertAdjacentHTML('beforeend', h);
    } catch (e) {
        console.error(e);
        mostrarToast('❌ Error de conexión al cargar el ranking.');
    }
}

// (función mostrarSkeletonGrupos definida anteriormente en el archivo)

function mostrarSkeletonPartidos(contenedorId) {
    const contenedor = document.getElementById(contenedorId);
    if (!contenedor) return;

    let skeletons = '';
    // Generamos 3 tarjetas de partidos falsas
    for (let i = 0; i < 3; i++) {
        skeletons += `
            <div class="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border border-gray-100 dark:border-gray-700 animate-pulse mb-4">
                <div class="flex justify-center mb-4">
                    <div class="h-4 bg-gray-200 dark:bg-gray-700 rounded-md w-1/4"></div>
                </div>
                <div class="flex justify-between items-center">
                    <div class="flex flex-col items-center gap-2 w-1/3">
                        <div class="w-12 h-12 bg-gray-200 dark:bg-gray-700 rounded-full"></div>
                        <div class="h-4 bg-gray-200 dark:bg-gray-700 rounded-md w-16"></div>
                    </div>
                    <div class="h-10 bg-gray-200 dark:bg-gray-700 rounded-md w-1/4 mx-2"></div>
                    <div class="flex flex-col items-center gap-2 w-1/3">
                        <div class="w-12 h-12 bg-gray-200 dark:bg-gray-700 rounded-full"></div>
                        <div class="h-4 bg-gray-200 dark:bg-gray-700 rounded-md w-16"></div>
                    </div>
                </div>
                <div class="mt-4 h-12 bg-gray-200 dark:bg-gray-700 rounded-xl w-full"></div>
            </div>
        `;
    }
    contenedor.innerHTML = skeletons;
}

window.cambiarTabFiltros = function (tabName) {
    localStorage.setItem('tabFiltroActual', tabName);
    document.querySelectorAll('.tab-filtro-btn').forEach(btn => {
        btn.classList.remove('border-primary', 'text-primary', 'dark:text-primary-700', 'font-black');
        btn.classList.add('border-transparent', 'text-gray-500', 'dark:text-gray-400', 'font-bold');
    });

    document.querySelectorAll('.tab-filtro-content').forEach(content => {
        content.classList.add('hidden');
    });

    const btnActivo = document.getElementById(`tab-filtro-${tabName}`);
    const contenidoActivo = document.getElementById(`tab-content-filtro-${tabName}`);

    if (btnActivo && contenidoActivo) {
        btnActivo.classList.remove('border-transparent', 'text-gray-500', 'dark:text-gray-400', 'font-bold');
        btnActivo.classList.add('border-primary', 'text-primary', 'dark:text-primary-700', 'font-black');
        contenidoActivo.classList.remove('hidden');
    }
};

function actualizarTemporizadores() {
    document.querySelectorAll('.temporizador-partido').forEach(el => {
        const fechaPartido = new Date(el.getAttribute('data-fecha'));
        const ahora = new Date();
        const diffMs = fechaPartido - ahora;

        if (diffMs <= 0) {
            // El partido ya ha comenzado (o la hora pasó), se bloquean visualmente
            el.innerText = 'Cerrado 🔒';
            el.classList.replace('text-orange-600', 'text-red-600');
            el.classList.replace('dark:text-orange-400', 'dark:text-red-400');
            el.classList.replace('bg-orange-100', 'bg-red-100');
            el.classList.replace('dark:bg-orange-900/30', 'dark:bg-red-900/30');
            el.classList.remove('temporizador-partido'); // Quitar clase para no seguir procesando
        } else {
            // Calcular días, horas, minutos y segundos restantes
            const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const diffHoras = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
            const diffMinutos = Math.floor((diffMs / (1000 * 60)) % 60);
            const diffSegundos = Math.floor((diffMs / 1000) % 60);

            if (diffDias > 0) {
                // Si falta más de un día, mostrar formato condensado
                el.innerText = `Cierra en: ${diffDias}d ${diffHoras}h ${diffMinutos}m`;
            } else {
                // Si falta menos de un día, mostrar el cronómetro exacto con ceros a la izquierda
                el.innerText = `Cierra en: ${diffHoras.toString().padStart(2, '0')}h ${diffMinutos.toString().padStart(2, '0')}m ${diffSegundos.toString().padStart(2, '0')}s`;
            }
        }
    });
}

// Auto-clearing interval: se detiene solo cuando no quedan partidos con temporizador activo
let _intervaloTemp = setInterval(() => {
    const quedan = document.querySelectorAll('.temporizador-partido');
    if (quedan.length === 0) {
        clearInterval(_intervaloTemp);
        return;
    }
    actualizarTemporizadores();
}, 1000);

// ✅ Inicialización v2.0
sincronizarTiempo();