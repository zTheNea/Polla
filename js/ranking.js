// ==========================================
// ranking.js - Módulo de la Tabla de Posiciones
// ==========================================

window.verTablaPosiciones = async function () {
    const elPrev = document.getElementById('m-pos');
    if (elPrev) elPrev.remove();

    const gid = localStorage.getItem('grupoActivoId');
    try {
        const respuesta = await fetch(`/api/posiciones/${gid}`);
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
};
