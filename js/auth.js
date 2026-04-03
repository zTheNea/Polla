// ==========================================
// auth.js - Manejo de Login y Registro Seguro
// ==========================================

let modoRegistro = false;

function cambiarModoAuth(modo) {
    const contenedorNombre = document.getElementById('contenedor-nombre');
    const nombreInput = document.getElementById('nombre-input');
    const btnSubmit = document.getElementById('btn-submit');
    const textoAlterno = document.getElementById('texto-alterno');
    const ayudaPassword = document.getElementById('ayuda-password');
    const passwordInput = document.getElementById('password-input');
    const contenedorTerminos = document.getElementById('contenedor-terminos');
    const checkDatos = document.getElementById('check-datos');
    const titulo = document.querySelector('#panel-login h2');
    const subtitulo = document.getElementById('subtitulo-login');

    if (modo === 'registro') {
        modoRegistro = true;
        passwordInput.value = '';
        contenedorNombre.classList.remove('max-h-0', 'opacity-0');
        contenedorNombre.classList.add('max-h-24', 'opacity-100');
        nombreInput.required = true;

        btnSubmit.innerText = 'Regístrate';
        titulo.innerText = 'Crea tu cuenta ⚽';
        subtitulo.innerText = 'Únete y empieza a pronosticar.';

        ayudaPassword.classList.remove('hidden');
        ayudaPassword.classList.add('grid');
        contenedorTerminos.classList.remove('hidden');
        checkDatos.required = true;

        textoAlterno.innerHTML = '¿Ya tienes cuenta? <button type="button" onclick="cambiarModoAuth(\'login\')" class="text-blue-600 dark:text-blue-400 font-bold hover:underline">Inicia Sesión</button>';
    } else {
        modoRegistro = false;
        passwordInput.value = '';
        nombreInput.value = '';
        contenedorNombre.classList.add('max-h-0', 'opacity-0');
        contenedorNombre.classList.remove('max-h-24', 'opacity-100');
        nombreInput.required = false;

        btnSubmit.innerText = 'Iniciar Sesión';
        titulo.innerText = '¡Bienvenido! ⚽';
        subtitulo.innerText = 'Ingresa para pronosticar y ganar.';

        ayudaPassword.classList.add('hidden');
        ayudaPassword.classList.remove('grid');
        contenedorTerminos.classList.add('hidden');
        checkDatos.required = false;

        textoAlterno.innerHTML = '¿No tienes cuenta? <button type="button" onclick="cambiarModoAuth(\'registro\')" class="text-blue-600 dark:text-blue-400 font-bold hover:underline">Regístrate</button>';
    }
}

function validarPasswordDinamicamente() {
    if (!modoRegistro) return;

    const pw = document.getElementById('password-input').value;

    const hasNum = /\d/.test(pw);
    const hasMay = /[A-Z]/.test(pw);
    const hasMin = /[a-z]/.test(pw);
    const hasLen = pw.length >= 8;

    actualizarCriterio('req-num', hasNum);
    actualizarCriterio('req-may', hasMay);
    actualizarCriterio('req-min', hasMin);
    actualizarCriterio('req-len', hasLen);
}

function actualizarCriterio(id, cumple) {
    const el = document.getElementById(id);
    const icono = el.querySelector('span');
    if (cumple) {
        el.classList.add('text-green-500');
        el.classList.remove('text-gray-400');
        icono.classList.add('bg-green-500', 'text-white');
        icono.classList.remove('bg-gray-200', 'dark:bg-gray-600', 'text-transparent');
    } else {
        el.classList.remove('text-green-500');
        el.classList.add('text-gray-400');
        icono.classList.remove('bg-green-500', 'text-white');
        icono.classList.add('bg-gray-200', 'dark:bg-gray-600', 'text-transparent');
    }
}

function togglePasswordVisibility() {
    const input = document.getElementById('password-input');
    const icon = document.getElementById('icono-ojo');

    if (input.type === 'password') {
        input.type = 'text';
        icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path>`;
    } else {
        input.type = 'password';
        icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>`;
    }
}

async function procesarAuth(e) {
    e.preventDefault();

    // .trim() elimina espacios en blanco agregados por error por el teclado del celular
    const correo = document.getElementById('correo-input').value.trim();
    const password = document.getElementById('password-input').value;
    const nombre = document.getElementById('nombre-input').value.trim();

    // Validación estricta solo para registro
    if (modoRegistro) {
        if (!document.getElementById('check-datos').checked) {
            return mostrarToast("⚠️ Debes aceptar los Términos y Políticas.");
        }
        if (nombre.length < 3 || nombre.length > 30) {
            return mostrarToast("⚠️ El nombre debe tener entre 3 y 30 caracteres.");
        }

        const hasNum = /\d/.test(password);
        const hasMay = /[A-Z]/.test(password);
        const hasMin = /[a-z]/.test(password);
        const hasLen = password.length >= 8;

        if (!(hasNum && hasMay && hasMin && hasLen)) {
            return mostrarToast("⚠️ La contraseña no cumple todos los requisitos de seguridad.");
        }
    }

    const btnSubmit = document.getElementById('btn-submit');
    const txtOriginal = btnSubmit.innerHTML;
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-5 w-5 text-white inline-block" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Procesando...`;

    try {
        const url = modoRegistro ? '/api/auth/registro' : '/api/auth/login';
        const payload = modoRegistro ? { nombre, correo, password } : { correo, password };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const datos = await response.json();

        if (response.ok) {
            if (modoRegistro) {
                mostrarToast("✅ ¡Registro exitoso! Ya puedes iniciar sesión.");
                cambiarModoAuth('login');
                // Limpiamos los inputs
                document.getElementById('password-input').value = '';
                document.getElementById('nombre-input').value = '';
            } else {
                localStorage.setItem('usuarioNombre', datos.nombre);
                localStorage.setItem('usuarioCorreo', datos.correo);
                localStorage.setItem('usuarioAvatar', datos.avatar || '👤');
                localStorage.setItem('authToken', datos.token);

                document.getElementById('nombre-dashboard').innerText = datos.nombre;
                const avatarDashboard = document.getElementById('avatar-dashboard');
                if (avatarDashboard) avatarDashboard.innerText = datos.avatar || '👤';

                document.getElementById('password-input').value = '';
                cambiarPantalla('vista-dashboard');
            }
        } else {
            mostrarToast("⚠️ Error: " + traducirErrorAuth(datos.detail));
        }
    } catch (error) {
        mostrarToast("❌ No se pudo conectar con el servidor.");
    } finally {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = txtOriginal;
    }
}

// Poblar la UI con datos del usuario guardado; la navegación la maneja ui.js
document.addEventListener('DOMContentLoaded', () => {
    const usuarioNombre = localStorage.getItem('usuarioNombre');
    const usuarioCorreo = localStorage.getItem('usuarioCorreo');

    if (usuarioNombre && usuarioCorreo) {
        document.getElementById('nombre-dashboard').innerText = usuarioNombre;
        const avatarGuardado = localStorage.getItem('usuarioAvatar') || '👤';
        const avatarDashboard = document.getElementById('avatar-dashboard');
        if (avatarDashboard) avatarDashboard.innerText = avatarGuardado;

        // Sincronizar con el servidor en segundo plano (corrige desfase entre dispositivos)
        if (typeof sincronizarPerfil === 'function') sincronizarPerfil();
    }
});

// Mapeo de errores de servidor al español
function traducirErrorAuth(detail) {
    if (Array.isArray(detail)) {
        // Pydantic validation errors
        const devMsg = detail[0]?.msg || '';
        if (devMsg.includes('at least')) return 'La información ingresada es demasiado corta.';
        if (devMsg.includes('at most')) return 'La información ingresada es demasiado larga.';
        if (devMsg.includes('valid email')) return 'El formato del correo electrónico es inválido.';
        return 'Revisa los campos e intenta de nuevo.';
    }

    const mapa = {
        'El correo ya está registrado': 'Este correo ya pertenece a otra cuenta. Intenta iniciar sesión.',
        'Credenciales incorrectas': 'Correo o contraseña incorrectos. Verifica e intenta nuevamente.',
        'User not found': 'No encontramos una cuenta con ese correo.',
        'La contraseña actual es incorrecta': 'La contraseña actual ingresada es incorrecta.',
        'No eres miembro de este grupo.': 'No tienes permiso para acceder a este grupo.',
        'Este grupo ya está lleno.': 'Lamentablemente este grupo ya alcanzó su límite de miembros.',
        'Has alcanzado el límite máximo de 5 grupos por usuario.': 'Solo puedes pertenecer a un máximo de 5 grupos.',
        'Partido ya iniciado.': 'El partido ya comenzó y el pronóstico está cerrado.',
        'No proporcionaste un token de sesión.': 'Sesión no encontrada. Por favor re-ingresa.',
        'Sesión inválida o expirada.': 'Tu sesión ha vencido. Por seguridad, ingresa de nuevo.'
    };
    return mapa[detail] || detail;
}

function cerrarSesion() {
    if (typeof window.limpiarCachePronosticos === 'function') window.limpiarCachePronosticos();
    
    localStorage.removeItem('usuarioNombre');
    localStorage.removeItem('usuarioCorreo');
    localStorage.removeItem('usuarioAvatar');
    localStorage.removeItem('usuarioAlertas');
    localStorage.removeItem('authToken');
    // Limpiar datos de grupo activo para evitar filtración entre sesiones
    localStorage.removeItem('grupoActivoId');
    localStorage.removeItem('grupoActivoLiga');
    localStorage.removeItem('grupoActivoCodigo');
    localStorage.removeItem('grupoActivoNombre');
    localStorage.removeItem('grupoActivoCreador');
    localStorage.removeItem('partidoActivoId');
    localStorage.removeItem('tabFiltroActual');

    const correoInput = document.getElementById('correo-input');
    const passwordInput = document.getElementById('password-input');
    if (correoInput) correoInput.value = '';
    if (passwordInput) passwordInput.value = '';

    if (passwordInput && passwordInput.type === 'text') {
        togglePasswordVisibility();
    }

    cambiarPantalla('vista-login');
}