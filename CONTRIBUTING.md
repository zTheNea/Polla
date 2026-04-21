# 🤝 Guía de Contribución

¡Gracias por tu interés en contribuir a **Polla Futbolera**! Este documento describe el flujo de trabajo y las convenciones del proyecto.

---

## 📋 Antes de Empezar

1. **Lee el [README.md](README.md)** para entender la arquitectura del proyecto.
2. **Revisa los [Issues](https://github.com/tu-usuario/PollaFutbolera/issues)** existentes antes de crear uno nuevo.
3. Asegúrate de tener el entorno configurado siguiendo la [Guía de Instalación](GUIA_INSTALACION.md).

---

## 🔄 Flujo de Trabajo

1. **Fork** el repositorio.
2. Crea una rama descriptiva:
   ```bash
   git checkout -b feature/nueva-funcionalidad
   git checkout -b fix/corregir-bug
   ```
3. Haz tus cambios siguiendo las convenciones del proyecto.
4. Ejecuta los tests:
   ```bash
   pytest test_main.py -v
   ```
5. Haz commit con mensajes claros:
   ```bash
   git commit -m "feat: agregar notificaciones push para goles en vivo"
   git commit -m "fix: corregir cálculo de puntos en pronóstico exacto"
   ```
6. Push a tu fork y abre un **Pull Request**.

---

## 📝 Convenciones de Código

### Python (Backend)
- Seguir **PEP 8**.
- Documentar funciones con docstrings.
- Usar `async/await` para operaciones I/O.

### JavaScript (Frontend)
- Funciones en **camelCase**.
- Sanitizar siempre entradas del usuario con `escHtml()` o `escJs()`.
- No usar dependencias externas — el frontend es vanilla JS.

### Commits
Usar el formato [Conventional Commits](https://www.conventionalcommits.org/):

| Prefijo | Uso |
|---|---|
| `feat:` | Nueva funcionalidad |
| `fix:` | Corrección de bug |
| `docs:` | Documentación |
| `refactor:` | Refactorización sin cambio funcional |
| `test:` | Tests nuevos o actualizados |
| `chore:` | Mantenimiento, configs, etc. |

---

## 🧪 Tests

Antes de enviar un PR, asegúrate de que **todos los tests pasen**:

```bash
pytest test_main.py -v
```

Si tu cambio agrega funcionalidad nueva, incluye tests correspondientes en `test_main.py`.

---

## 🔐 Seguridad

- **NUNCA** incluir contraseñas, tokens o secretos en el código.
- Usar variables de entorno para toda configuración sensible.
- Sanitizar TODA entrada del usuario antes de mostrarla en el DOM.

---

## 📜 Licencia

Al contribuir, aceptas que tu código se publique bajo la [Licencia MIT](LICENSE) del proyecto.
