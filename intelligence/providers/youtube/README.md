# YouTube Intelligence Provider

Backend: `yt-dlp`.

## Runtime requirement

The intelligence worker image/host must provide a `yt-dlp` executable on `PATH`, or construct `YouTubeClient(executable=...)` with an explicit trusted executable path.

The provider does not invoke a shell. Every `yt-dlp` call uses an argument list with `shell=False` and a timeout.

## Accepted input

Only public URLs on these hosts are accepted:

- `youtube.com`
- `www.youtube.com`
- `m.youtube.com`
- `music.youtube.com`
- `youtu.be`

Credentials embedded in URLs and non-HTTP(S) schemes are rejected by the shared URL security policy.

## Collection

The provider requests:

- single-video metadata;
- no playlist expansion;
- no media download;
- optional manual/automatic VTT subtitles in configured languages.

Subtitle files live only in a temporary directory and are removed after collection.

## Safety limits

- subprocess timeout is configurable and must be positive;
- metadata and subtitle size are capped;
- canonical `webpage_url` returned by `yt-dlp` is revalidated;
- title, description, channel information and transcript are sanitized before storage;
- raw stderr/provider failures are not exposed through health responses.

## Tests

Unit tests use a fake client and do not require network access or an installed `yt-dlp` binary. A separate deployment smoke test should verify the real binary in the isolated intelligence-worker environment.
