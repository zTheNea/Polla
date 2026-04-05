import httpx
import asyncio
import time

BASE_URL = "http://127.0.0.1:8000"

async def test_redundancy():
    print("Iniciando prueba de redundancia...")
    
    # 1. Simular múltiples peticiones simultáneas a partidos
    print("\n[TEST 1] Peticiones concurrentes a /api/partidos/champions")
    async with httpx.AsyncClient() as client:
        start = time.time()
        tasks = [client.get(f"{BASE_URL}/api/partidos/champions") for _ in range(5)]
        responses = await asyncio.gather(*tasks)
        end = time.time()
        print(f"5 peticiones completadas en {end - start:.2f}s")
        # Aquí veríamos en los logs del servidor si hubo 1 o 5 llamados a ESPN

    # 2. Simular carga de ranking repetitiva
    print("\n[TEST 2] Peticiones repetitivas a /api/posiciones/1")
    async with httpx.AsyncClient() as client:
        for i in range(3):
            start = time.time()
            # Necesitaríamos un token real para esto, pero el servidor igual procesará hasta el error de auth
            # o podemos probar una ruta pública si existiera.
            # Como no tenemos token, esto fallará con 401, pero sirve para ver la intención.
            await client.get(f"{BASE_URL}/api/posiciones/1")
            print(f"Petición ranking {i+1} enviada")

if __name__ == "__main__":
    # Nota: Requiere que el servidor esté corriendo
    asyncio.run(test_redundancy())
