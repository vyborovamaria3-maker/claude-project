# Provider adapters

All external intelligence sources must implement the same contract.

Required methods:

- `collect(query)`
- `health()`
- `normalize(item)`

Providers must:

- never expose credentials;
- return normalized evidence;
- support failure reporting;
- provide source metadata.

Initial adapters:

- web
- github
- youtube
- rss
