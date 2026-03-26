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

            // Colores aleatorios pero consistentes
            const r = (index * 137) % 255;
            const g = (index * 67) % 255;
            const b = (index * 211) % 255;

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
    } catch (e) { console.error("Error cargando gráfica:", e); }
}
