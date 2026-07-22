from prometheus_fastapi_instrumentator import Instrumentator


def instrument_app(app) -> None:
    Instrumentator().instrument(app).expose(app, include_in_schema=False, should_gzip=True)
