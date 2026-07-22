async def test_health(client):
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"detail": "ok"}


async def test_ready(client):
    response = await client.get("/ready")
    assert response.status_code == 200
    assert response.json() == {"detail": "ready"}
