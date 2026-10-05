# Third-party notices

What this editor ships that others wrote, and what it only uses to be built and tested.

```mermaid
flowchart LR
    SRC["src/ (MIT, ours)"] --> DIST["dist/ (what ships)"]
    DV["dockview-core 8.4.0 (MIT)"] --> DIST
    PSD["ag-psd 31.0.2 (MIT)<br/>+ base64-js · pako"] --> DIST
    FONTS["public/vendor/fonts<br/>Inter · JetBrains Mono (OFL)"] --> DIST
    DEV["dev tools: TypeScript, Vite, Vitest<br/>spine-core (test oracle)"] -.->|"build and test only"| DIST
```

## Shipped

Each library or asset that reaches `dist/` has a row here, with its licence, before it lands.

| What | Version | Licence | Where | Use |
|---|---|---|---|---|
| [dockview-core](https://github.com/dockview/dockview) | 8.4.0 (exact) | MIT | npm dependency, bundled; licence `public/vendor/LICENCE-dockview-core.md` | panels and docking (D6); no dependencies of its own |
| [ag-psd](https://github.com/Agamnentzar/ag-psd) | 31.0.2 (exact) | MIT | npm dependency, bundled; licence `public/vendor/LICENCE-ag-psd.txt` | reading Photoshop files (PSD import, D7) |
| [base64-js](https://github.com/beatgammit/base64-js) | 1.5.1 | MIT | dependency of ag-psd, bundled; licence `public/vendor/LICENCE-base64-js.txt` | ag-psd's base64 |
| [pako](https://github.com/nodeca/pako) | 2.1.0 | MIT and Zlib | dependency of ag-psd, bundled; licence `public/vendor/LICENCE-pako.txt` | ag-psd's zip decompression |
| [Inter](https://github.com/rsms/inter), variable, latin | from @fontsource-variable/inter 5.3.0 | SIL OFL 1.1 | `public/vendor/fonts/inter-latin-wght-normal.woff2`, licence `OFL-Inter.txt` beside it | interface text |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), variable, latin | from @fontsource-variable/jetbrains-mono 5.3.0 | SIL OFL 1.1 | `public/vendor/fonts/jetbrains-mono-latin-wght-normal.woff2`, licence `OFL-JetBrainsMono.txt` beside it | numbers and values |

The fonts are copied unmodified from the Fontsource packages (not installed as packages, so the
npm runtime dependencies stay dockview-core and ag-psd, D6 and D7); OFL reserves their names, so they are never
modified or renamed inside.

## Build and test only (not in `dist/`)

| Package | Licence | Use |
|---|---|---|
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | type checking |
| [Vite](https://vite.dev) | MIT | dev server and build |
| [Vitest](https://vitest.dev) | MIT | tests |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Node types for the tests and the Vite config |
| [@esotericsoftware/spine-core](https://github.com/EsotericSoftware/spine-runtimes) 4.3.13 | Spine Runtimes License | the engine's test oracle (`tests/engineOracle.test.ts`) only; `scripts/check.sh` fails if `src/` imports it or `dist/` carries it |
