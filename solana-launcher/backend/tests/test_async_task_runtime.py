import asyncio

from app.tasks.async_runtime import close_async_runtime, run_async_task


def test_consecutive_tasks_can_reuse_loop_bound_connections():
    async def connect():
        loop = asyncio.get_running_loop()
        return loop, loop.create_future()

    async def reuse(loop, pending):
        assert asyncio.get_running_loop() is loop
        loop.call_soon(pending.set_result, "ok")
        return await pending

    try:
        loop, pending = run_async_task(connect())
        assert run_async_task(reuse(loop, pending)) == "ok"
    finally:
        close_async_runtime()
    assert loop.is_closed()
