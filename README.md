# ⚽ Polla Futbolera v2.2 - Plataforma de Pronósticos Deportivos

¡Bienvenido a la **Polla Futbolera**, la plataforma definitiva para organizar grupos de apuestas deportivas con amigos, familiares o colegas! Esta versión **v2.2** incluye un sistema de tematización dinámica "Prisma", notificaciones nativas y chat en vivo.

![Vista Previa](https://via.placeholder.com/800x400?text=Polla+Futbolera+v2.2)

## ✨ Características Principales

- **🎨 Sistema Prisma (Tematización Dinámica)**: Personaliza la interfaz con cualquier color. El sistema generará automáticamente una paleta de Tailwind y colores de contraste para una legibilidad perfecta.
- **🔔 Área de Notificación Avanzada**: Notificaciones dentro de la app (toasts) y soporte para notificaciones nativas del navegador.
- **💬 Chat en Vivo**: Comunícate con los miembros de tu grupo en tiempo real.
- **📊 Estadísticas Detalladas**: Datos en tiempo real de partidos (vía ESPN), probabilidades de victoria y cronología de eventos.
- **🌓 Modo Oscuro/Claro**: Soporte nativo para temas según la preferencia del sistema.
- **📱 PWA Ready**: Instalable en dispositivos móviles como una aplicación nativa.

## 🚀 Instalación Rápida

### Requisitos Previos
- Python 3.9+
- Pip (Gestor de paquetes de Python)

### Pasos
1. **Clonar el repositorio**:
   ```bash
   git clone https://github.com/zTheNea/Polla.git
   cd Polla
   ```

2. **Crear entorno virtual**:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # En Windows: .venv\Scripts\activate
   ```

3. **Instalar dependencias**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Ejecutar la aplicación**:
   ```bash
   python main.py
   ```
   La aplicación estará disponible en `http://localhost:8000`.

## 🛠️ Tecnologías Utilizadas

- **Backend**: FastAPI (Python), SQLite3.
- **Frontend**: HTML5, Vanilla JavaScript, Tailwind CSS (CDN).
- **Seguridad**: Autenticación HMAC y encriptación de contraseñas con Passlib (Bcrypt).
- **Datos**: Proxy de ESPN para resultados y estadísticas en vivo.

## 🛡️ Seguridad y Configuración

Para producción, se recomienda configurar la variable de entorno `POLLA_SECRET` para firmar los tokens de sesión:

```bash
export POLLA_SECRET="tu_clave_secreta_aqui"
```

---
Desarrollado con ❤️ para los amantes del fútbol.
