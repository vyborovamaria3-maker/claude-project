# Output Templates

## Markdown table

```text
| token | mint | chain | price | liquidity | volume | holders | age | risk |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| ... | ... | ... | ... | ... | ... | ... | ... | ... |
```

## JSON

```json
{
  "source": "gmgn",
  "scope": "analysis",
  "generatedAt": "2026-07-07T00:00:00Z",
  "rows": [
    {
      "token": "example",
      "mint": "exampleMint",
      "chain": "sol",
      "price": 0,
      "liquidity": 0,
      "volume": 0,
      "holders": 0,
      "age": "0m",
      "risk": "low"
    }
  ]
}
```

