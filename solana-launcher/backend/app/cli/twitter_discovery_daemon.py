from __future__ import annotations

import argparse
import asyncio
import logging
import signal

from app.cli.twitter_discovery_cycle import (
    build_parser as build_cycle_parser,
    run_configured as run_cycle_configured,
)
from app.cli.twitter_discovery_public import (
    build_parser as build_public_parser,
    run_configured as run_public_configured,
)

logger = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Continuously run configured Twitter/X discovery collectors."
    )
    parser.add_argument("--public-interval", type=int, default=900)
    parser.add_argument("--cycle-interval", type=int, default=1800)
    parser.add_argument("--initial-delay", type=int, default=5)
    return parser


async def _run_public_once() -> None:
    args = build_public_parser().parse_args([])
    await run_public_configured(args, [])


async def _run_cycle_once() -> None:
    args = build_cycle_parser().parse_args([])
    await run_cycle_configured(args, [])


async def run_forever(args: argparse.Namespace) -> None:
    public_interval = max(60, int(args.public_interval))
    cycle_interval = max(60, int(args.cycle_interval))
    initial_delay = max(0, int(args.initial_delay))
    if initial_delay:
        await asyncio.sleep(initial_delay)

    loop = asyncio.get_running_loop()
    next_public = loop.time()
    next_cycle = loop.time()

    while True:
        now = loop.time()
        if now >= next_public:
            try:
                await _run_public_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Configured public Twitter discovery run failed")
            next_public = loop.time() + public_interval

        now = loop.time()
        if now >= next_cycle:
            try:
                await _run_cycle_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Configured Twitter discovery cycle failed")
            next_cycle = loop.time() + cycle_interval

        sleep_for = max(1.0, min(next_public, next_cycle) - loop.time())
        await asyncio.sleep(sleep_for)


async def _main(args: argparse.Namespace) -> None:
    current_task = asyncio.current_task()
    loop = asyncio.get_running_loop()

    def cancel_current_task() -> None:
        if current_task is not None and not current_task.done():
            current_task.cancel()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, cancel_current_task)
        except (NotImplementedError, RuntimeError):
            pass

    try:
        await run_forever(args)
    except asyncio.CancelledError:
        logger.info("Twitter discovery daemon stopped")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(_main(build_parser().parse_args()))


if __name__ == "__main__":
    main()
