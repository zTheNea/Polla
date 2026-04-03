let chartInstancia = null;

async function inicializarStats() {
    await cargarGraficaEvolucion();
}

async function cargarGraficaEvolucion() {
    const gid = localStorage.getItem('grupoActivoId');
    const ctx = document.getElementById('chart-evolucion');
    if (!ctx) return;

    try {
        const res = await fetch(`/api/posiciones/historial/${gid}`);
        const d = await res.json();
        const historial = d.historial;

        if (!historial || Object.keys(historial).length === 0) {
            ctx.parentElement.innerHTML = '<div class="flex flex-col items-center justify-center h-full text-gray-400 italic text-sm"><p>Sin datos históricos aún.</p><p class="text-[10px]">La gráfica aparecerá cuando los partidos se procesen.</p></div>';
            return;
        }

        // Preparar etiquetas (fechas únicas)
        const fechasSet = new Set();
        Object.values(historial).forEach(userHist => {
            userHist.forEach(h => fechasSet.add(h.fecha));
        });
        const labels = Array.from(fechasSet).sort();

        // Preparar datasets (uno por usuario)
        const datasets = Object.keys(historial).map((correo, index) => {
            const dataUser = labels.map(f => {
                const punto = historial[correo].find(h => h.fecha === f);
                return punto ? punto.puntos : null;
            });

            // Paleta de colores con buen contraste entre sí
            const COLORES_CHART = [
                [59, 130, 246], [239, 68, 68], [16, 185, 129], [245, 158, 11],
                [139, 92, 246], [236, 72, 153], [20, 184, 166], [249, 115, 22],
                [99, 102, 241], [34, 197, 94], [168, 85, 247], [234, 179, 8]
            ];
            const [r, g, b] = COLORES_CHART[index % COLORES_CHART.length];

            return {
                label: correo.split('@')[0],
                data: dataUser,
                borderColor: `rgb(${r}, ${g}, ${b})`,
                backgroundColor: `rgba(${r}, ${g}, ${b}, 0.1)`,
                tension: 0.4,
                fill: false,
                borderWidth: 2,
                pointRadius: 4,
                spanGaps: true
            };
        });

        if (chartInstancia) chartInstancia.destroy();

        chartInstancia = new Chart(ctx, {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { boxWidth: 10, font: { size: 10 }, color: '#94a3b8' }
                    }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(148, 163, 184, 0.1)' }, ticks: { color: '#94a3b8' } },
                    x: { grid: { display: false }, ticks: { color: '#94a3b8' } }
                }
            }
        });
    } catch (e) { }
}

// =============================================
// ESTADÍSTICAS PERSONALES + LOGROS
// =============================================
async function cargarStatsPersonal() {
    const cont = document.getElementById('contenedor-stats-personal');
    if (!cont) return;

    try {
        const res = await fetch('/api/stats/personal');
        if (!res.ok) throw new Error('Error cargando stats');
        const d = await res.json();

        const correo = localStorage.getItem('usuarioCorreo') || '';
        const nombre = localStorage.getItem('usuarioNombre') || correo.split('@')[0];
        const avatar = localStorage.getItem('usuarioAvatar') || '👤';

        // Tarjetas de métricas
        const metricas = [
            { label: 'Puntos Totales', valor: d.puntos_totales, emoji: '⭐', color: 'from-amber-500 to-orange-600 dark:from-amber-700 dark:to-orange-900' },
            { label: 'Pronósticos', valor: d.pronosticos, emoji: '📝', color: 'from-blue-500 to-blue-700 dark:from-blue-700 dark:to-blue-900' },
            { label: 'Grupos', valor: d.grupos, emoji: '👥', color: 'from-emerald-500 to-emerald-700 dark:from-emerald-700 dark:to-emerald-900' },
            { label: 'Mensajes', valor: d.mensajes, emoji: '💬', color: 'from-purple-500 to-purple-700 dark:from-purple-700 dark:to-purple-900' },
        ];

        let htmlMetricas = metricas.map(m => `
            <div class="bg-gradient-to-br ${m.color} rounded-2xl p-4 shadow-lg text-white relative overflow-hidden">
                <div class="absolute -top-2 -right-2 text-4xl opacity-20">${m.emoji}</div>
                <p class="text-[10px] uppercase tracking-wider font-bold opacity-80">${m.label}</p>
                <p class="text-3xl font-black mt-1">${m.valor}</p>
            </div>
        `).join('');

        // Mejor grupo
        let htmlMejor = '';
        if (d.mejor_grupo) {
            htmlMejor = `
            <div class="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-700">
                <p class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">🏆 Mejor Rendimiento</p>
                <div class="flex items-center justify-between">
                    <span class="font-black text-gray-800 dark:text-white">${escHtml(d.mejor_grupo)}</span>
                    <span class="text-2xl font-black text-yellow-500">${d.mejor_puntos} pts</span>
                </div>
            </div>`;
        }

        // Logros
        let htmlLogros = '';
        if (d.logros && d.logros.length > 0) {
            htmlLogros = `
            <div class="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-700">
                <p class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">🏅 Logros Desbloqueados</p>
                <div class="grid grid-cols-2 gap-3">
                    ${d.logros.map(l => `
                        <div class="bg-primary-500/10 dark:bg-primary-500/20 rounded-xl p-3 border border-primary-200 dark:border-primary-500/30 text-center transform hover:scale-105 transition-transform">
                            <span class="text-2xl block mb-1">${l.emoji}</span>
                            <p class="text-xs font-black text-primary-700 dark:text-primary-300">${l.nombre}</p>
                            <p class="text-[9px] text-primary-600/70 dark:text-primary-400/70 mt-0.5">${l.descripcion}</p>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }

        // Botón ver todos los logros
        let htmlTodos = `
        <div class="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-700">
            <p class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">🎯 Todos los Logros</p>
            <div id="todos-logros-grid" class="space-y-2">
                <p class="text-xs text-gray-400 italic text-center py-2">Cargando...</p>
            </div>
        </div>`;

        // Botón compartir
        let htmlCompartir = `
        <button onclick="compartirStats()" class="w-full bg-gradient-to-r from-primary to-secondary text-white font-black py-4 rounded-2xl shadow-lg active:scale-95 transition text-sm flex items-center justify-center gap-2">
            📱 Compartir mis Estadísticas
        </button>`;

        cont.innerHTML = `
            <div class="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-700 flex items-center gap-4 animar-entrada">
                <span class="text-4xl">${avatar}</span>
                <div>
                    <h3 class="font-black text-gray-800 dark:text-white text-lg capitalize">${escHtml(nombre)}</h3>
                    <p class="text-xs text-gray-400">${escHtml(correo)}</p>
                </div>
            </div>
            <div class="grid grid-cols-2 gap-3 animar-entrada" style="animation-delay:0.1s">${htmlMetricas}</div>
            <div class="animar-entrada" style="animation-delay:0.15s">${htmlMejor}</div>
            <div class="animar-entrada" style="animation-delay:0.2s">${htmlLogros}</div>
            <div class="animar-entrada" style="animation-delay:0.25s">${htmlTodos}</div>
            <div class="animar-entrada" style="animation-delay:0.3s">${htmlCompartir}</div>
        `;

        // Cargar todos los logros (obtenidos y no)
        cargarTodosLogros(correo);

    } catch (e) {
        // Error capturado silenciosamente para no interrumpir la UI
        cont.innerHTML = `<div class="text-center py-20"><p class="text-gray-400 font-bold">No se pudieron cargar las estadísticas</p></div>`;
    }
}

async function cargarTodosLogros(correo) {
    const grid = document.getElementById('todos-logros-grid');
    if (!grid) return;
    try {
        const res = await fetch(`/api/logros/${correo}`);
        const d = await res.json();
        grid.innerHTML = d.todos.map(b => `
            <div class="flex items-center gap-3 p-3 rounded-xl transition-all ${b.obtenido 
                ? 'bg-primary-500/10 dark:bg-primary-500/20 border border-primary-200 dark:border-primary-500/30' 
                : 'bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 opacity-60'}">
                <span class="text-xl ${b.obtenido ? '' : 'grayscale opacity-40'}">${b.emoji}</span>
                <div class="flex-1 min-w-0">
                    <p class="text-xs font-black ${b.obtenido ? 'text-primary-700 dark:text-primary-300' : 'text-gray-500 dark:text-gray-400'}">${b.nombre}</p>
                    <p class="text-[9px] ${b.obtenido ? 'text-primary-600/70 dark:text-primary-400/70' : 'text-gray-400 dark:text-gray-500'} truncate">${b.descripcion}</p>
                </div>
                ${b.obtenido ? '<span class="text-green-500 text-sm font-black shrink-0">✅</span>' : '<span class="text-gray-400 dark:text-gray-600 text-xs font-bold shrink-0">🔒</span>'}
            </div>
        `).join('');
    } catch (e) { grid.innerHTML = '<p class="text-xs text-gray-400 italic">Error</p>'; }
}

async function compartirStats() {
    const cont = document.getElementById('contenedor-stats-personal');
    if (!cont) return;

    try {
        if (typeof html2canvas === 'undefined') {
            mostrarToast('⚠️ Cargando módulo de captura...');
            return;
        }

        mostrarToast('📸 Generando imagen...');
        const canvas = await html2canvas(cont, {
            backgroundColor: document.documentElement.classList.contains('dark') ? '#111827' : '#f3f4f6',
            scale: 2,
            useCORS: true,
            logging: false,
        });

        canvas.toBlob(async (blob) => {
            if (navigator.share && navigator.canShare) {
                const file = new File([blob], 'mis-stats-polla.png', { type: 'image/png' });
                try {
                    await navigator.share({
                        title: 'Mis Estadísticas - Polla Futbolera',
                        text: '¡Mira mis estadísticas en Polla Futbolera! ⚽🔥',
                        files: [file]
                    });
                } catch (e) {
                    downloadBlob(blob);
                }
            } else {
                downloadBlob(blob);
            }
        }, 'image/png');
    } catch (e) {
        mostrarToast('❌ Error al generar imagen');
    }
}

function downloadBlob(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mis-stats-polla.png';
    a.click();
    URL.revokeObjectURL(url);
    mostrarToast('✅ Imagen descargada');
}

// =============================================
// ONBOARDING / TUTORIAL
// =============================================
const ONBOARDING_STEPS = [
    {
        emoji: '👋',
        titulo: '¡Bienvenido a Polla Futbolera!',
        descripcion: 'La mejor plataforma para competir con tus amigos pronosticando resultados de fútbol. ¡Demuestra que eres el mejor!',
    },
    {
        emoji: '👥',
        titulo: 'Crea o Únete a un Grupo',
        descripcion: 'Empieza creando tu propio grupo y comparte el código con tus amigos. O únete a uno existente con un código de invitación.',
    },
    {
        emoji: '⚽',
        titulo: 'Pronostica los Marcadores',
        descripcion: 'Antes de cada partido, elige tu pronóstico. Acertar el marcador exacto te dará hasta 10 puntos. ¡Ojo! Los pronósticos se cierran al iniciar el partido.',
    },
    {
        emoji: '🏆',
        titulo: '¡Compite por el #1!',
        descripcion: 'Revisa el ranking de tu grupo y desbloquea logros como "Perfeccionista" 🎯 o "Hat-Trick" 🔥. ¡Buena suerte!',
    },
];

let _onboardingStep = 0;

function iniciarOnboarding() {
    if (localStorage.getItem('onboarding_completado')) return;
    _onboardingStep = 0;
    renderOnboardingStep();
    const overlay = document.getElementById('onboarding-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
    }
}

function renderOnboardingStep() {
    const cont = document.getElementById('onboarding-contenido');
    const step = ONBOARDING_STEPS[_onboardingStep];
    if (!cont || !step) return;

    cont.innerHTML = `
        <div class="text-center">
            <span class="text-6xl block mb-4 animate-bounce">${step.emoji}</span>
            <h3 class="font-black text-xl text-gray-800 dark:text-white mb-2">${step.titulo}</h3>
            <p class="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">${step.descripcion}</p>
        </div>
    `;

    // Actualizar dots
    for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
        const dot = document.getElementById(`dot-${i}`);
        if (dot) {
            dot.className = `w-2 h-2 rounded-full transition-colors ${i === _onboardingStep ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'}`;
        }
    }

    // Actualizar botón
    const btnNext = document.getElementById('onboarding-next');
    if (btnNext) {
        btnNext.textContent = _onboardingStep === ONBOARDING_STEPS.length - 1 ? '¡Empezar! 🚀' : 'Siguiente →';
    }
}

window.siguientePasoOnboarding = function() {
    _onboardingStep++;
    if (_onboardingStep >= ONBOARDING_STEPS.length) {
        cerrarOnboarding();
    } else {
        renderOnboardingStep();
    }
};

window.cerrarOnboarding = function() {
    localStorage.setItem('onboarding_completado', '1');
    const overlay = document.getElementById('onboarding-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
        overlay.classList.remove('flex');
    }
};

// Auto-start onboarding después de registro
window.checkOnboarding = function() {
    if (!localStorage.getItem('onboarding_completado') && localStorage.getItem('authToken')) {
        setTimeout(iniciarOnboarding, 500);
    }
};
