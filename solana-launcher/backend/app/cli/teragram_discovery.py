from __future__ import annotations


import argparse
import json


from app.services.teragram_graph_discovery import discover_teragram_graph




def main() -> None:
    parser = argparse.ArgumentParser(
        description="Expand TeraGram candidates through historical Telegram graph signals."
    )


    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--candidates", required=True)
    parser.add_argument(
        "--output",
        default="data/teragram_graph/discovery.json",
    )
    parser.add_argument(
        "--min-audience-overlap",
        type=int,
        default=2,
    )
    parser.add_argument(
        "--max-results",
        type=int,
        default=500,
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=4,
    )
    parser.add_argument(
        "--memory-limit",
        default="4GB",
    )


    args = parser.parse_args()


    result = discover_teragram_graph(
        input_dir=args.input_dir,
        candidate_path=args.candidates,
        output_path=args.output,
        min_audience_overlap=args.min_audience_overlap,
        max_results=args.max_results,
        threads=args.threads,
        memory_limit=args.memory_limit,
    )


    print(
        json.dumps(
            {
                "root_candidate_count": result["root_candidate_count"],
                "candidate_count": result["candidate_count"],
                "output": args.output,
            },
            ensure_ascii=False,
            indent=2,
        )
    )




if __name__ == "__main__":
    main()
