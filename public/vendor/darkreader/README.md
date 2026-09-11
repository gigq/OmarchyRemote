Dark Reader 4.9.130, vendored from the npm darkreader package.
Upstream: https://github.com/darkreader/darkreader
License: MIT (see LICENSE).

Used only by the native Browser appearance script in an isolated WKContentWorld.
No host bridges are exposed to website content. Fetches use normal WebKit fetch
permissions; cross-origin stylesheets and embedded frames may remain unmodified.
To update: npm pack darkreader@<version>, copy package/darkreader.js and LICENSE.

The upstream CRLF line endings are normalized to LF.
