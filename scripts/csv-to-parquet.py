from __future__ import annotations

import argparse
from pathlib import Path

import pyarrow as pa
import pyarrow.csv as csv
import pyarrow.parquet as pq


SCHEMAS = {
    "daily": pa.schema(
        [
            ("code", pa.string()),
            ("trading_date", pa.string()),
            ("open", pa.int64()),
            ("high", pa.int64()),
            ("low", pa.int64()),
            ("close", pa.int64()),
            ("volume", pa.int64()),
            ("amount", pa.int64()),
        ]
    ),
    "minute": pa.schema(
        [
            ("code", pa.string()),
            ("bar_timestamp", pa.string()),
            ("trading_date", pa.string()),
            ("open", pa.int64()),
            ("high", pa.int64()),
            ("low", pa.int64()),
            ("close", pa.int64()),
            ("volume", pa.int64()),
            ("amount", pa.int64()),
        ]
    ),
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert market-data staging CSV to Parquet.")
    parser.add_argument("--dataset", choices=sorted(SCHEMAS), required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    source = Path(args.input)
    target = Path(args.output)
    if not source.is_file():
        raise SystemExit(f"input CSV does not exist: {source}")

    schema = SCHEMAS[args.dataset]
    table = csv.read_csv(
        source,
        convert_options=csv.ConvertOptions(column_types={field.name: field.type for field in schema}),
    )
    if table.schema != schema:
        table = table.cast(schema)

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    pq.write_table(table, temporary, compression="zstd")
    temporary.replace(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
